// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Mèo Béo's runs: one Claude Agent SDK query per stretch of work, driven from
 * the console's server process. The query reads its prompt from a queue, so the
 * operator can keep talking while the agent works, as in Claude Code: a message
 * sent mid-run is handed to the session and folded in at its next step, and the
 * run ends once a turn finishes with nothing left to answer.
 *
 * A run is owned here, not by the request that started it: closing the panel or
 * reloading the page leaves it going, and the stream route re-attaches by
 * replaying the run's events so far. What the agent can touch is decided by two
 * settings below and nothing else:
 *
 * - `tools: []` removes every built-in Claude Code tool (shell, file edits, web
 *   fetches), so the only tools are luna's, reached over `/api/mcp` with a
 *   per-run bearer (`bearer.ts`). The agent token's scope is therefore the whole
 *   of its reach, checked on every call by the endpoint.
 * - In Auto, every tool not marked destructive (and the agent's own memory) runs unasked;
 *   every other call waits in `canUseTool` until the operator who owns the
 *   conversation approves or denies it in the panel.
 *
 * The subprocess runs with its own HOME and CLAUDE_CONFIG_DIR under the cluster
 * root, so it never reads or writes the ~/.claude of whoever runs the console.
 */

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { CanUseTool, PermissionResult, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import {
	AGENT_EFFORTS,
	AGENT_MODEL_PATTERN,
	agentLaunch,
	appendAgentTurn,
	getAgentConversation,
	recordAgentModels
} from '$core/agent';
import type { AgentEffort, AgentEntry, AgentLaunch } from '$core/agent';
import { AGENT_ASK_TOOL, AGENT_NAVIGATE_TOOL, AGENT_SCREENSHOT_TOOL, AGENT_TASK_TOOLS, agentCanAsk, isConsolePath } from '$shared/agent';
import type { AgentMode } from '$shared/agent';
import { runsUnasked } from './approval';
import {
	cancelTask,
	cancelTrigger,
	createTrigger,
	INSTANCE_STATES,
	listTasks,
	listTriggers,
	MAX_TRIGGER_FIRES,
	MAX_TRIGGER_MINUTES,
	setNoticeDeliverer,
	startTask,
	TRIGGER_KINDS
} from './background';
import type { AgentNotice, DeliveryContext, TriggerSpec } from './background';
import { issueRunBearer } from './bearer';
import { findClaudeExecutable } from './executable';
import { personaPrompt } from './persona';
import { INSTANCE_TABS } from '$lib/components/instancetabs';

/** The name luna's MCP server is registered under; the SDK prefixes its tools with it. */
const SERVER = 'luna';
const TOOL_PREFIX = `mcp__${SERVER}__`;

/** The in-process server carrying the tools only the operator's browser can answer. */
const CONSOLE_SERVER = 'console';
const SCREENSHOT_SDK_NAME = `mcp__${CONSOLE_SERVER}__screenshot`;
const NAVIGATE_SDK_NAME = `mcp__${CONSOLE_SERVER}__navigate`;

/** The SDK names of the console's own tools, by the name the panel and the transcript use. */
const SCREEN_SDK_NAMES: Record<string, string> = {
	[SCREENSHOT_SDK_NAME]: AGENT_SCREENSHOT_TOOL,
	[NAVIGATE_SDK_NAME]: AGENT_NAVIGATE_TOOL,
	...Object.fromEntries(AGENT_TASK_TOOLS.map((name) => [`mcp__${CONSOLE_SERVER}__${name}`, name]))
};

/** How long a request to the panel waits for it to answer. */
const PANEL_TIMEOUT_MS = 30_000;

/** The largest screenshot a panel may upload. */
export const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

/** How long a call waits for the operator before it is denied for them. */
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

/** How long a finished run's events stay replayable for a panel that reconnects late. */
const LINGER_MS = 15_000;

/** Longest single tool call; lifecycle tools wait up to three minutes for a server to settle. */
const TOOL_TIMEOUT_MS = 4 * 60 * 1000;

/** What the panel receives over the stream. */
export type AgentEvent =
	| { type: 'state'; running: boolean }
	| {
		type: 'user';
		text: string;
		author: string;
		at: number;
		mode: AgentMode;
		attachments?: Array<{ name: string; size: number }>;
	}
	| { type: 'text'; delta: string }
	| { type: 'assistant'; text: string }
	| {
		type: 'tool';
		id: string;
		name: string;
		input?: unknown;
		status: 'running' | 'awaiting' | 'ok' | 'error' | 'denied';
		output?: string;
		decidedBy?: string;
	}
	| { type: 'screenshot'; id: string }
	| { type: 'navigate'; id: string; path: string }
	| { type: 'error'; text: string; code?: AgentErrorCode }
	| { type: 'event'; source: 'task' | 'trigger'; label: string; text: string; at: number }
	| { type: 'done'; costUsd: number };

/** Failures the panel words itself, in the operator's language; anything else shows its text. */
export type AgentErrorCode =
	| 'stopped'
	| 'maxTurns'
	| 'toolsUnavailable'
	| 'busy'
	| 'noExecutable'
	| 'bypassOff'
	| 'badModel';

/** A refusal to start, carrying a code the panel can translate. */
export class AgentRunError extends Error {
	constructor(
		readonly code: AgentErrorCode,
		message: string
	) {
		super(message);
	}
}

type Listener = (event: AgentEvent) => void;

/** The operator's picks for an `AskUserQuestion` call, keyed by question text, as the SDK reads them. */
export type AgentAnswers = Record<string, string>;

interface Pending {
	resolve: (allow: boolean, by: string, answers?: AgentAnswers) => void;
}

/**
 * A run's prompt as the SDK reads it: an iterable the operator can keep adding
 * to while the agent works. Closing it is what lets the query end; a message
 * that arrives after that is refused here and starts the next run instead.
 */
class InputQueue implements AsyncIterable<SDKUserMessage> {
	#items: SDKUserMessage[] = [];
	#waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
	#closed = false;

	/** Messages handed over but not yet read by the SDK */
	get buffered(): number {
		return this.#items.length;
	}

	push(message: SDKUserMessage): boolean {
		if (this.#closed) {
			return false;
		}

		const waiting = this.#waiting;

		if (waiting) {
			this.#waiting = null;
			waiting({ done: false, value: message });
		} else {
			this.#items.push(message);
		}

		return true;
	}

	close(): void {
		this.#closed = true;

		const waiting = this.#waiting;

		if (waiting) {
			this.#waiting = null;
			waiting({ done: true, value: undefined });
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
		return {
			next: (): Promise<IteratorResult<SDKUserMessage>> => {
				const item = this.#items.shift();

				if (item) {
					return Promise.resolve({ done: false, value: item });
				}

				if (this.#closed) {
					return Promise.resolve({ done: true, value: undefined });
				}

				return new Promise((resolve) => {
					this.#waiting = resolve;
				});
			}
		};
	}
}

/** What the operator may change on a run while it goes. */
export interface RunSettings {
	mode?: AgentMode;
	model?: string;
	effort?: string;
}

function stripPrefix(name: string): string {
	const screen = SCREEN_SDK_NAMES[name];

	if (screen) {
		return screen;
	}

	return name.startsWith(TOOL_PREFIX)
		? name.slice(TOOL_PREFIX.length)
		: name;
}

/** Where the panel ended up after a navigate request. */
export interface Navigated {
	ok: boolean;
	page: string;
	error?: string;
}

/** A screenshot the panel delivered. */
export interface Screenshot {
	bytes: Uint8Array;
	mime: string;
	page: string;
	width: number;
	height: number;
}

function resultText(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}

	if (!Array.isArray(content)) {
		return '';
	}

	return content
		.map((part) => (typeof part === 'object' && part !== null && 'text' in part ? String(part.text) : ''))
		.join('\n');
}

/** Variables the console passes through when it has them: a gateway or proxy in front of the API. */
const PASSTHROUGH = ['ANTHROPIC_BASE_URL', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'];

/**
 * The subprocess's whole environment. Nothing else of the console's is passed,
 * since the console's own environment can carry the cluster token.
 */
function subprocessEnv(launch: AgentLaunch): Record<string, string> {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
		HOME: launch.home,
		CLAUDE_CONFIG_DIR: launch.home,
		LANG: process.env.LANG ?? 'C.UTF-8',
		CLAUDE_AGENT_SDK_CLIENT_APP: 'luna-console',
		DISABLE_AUTOUPDATER: '1'
	};

	for (const name of PASSTHROUGH) {
		const value = process.env[name];

		if (value) {
			env[name] = value;
		}
	}

	return { ...env, ...launch.env };
}

class Run {
	/** Where a background task or trigger set up during this run reports back */
	context: Omit<DeliveryContext, 'mode'> | null = null;
	readonly events: AgentEvent[] = [];
	readonly listeners = new Set<Listener>();
	readonly pending = new Map<string, Pending>();
	readonly abort = new AbortController();

	/** Entries written to the transcript when the run ends */
	readonly entries: AgentEntry[] = [];

	/** Tool calls by id, so a result can be filed against its call */
	readonly calls = new Map<string, { name: string; input: unknown; decidedBy?: string; denied?: boolean }>();

	running = true;

	/** Set once the last turn finished with nothing queued; a later message starts a new run */
	closing = false;

	/** The prompt queue the query reads from */
	readonly input = new InputQueue();

	/** The live query, once started; model and effort changes go through it */
	query: Query | null = null;

	/** The approval mode in force now; `canUseTool` reads it on every call */
	mode: AgentMode;

	/** The mode the persona was written for; a message sent after a switch says so */
	readonly startMode: AgentMode;

	model: string;
	effort: string;

	/** Settles when the run has saved its transcript and stopped */
	readonly finished: Promise<void>;

	#settle: () => void = () => {};

	constructor(
		readonly conversationId: string,
		readonly owner: string,
		settings: { mode: AgentMode; model: string; effort: string }
	) {
		this.mode = settings.mode;
		this.startMode = settings.mode;
		this.model = settings.model;
		this.effort = settings.effort;
		this.finished = new Promise((resolve) => {
			this.#settle = resolve;
		});
	}

	/** Mark the run over; whoever waits on `finished` may start the next one. */
	settle(): void {
		this.#settle();
	}

	emit(event: AgentEvent): void {
		this.events.push(event);

		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// a listener whose stream closed mid-write is dropped by its own cancel
			}
		}
	}

	decide(toolUseId: string, allow: boolean, by: string, answers?: AgentAnswers): boolean {
		const pending = this.pending.get(toolUseId);

		if (!pending) {
			return false;
		}

		this.pending.delete(toolUseId);
		pending.resolve(allow, by, answers);

		return true;
	}

	/** Requests waiting on the panel (a screenshot, a navigation), by request id */
	readonly asks = new Map<string, (answer: unknown) => void>();

	/**
	 * Ask the browser following this run to do something and wait for its
	 * answer. The request is an event like any other, so whichever of the
	 * owner's tabs is following the run handles it, and the first answer wins.
	 * It is dropped from the replay buffer once settled, so a panel that
	 * reconnects later does not act on it again.
	 */
	async askPanel<T>(build: (id: string) => AgentEvent, what: string): Promise<T> {
		if (this.listeners.size === 0) {
			throw new Error(`the operator does not have the console open, so there is no screen to ${what}`);
		}

		const id = crypto.randomUUID();
		const event = build(id);

		this.emit(event);

		try {
			return await new Promise<T>((resolve, reject) => {
				const timer = setTimeout(() => {
					reject(new Error(`the console did not answer in time (asked to ${what})`));
				}, PANEL_TIMEOUT_MS);

				this.asks.set(id, (answer) => {
					clearTimeout(timer);
					resolve(answer as T);
				});
			});
		} finally {
			this.asks.delete(id);

			const index = this.events.indexOf(event);

			if (index >= 0) {
				this.events.splice(index, 1);
			}
		}
	}

	stop(by: string): void {
		for (const id of [...this.pending.keys()]) {
			this.decide(id, false, by);
		}

		this.closing = true;
		this.input.close();
		this.abort.abort();
	}
}

const runs = new Map<string, Run>();

export interface StartRunInput {
	conversationId: string;
	owner: string;
	text: string;
	/** The console's UI language */
	locale: string;
	/** Where this console answers on loopback, for the subprocess to reach `/api/mcp` */
	origin: string;
	machine: string;
	mode: AgentMode;
	/** Overrides the settings' model for this message */
	model?: string;
	effort?: string;
	/** The console page the operator is looking at, when they chose to share it */
	page?: string;
	/** Files staged in `uploads.ts` that the message refers to */
	attachments?: Array<{ id: string; name: string; size: number }>;
	/** Set when no person sent this: a background task or a trigger reporting back */
	event?: { source: 'task' | 'trigger'; label: string };
}

/** Refuse settings the run could not honour, before anything is saved or sent. */
function checkSettings(launch: AgentLaunch, change: RunSettings): void {
	if (change.mode === 'bypass' && !launch.settings.bypassAllowed) {
		throw new AgentRunError('bypassOff', 'Bypass mode is switched off in the agent settings');
	}

	if (change.model && !AGENT_MODEL_PATTERN.test(change.model)) {
		throw new AgentRunError('badModel', `Not a model id: ${change.model}`);
	}

	if (change.effort && !(AGENT_EFFORTS as readonly string[]).includes(change.effort)) {
		throw new AgentRunError('badModel', `Unknown effort level: ${change.effort}`);
	}
}

/**
 * Send a message to Mèo Béo. With no run going it starts one, resolving once
 * the run is under way (the message saved, the subprocess launching). With one
 * going, the message joins it: the session takes it at its next step, as Claude
 * Code does with a message typed mid-answer. The answer arrives on the stream.
 * Resolves true when the message joined a run already going, which the stream
 * echoes; a run's first message is not echoed, since the sender shows it.
 */
export async function startRun(input: StartRunInput): Promise<boolean> {
	const conversation = await getAgentConversation(input.conversationId, input.owner);

	if (!conversation) {
		throw new Error(`No conversation ${input.conversationId}`);
	}

	const launch = await agentLaunch(input.owner);

	checkSettings(launch, input);

	const live = runs.get(input.conversationId);

	if (live?.running && live.owner !== input.owner) {
		throw new AgentRunError('busy', 'Mèo Béo is still answering the last message');
	}

	if (live?.running && !live.closing) {
		if (await joinRun(live, input)) {
			return true;
		}
	}

	// a run winding down still owns the session; the next one resumes it once it is saved
	if (live?.running) {
		await live.finished;

		return await startRun(input);
	}

	const executable = findClaudeExecutable(launch.settings.executable);

	if (executable.source === 'none') {
		throw new AgentRunError('noExecutable', 'No Claude Code executable found on this machine; set its path in the agent settings');
	}

	const run = new Run(input.conversationId, input.owner, {
		mode: input.mode,
		model: input.model || launch.settings.model,
		effort: input.effort || launch.settings.effort
	});

	runs.set(input.conversationId, run);
	run.context = {
		conversationId: input.conversationId,
		owner: input.owner,
		origin: input.origin,
		machine: input.machine,
		locale: input.locale
	};

	// a notice is nobody's words: it is filed as an event, and never names the chat
	await appendAgentTurn(input.conversationId, input.owner, input.event
		? { entries: [eventEntry(input)] }
		: {
			entries: [{
				kind: 'user',
				at: Date.now(),
				author: input.owner,
				text: input.text,
				mode: input.mode,
				model: run.model,
				...(input.attachments?.length
					? { attachments: input.attachments.map(({ name, size }) => ({ name, size })) }
					: {})
			}],
			title: input.text
		});

	if (input.event) {
		run.emit(eventFrame(input));
	}

	run.input.push(userMessage(promptFor(input, run)));
	run.emit({ type: 'state', running: true });
	announceRunStart(input.conversationId, input.owner);

	void drive(run, input, launch, executable.path, conversation.sessionId);

	return false;
}

/**
 * Hand a message to a run already going. The settings it was sent with apply
 * from here on, it is filed in the transcript between what came before and
 * after it, and every window following the run shows it. False when the run
 * closed its queue in the meantime, so the caller starts a new one.
 */
async function joinRun(run: Run, input: StartRunInput): Promise<boolean> {
	await applyRunSettings(run, input);

	const at = Date.now();
	const attachments = input.attachments?.length
		? input.attachments.map(({ name, size }) => ({ name, size }))
		: undefined;

	if (!run.input.push(userMessage(promptFor(input, run)))) {
		return false;
	}

	if (input.event) {
		run.entries.push(eventEntry(input));
		run.emit(eventFrame(input));

		return true;
	}

	run.entries.push({
		kind: 'user',
		at,
		author: input.owner,
		text: input.text,
		mode: run.mode,
		model: run.model,
		...(attachments ? { attachments } : {})
	});
	run.emit({
		type: 'user',
		text: input.text,
		author: input.owner,
		at,
		mode: run.mode,
		...(attachments ? { attachments } : {})
	});

	return true;
}

/** Bring a live run in line with what the operator picked; the query is told about model and effort. */
async function applyRunSettings(run: Run, change: RunSettings): Promise<void> {
	if (change.mode && change.mode !== run.mode) {
		run.mode = change.mode;
	}

	if (change.model && change.model !== run.model) {
		await run.query?.setModel(change.model);
		run.model = change.model;
	}

	if (change.effort && change.effort !== run.effort) {
		await run.query?.applyFlagSettings({ effortLevel: change.effort as AgentEffort });
		run.effort = change.effort;
	}
}

/**
 * Change the mode, model or effort of a run while it goes. The mode applies
 * from the next tool call, the model and effort from the next response. False
 * when the conversation has no run to change.
 */
export async function updateRun(conversationId: string, owner: string, change: RunSettings): Promise<boolean> {
	const run = runs.get(conversationId);

	if (!run || run.owner !== owner || !run.running || run.closing) {
		return false;
	}

	checkSettings(await agentLaunch(owner), change);
	await applyRunSettings(run, change);

	return true;
}

/** A notice as the transcript files it. */
function eventEntry(input: StartRunInput): AgentEntry {
	return { kind: 'event', at: Date.now(), source: input.event!.source, label: input.event!.label, text: input.text };
}

function eventFrame(input: StartRunInput): AgentEvent {
	return { type: 'event', source: input.event!.source, label: input.event!.label, text: input.text, at: Date.now() };
}

/**
 * Report a finished background task or a fired trigger into its conversation:
 * into the run going there, or as the start of a new one. It runs in the mode
 * the conversation was last in, so an Auto conversation keeps working on its
 * own and a Plan one still only plans.
 */
async function deliverNotice(notice: AgentNotice): Promise<void> {
	await startRun({
		conversationId: notice.ctx.conversationId,
		owner: notice.ctx.owner,
		text: notice.text,
		locale: notice.ctx.locale,
		origin: notice.ctx.origin,
		machine: notice.ctx.machine,
		mode: runs.get(notice.ctx.conversationId)?.mode ?? notice.ctx.mode,
		event: { source: notice.source, label: notice.label }
	});
}

setNoticeDeliverer(deliverNotice);

/**
 * The words the model receives: the operator's text, then the notes riding
 * along with it. The page is a hint about what "this" means, attached to the
 * message rather than the persona so a resumed session keeps it next to the
 * words it explains; the mode note appears only once it differs from the one
 * the persona described.
 */
function promptFor(input: StartRunInput, run: Run): string {
	if (input.event) {
		return `<luna-event source="${input.event.source}">\n${input.text}\n</luna-event>\n\nThis is not the operator speaking: something you set up has reported back. Act on it as you planned, and tell the operator what you did.`;
	}

	const notes = [
		...(input.attachments ?? []).map(
			(file) => `<attachment id="${file.id}" name="${file.name.replace(/"/g, "'")}" bytes="${file.size}" />`
		),
		...(input.page ? [`<console-page>${input.page}</console-page>`] : []),
		...(run.mode !== run.startMode ? [`<approval-mode>${run.mode}</approval-mode>`] : [])
	];

	return notes.length
		? `${input.text}\n\n${notes.join('\n')}`
		: input.text;
}

function userMessage(text: string): SDKUserMessage {
	return {
		type: 'user',
		message: { role: 'user', content: text },
		parent_tool_use_id: null
	};
}

/**
 * The in-process MCP server for one run: `screenshot` and `navigate`, which
 * only the operator's browser can carry out. It is built per run because its
 * handlers belong to that run's panel.
 */
function consoleServer(run: Run): ReturnType<typeof createSdkMcpServer> {
	return createSdkMcpServer({
		name: CONSOLE_SERVER,
		version: '1.0.0',
		tools: [
			tool(
				'screenshot',
				"Capture the Luna Console as the operator sees it right now in their browser: the top bar, side navigation and the page they have open, scrolled where they left it, without this chat panel. Use it when the operator refers to something on their screen (\"this\", \"here\", \"what is wrong with this page\") and the <console-page> path alone does not tell you enough, or to check how a change looks. It shows only what is on screen; read data with the luna tools.",
				{},
				async () => {
					try {
						const shot = await run.askPanel<Screenshot>((id) => ({ type: 'screenshot', id }), 'capture');

						return {
							content: [
								{ type: 'image', data: Buffer.from(shot.bytes).toString('base64'), mimeType: shot.mime },
								{ type: 'text', text: `The console at ${shot.page}, ${shot.width}x${shot.height} CSS pixels, without the chat panel.` }
							]
						};
					} catch (err) {
						return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
					}
				},
				{ annotations: { readOnlyHint: true, openWorldHint: false } }
			),
			tool(
				'navigate',
				`Open a page of the Luna Console in the operator's browser, the way a click would: to show them what you are talking about, or to take them to where they can act on it. Give a console path, never a full URL or an /api route. Screens: /instances, /instances/<name>/<tab> where tab is one of ${INSTANCE_TABS.join(', ')}; /players, /players/<username>, /players/online, /players/moderation; /plugins, /mods, /packs, /datapacks; /machines/<name>; /network, /proxy, /schedules, /environment. A list screen filters with ?q=<text> (/plugins?q=luckperms). Say in your reply why you moved them; follow with console_screenshot to see what they now see.`,
				{ path: z.string().describe('Console path, starting with /, e.g. /instances/survival?tab=console') },
				async ({ path }) => {
					if (!isConsolePath(path)) {
						return { content: [{ type: 'text', text: `${path} is not a console page; give a path such as /instances/survival` }], isError: true };
					}

					try {
						const landed = await run.askPanel<Navigated>((id) => ({ type: 'navigate', id, path }), 'navigate');

						if (!landed.ok) {
							return { content: [{ type: 'text', text: `the console could not open ${path}: ${landed.error ?? 'unknown error'}` }], isError: true };
						}

						return { content: [{ type: 'text', text: `The operator's console is now on ${landed.page}.` }] };
					} catch (err) {
						return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
					}
				},
				{ annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }
			),
			...taskTools(run)
		]
	});
}

/** What `createSdkMcpServer` takes as its tool list. */
type ConsoleTools = NonNullable<Parameters<typeof createSdkMcpServer>[0]['tools']>;

/** Text answer for one of the console's own tools. */
function answer(text: string, isError = false): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
	return isError
		? { content: [{ type: 'text', text }], isError: true }
		: { content: [{ type: 'text', text }] };
}

/** Where this run's background work reports back, in the mode the run is in now. */
function deliveryContext(run: Run): DeliveryContext | null {
	return run.context
		? { ...run.context, mode: run.mode }
		: null;
}

/**
 * Background tasks and triggers: work the agent hands off while it keeps
 * going, and waits for something to happen. Both report back into this
 * conversation as a `<luna-event>` message when they settle (`background.ts`).
 */
function taskTools(run: Run): ConsoleTools {
	return [
		tool(
			'task_start',
			'Run one luna tool call in the background and keep working; its result arrives later in this conversation as a <luna-event> message. Use it for slow calls whose answer you do not need right away (a modpack install, a backup, a file_transfer of a big folder, a long log search), or to do several things at once. Give the tool name without any prefix (e.g. "modpack_install") and its arguments exactly as you would pass them directly. Only tools that would run without the operator\'s approval in the current mode can run in the background; anything needing approval must be called directly. Results come back in this conversation even if you have finished answering, which starts a new turn.',
			{
				tool: z.string().describe('The luna tool to call, e.g. "file_transfer"'),
				arguments: z.record(z.string(), z.unknown()).describe('Its arguments, as you would pass them directly'),
				label: z.string().optional().describe('A few words saying what it is for, shown to the operator')
			},
			async ({ tool: name, arguments: args, label }) => {
				const ctx = deliveryContext(run);

				if (!ctx) {
					return answer('background work is not available in this run', true);
				}

				try {
					const task = startTask(ctx, name.replace(/^mcp__luna__/, ''), args ?? {}, label ?? '');

					return answer(`Started background task ${task.id} (${task.tool}). Its result will arrive as a <luna-event> message; carry on meanwhile.`);
				} catch (err) {
					return answer((err as Error).message, true);
				}
			},
			{ annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }
		),
		tool(
			'task_list',
			'List the background tasks of this conversation: running ones first, then those finished in the last hour. Tasks live in the console\'s memory, so a console restart drops them.',
			{},
			async () => {
				const list = run.context ? listTasks(run.context.conversationId) : [];

				return answer(list.length ? JSON.stringify(list, null, 1) : 'No background tasks in this conversation.');
			},
			{ annotations: { readOnlyHint: true, openWorldHint: false } }
		),
		tool(
			'task_cancel',
			'Stop waiting for a background task: its result will not be reported. The call itself may still complete on the cluster; this does not undo it.',
			{ id: z.string().describe('The task id, e.g. task_ab12cd34ef') },
			async ({ id }) => {
				const cancelled = run.context ? cancelTask(run.context.conversationId, id) : false;

				return cancelled
					? answer(`Task ${id} will not be reported.`)
					: answer(`no running task ${id} in this conversation`, true);
			},
			{ annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }
		),
		tool(
			'trigger_create',
			`Wait for something to happen, then be told in this conversation (a <luna-event> message), even after you have finished answering. Kinds and their fields:
- timer: afterSeconds. A wake-up to check on something later.
- instance_state: instance, state (${INSTANCE_STATES.join(', ')}; "any" fires on any change). Fires at once if the instance is already in that state.
- player_chat: optional player (exact username), server, contains (case-insensitive). Network chat lines, not commands.
- player_join / player_leave: optional player, server.
- log_match: instance, contains. New lines of the instance's latest.log that contain the text.
- cluster_event: optional instance, eventKind (state, action, error), contains. Luna's own events (starts, stops, crashes, operator actions).
A trigger fires once unless maxFires is higher (a repeating one reports at most every 30 seconds, collecting what happened in between), and expires after expiresInMinutes (default 60, at most ${MAX_TRIGGER_MINUTES}), reporting that too. Write in note what you intend to do when it fires; it is handed back to you then. Triggers live in the console's memory, so a console restart drops them.`,
			{
				kind: z.enum(TRIGGER_KINDS),
				label: z.string().optional().describe('A few words saying what it waits for, shown to the operator'),
				note: z.string().optional().describe('What you plan to do when it fires'),
				afterSeconds: z.number().optional(),
				instance: z.string().optional(),
				state: z.string().optional(),
				player: z.string().optional(),
				server: z.string().optional(),
				contains: z.string().optional(),
				eventKind: z.enum(['state', 'action', 'error']).optional(),
				maxFires: z.number().int().optional().describe(`How many times it may fire, 1 to ${MAX_TRIGGER_FIRES} (default 1)`),
				expiresInMinutes: z.number().optional()
			},
			async (input) => {
				const ctx = deliveryContext(run);

				if (!ctx) {
					return answer('triggers are not available in this run', true);
				}

				const spec = triggerSpec(input);

				if (typeof spec === 'string') {
					return answer(spec, true);
				}

				try {
					const created = await createTrigger(ctx, spec, input);

					return answer(`Armed trigger ${created.id} until ${new Date(created.expiresAt).toISOString()}${created.maxFires > 1 ? `, for up to ${created.maxFires} fires` : ''}. You will be told here when it fires; there is no need to poll.`);
				} catch (err) {
					return answer((err as Error).message, true);
				}
			},
			{ annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }
		),
		tool(
			'trigger_list',
			'List the armed triggers of this conversation, with what each waits for, how often it fired and when it expires.',
			{},
			async () => {
				const list = run.context ? listTriggers(run.context.conversationId) : [];

				return answer(list.length ? JSON.stringify(list, null, 1) : 'No armed triggers in this conversation.');
			},
			{ annotations: { readOnlyHint: true, openWorldHint: false } }
		),
		tool(
			'trigger_cancel',
			'Disarm a trigger; nothing more is reported from it.',
			{ id: z.string().describe('The trigger id, e.g. trg_ab12cd34ef') },
			async ({ id }) => {
				const cancelled = run.context ? cancelTrigger(run.context.conversationId, id) : false;

				return cancelled
					? answer(`Trigger ${id} is disarmed.`)
					: answer(`no armed trigger ${id} in this conversation`, true);
			},
			{ annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }
		)
	];
}

/** A trigger_create call as a spec, or what is missing from it. */
function triggerSpec(input: {
	kind: (typeof TRIGGER_KINDS)[number];
	afterSeconds?: number;
	instance?: string;
	state?: string;
	player?: string;
	server?: string;
	contains?: string;
	eventKind?: 'state' | 'action' | 'error';
}): TriggerSpec | string {
	switch (input.kind) {
		case 'timer':
			return input.afterSeconds === undefined
				? 'a timer needs afterSeconds'
				: { kind: 'timer', afterSeconds: input.afterSeconds };

		case 'instance_state':
			return input.instance && input.state
				? { kind: 'instance_state', instance: input.instance, state: input.state }
				: 'instance_state needs instance and state';

		case 'player_chat':
			return { kind: 'player_chat', player: input.player, server: input.server, contains: input.contains };

		case 'player_join':
		case 'player_leave':
			return { kind: input.kind, player: input.player, server: input.server };

		case 'log_match':
			return input.instance && input.contains
				? { kind: 'log_match', instance: input.instance, contains: input.contains }
				: 'log_match needs instance and contains';

		case 'cluster_event':
			return { kind: 'cluster_event', instance: input.instance, contains: input.contains, eventKind: input.eventKind };
	}
}

/**
 * Put an `AskUserQuestion` call in front of the operator and wait for the
 * answer. The answers ride back in the tool's input, which is how the SDK's
 * tool reads them, and are kept on the call so the transcript shows what was
 * picked. A dismissal or the timeout tells the model to go on without one.
 */
async function askOperator(
	run: Run,
	toolInput: Record<string, unknown>,
	toolUseId: string,
	signal: AbortSignal
): Promise<PermissionResult> {
	run.calls.set(toolUseId, { name: AGENT_ASK_TOOL, input: toolInput });
	run.emit({ type: 'tool', id: toolUseId, name: AGENT_ASK_TOOL, input: toolInput, status: 'awaiting' });

	const reply = await new Promise<{ allow: boolean; by: string; answers?: AgentAnswers }>((resolve) => {
		const timer = setTimeout(() => {
			run.decide(toolUseId, false, 'timeout');
		}, APPROVAL_TIMEOUT_MS);

		run.pending.set(toolUseId, {
			resolve: (allow, by, answers) => {
				clearTimeout(timer);
				resolve({ allow, by, answers });
			}
		});

		signal.addEventListener('abort', () => {
			run.decide(toolUseId, false, 'stopped');
		});
	});

	const call = run.calls.get(toolUseId);

	if (!reply.allow || !reply.answers) {
		if (call) {
			call.decidedBy = reply.by;
			call.denied = true;
		}

		run.emit({ type: 'tool', id: toolUseId, name: AGENT_ASK_TOOL, status: 'denied', decidedBy: reply.by });

		return {
			behavior: 'deny',
			message: reply.by === 'timeout'
				? 'The operator did not answer in time. Carry on with the most sensible choice and say which one you made.'
				: 'The operator dismissed the question. Carry on with the most sensible choice, or stop if there is none, and say which.'
		};
	}

	const answered = { ...toolInput, answers: reply.answers };

	if (call) {
		call.input = answered;
		call.decidedBy = reply.by;
	}

	run.emit({ type: 'tool', id: toolUseId, name: AGENT_ASK_TOOL, input: answered, status: 'running', decidedBy: reply.by });

	return { behavior: 'allow', updatedInput: answered };
}

async function drive(
	run: Run,
	input: StartRunInput,
	launch: AgentLaunch,
	executable: string | undefined,
	resume: string | undefined
): Promise<void> {
	const grant = issueRunBearer(launch.token.id, {
		label: input.owner,
		account: input.owner,
		conversation: input.conversationId,
		via: 'meo-beo'
	});

	// Every call comes through here, none is pre-allowed: the operator can switch
	// mode mid-run, so whether a call runs unasked is decided at the call, by the
	// mode in force then, rather than by a list fixed when the run started.
	const canUseTool: CanUseTool = async (toolName, toolInput, options) => {
		const name = stripPrefix(toolName);

		if (toolName === AGENT_ASK_TOOL) {
			if (agentCanAsk(run.mode)) {
				return await askOperator(run, toolInput, options.toolUseID, options.signal);
			}

			return {
				behavior: 'deny',
				message: 'Auto mode: nobody is watching the panel to answer questions. Decide with your best judgement and carry on.'
			};
		}

		// only luna's tools and the console's own exist; anything else is refused outright
		if (!toolName.startsWith(TOOL_PREFIX) && !SCREEN_SDK_NAMES[toolName]) {
			return { behavior: 'deny', message: 'Only the luna tools are available.' };
		}

		if (runsUnasked(SCREEN_SDK_NAMES[toolName] ?? name, run.mode)) {
			return { behavior: 'allow', updatedInput: toolInput };
		}

		// plan mode never changes anything; the refusal tells the model what to do instead
		if (run.mode === 'plan') {
			run.calls.set(options.toolUseID, { name, input: toolInput, decidedBy: 'plan', denied: true });
			run.emit({ type: 'tool', id: options.toolUseID, name, input: toolInput, status: 'denied', decidedBy: 'plan' });

			return {
				behavior: 'deny',
				message: 'Plan mode: nothing may be changed. Finish investigating with read-only tools, then present the steps you would take.'
			};
		}

		run.calls.set(options.toolUseID, { name, input: toolInput });
		run.emit({ type: 'tool', id: options.toolUseID, name, input: toolInput, status: 'awaiting' });

		const decision = await new Promise<{ allow: boolean; by: string }>((resolve) => {
			const timer = setTimeout(() => {
				run.decide(options.toolUseID, false, 'timeout');
			}, APPROVAL_TIMEOUT_MS);

			run.pending.set(options.toolUseID, {
				resolve: (allow, by) => {
					clearTimeout(timer);
					resolve({ allow, by });
				}
			});

			options.signal.addEventListener('abort', () => {
				run.decide(options.toolUseID, false, 'stopped');
			});
		});

		const call = run.calls.get(options.toolUseID);

		if (call) {
			call.decidedBy = decision.by;
			call.denied = !decision.allow;
		}

		const result: PermissionResult = decision.allow
			? { behavior: 'allow', updatedInput: toolInput }
			: { behavior: 'deny', message: `The operator (${decision.by}) denied this call. Do not retry it another way.` };

		run.emit({
			type: 'tool',
			id: options.toolUseID,
			name,
			status: decision.allow ? 'running' : 'denied',
			decidedBy: decision.by
		});

		return result;
	};

	let sessionId: string | undefined;
	let costUsd = 0;
	let failed = false;

	try {
		const stream = query({
			prompt: run.input,
			options: {
				systemPrompt: personaPrompt({
					operator: input.owner,
					machine: input.machine,
					extra: launch.settings.instructions,
					locale: input.locale,
					mode: input.mode
				}),
				model: run.model,
				effort: run.effort as AgentEffort,
				maxTurns: launch.settings.maxTurns,
				// no built-in tool but the question one, and that only where someone is watching
				tools: agentCanAsk(input.mode)
					? [AGENT_ASK_TOOL]
					: [],
				mcpServers: {
					[SERVER]: {
						type: 'http',
						url: `${input.origin}/api/mcp`,
						headers: { Authorization: `Bearer ${grant.bearer}` },
						alwaysLoad: true,
						timeout: TOOL_TIMEOUT_MS
					},
					[CONSOLE_SERVER]: consoleServer(run)
				},
				strictMcpConfig: true,
				canUseTool,
				settingSources: [],
				includePartialMessages: true,
				resume,
				cwd: launch.home,
				env: subprocessEnv(launch),
				abortController: run.abort,
				...(executable ? { pathToClaudeCodeExecutable: executable } : {})
			}
		});

		run.query = stream;

		for await (const message of stream) {
			const outcome = handleMessage(run, message);

			if (outcome.sessionId) {
				sessionId = outcome.sessionId;
			}

			if (outcome.costUsd !== undefined) {
				costUsd = outcome.costUsd;
			}

			if (outcome.failed) {
				failed = true;
			}

			// a turn is over; with nothing queued in the session or still waiting
			// to be read from ours, the queue closes and the query ends after it
			if (outcome.turnDone && outcome.queued === 0 && run.input.buffered === 0) {
				run.closing = true;
				run.input.close();
			}
		}
	} catch (err) {
		const reported = failed;

		failed = true;

		const stopped = run.abort.signal.aborted;
		const text = stopped
			? 'Stopped.'
			: err instanceof Error
				? err.message
				: String(err);

		// the SDK throws after an error result it already delivered; that one was reported
		if (!reported || stopped) {
			run.entries.push({ kind: 'error', at: Date.now(), text: stopped ? '#stopped' : text });
			run.emit({ type: 'error', text, ...(stopped ? { code: 'stopped' as const } : {}) });
		}
	} finally {
		grant.revoke();
		run.closing = true;
		run.input.close();
		run.running = false;

		try {
			await appendAgentTurn(input.conversationId, input.owner, {
				entries: run.entries,
				sessionId,
				costUsd,
				completed: !failed
			});
		} catch (err) {
			console.error('[agent] could not save the transcript:', err);
		}

		run.emit({ type: 'done', costUsd });
		run.emit({ type: 'state', running: false });
		run.settle();

		setTimeout(() => {
			if (runs.get(input.conversationId) === run) {
				runs.delete(input.conversationId);
			}
		}, LINGER_MS);
	}
}

interface MessageOutcome {
	sessionId?: string;
	costUsd?: number;
	failed?: boolean;
	/** A turn's result arrived */
	turnDone?: boolean;
	/** Sends the session still holds after that result */
	queued?: number;
}

function handleMessage(run: Run, message: SDKMessage): MessageOutcome {
	const mode = run.mode;

	switch (message.type) {
		case 'system': {
			if (message.subtype !== 'init') {
				return {};
			}

			const luna = message.mcp_servers.find((server) => server.name === SERVER);

			if (luna && luna.status !== 'connected') {
				const text = `The luna tools are unavailable (${luna.status}).`;

				run.entries.push({ kind: 'error', at: Date.now(), text: '#toolsUnavailable' });
				run.emit({ type: 'error', text, code: 'toolsUnavailable' });
			}

			return { sessionId: message.session_id };
		}

		case 'stream_event': {
			// a subagent's stream is not the answer; there are none today, but say so
			if (message.parent_tool_use_id) {
				return {};
			}

			const event = message.event;

			if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
				run.emit({ type: 'text', delta: event.delta.text });
			}

			return {};
		}

		case 'assistant': {
			// an API failure arrives as a synthetic assistant message carrying the error
			// text; the result that follows reports it once, as an error, not as a reply
			if (message.error) {
				return {};
			}

			for (const block of message.message.content) {
				if (block.type === 'text' && block.text.trim()) {
					run.entries.push({ kind: 'assistant', at: Date.now(), text: block.text });
					run.emit({ type: 'assistant', text: block.text });
				}

				if (block.type === 'tool_use') {
					const name = stripPrefix(block.name);
					const known = run.calls.get(block.id);

					// a call that needs approval is about to reach canUseTool; showing it as
					// running first would flash a spinner over a call nobody has allowed
					if (!known) {
						run.calls.set(block.id, { name, input: block.input });
						run.emit({
							type: 'tool',
							id: block.id,
							name,
							input: block.input,
							status: name === AGENT_ASK_TOOL
								? 'awaiting'
								: runsUnasked(name, mode)
									? 'running'
									: mode === 'plan'
										? 'denied'
										: 'awaiting'
						});
					}
				}
			}

			return {};
		}

		case 'user': {
			const content = message.message.content;

			if (!Array.isArray(content)) {
				return {};
			}

			for (const block of content) {
				if (typeof block !== 'object' || block === null || block.type !== 'tool_result') {
					continue;
				}

				const call = run.calls.get(block.tool_use_id);
				const output = resultText(block.content);
				const status = call?.denied
					? 'denied'
					: block.is_error
						? 'error'
						: 'ok';

				run.entries.push({
					kind: 'tool',
					at: Date.now(),
					id: block.tool_use_id,
					name: call?.name ?? 'unknown',
					input: call?.input,
					status,
					output,
					decidedBy: call?.decidedBy
				});

				run.emit({
					type: 'tool',
					id: block.tool_use_id,
					name: call?.name ?? 'unknown',
					status,
					output: output.slice(0, 4096),
					decidedBy: call?.decidedBy
				});
			}

			return {};
		}

		case 'result': {
			const turn = { turnDone: true, queued: message.queued_turn_count ?? 0 };

			if (message.subtype === 'success' && !message.is_error) {
				return { ...turn, costUsd: message.total_cost_usd };
			}

			if (message.subtype === 'error_max_turns') {
				run.entries.push({ kind: 'error', at: Date.now(), text: '#maxTurns' });
				run.emit({ type: 'error', text: 'Stopped at the turn limit.', code: 'maxTurns' });

				return { ...turn, costUsd: message.total_cost_usd, failed: true };
			}

			const text = message.subtype === 'success'
				? message.result || 'The model returned an error.'
				: message.subtype.replace(/_/g, ' ');

			run.entries.push({ kind: 'error', at: Date.now(), text });
			run.emit({ type: 'error', text });

			return { ...turn, costUsd: message.total_cost_usd, failed: true };
		}

		default:
			return {};
	}
}

/** Attach to a conversation's live run: replays what happened so far, then follows. Null when nothing runs. */
export function followRun(conversationId: string, owner: string, listener: Listener): (() => void) | null {
	const run = runs.get(conversationId);

	if (!run || run.owner !== owner) {
		return null;
	}

	for (const event of run.events) {
		listener(event);
	}

	run.listeners.add(listener);

	return () => {
		run.listeners.delete(listener);
	};
}

/** Chats open on an idle conversation, waiting to hear that a run started there. */
const startWatchers = new Map<string, Set<{ owner: string; notify: () => void }>>();

function announceRunStart(conversationId: string, owner: string): void {
	for (const watcher of startWatchers.get(conversationId) ?? []) {
		if (watcher.owner === owner) {
			watcher.notify();
		}
	}
}

/**
 * Be told when a run starts in a conversation: a background task or a trigger
 * can start one while nobody is typing, and a chat sitting on that conversation
 * has to attach to it. Fires at once when one is already going. Returns the
 * unsubscriber.
 */
export function watchRunStarts(conversationId: string, owner: string, notify: () => void): () => void {
	const watcher = { owner, notify };
	const set = startWatchers.get(conversationId) ?? new Set();

	set.add(watcher);
	startWatchers.set(conversationId, set);

	const live = runs.get(conversationId);

	if (live?.running && live.owner === owner) {
		queueMicrotask(notify);
	}

	return () => {
		set.delete(watcher);

		if (set.size === 0) {
			startWatchers.delete(conversationId);
		}
	};
}

/** Whether a conversation has a run in progress. */
export function isRunning(conversationId: string): boolean {
	return runs.get(conversationId)?.running ?? false;
}

/**
 * Hand the panel's answer (a `Screenshot`, a `Navigated`) to the run that asked
 * for it. Only the conversation's owner may, and only for a request still
 * waiting.
 */
export function deliverPanelAnswer(conversationId: string, owner: string, requestId: string, answer: Screenshot | Navigated): boolean {
	const run = runs.get(conversationId);

	if (!run || run.owner !== owner) {
		return false;
	}

	const settle = run.asks.get(requestId);

	if (!settle) {
		return false;
	}

	settle(answer);

	return true;
}

/**
 * Approve or deny a waiting tool call, or answer a waiting question (`answers`,
 * keyed by question text; denying a question dismisses it). Only the
 * conversation's owner may.
 */
export function decideCall(
	conversationId: string,
	owner: string,
	toolUseId: string,
	allow: boolean,
	answers?: AgentAnswers
): boolean {
	const run = runs.get(conversationId);

	if (!run || run.owner !== owner) {
		return false;
	}

	return run.decide(toolUseId, allow, owner, answers);
}

/** Stop a conversation's run, denying anything still waiting. */
export function stopRun(conversationId: string, owner: string): boolean {
	const run = runs.get(conversationId);

	if (!run || run.owner !== owner || !run.running) {
		return false;
	}

	run.stop(owner);

	return true;
}

/** The models a live query says its credential can use; undefined when it will not say. */
async function reportModels(stream: ReturnType<typeof query>): Promise<ConnectionTest['models']> {
	try {
		const list = await stream.supportedModels();

		return list.map((model) => ({
			value: model.value,
			label: model.displayName,
			description: model.description
		}));
	} catch {
		// the list is a convenience; the test is the reply
		return undefined;
	}
}

export interface ConnectionTest {
	ok: boolean;
	reply?: string;
	error?: string;
	models?: Array<{ value: string; label: string; description: string }>;
	executable: string;
}

/**
 * Prove the credential and the executable work: one tool-less turn, plus the
 * list of models the credential can use, which the settings screen then offers.
 */
export async function testConnection(actor: string): Promise<ConnectionTest> {
	const launch = await agentLaunch(actor);
	const executable = findClaudeExecutable(launch.settings.executable);
	const where = executable.path ?? `(${executable.source})`;

	if (executable.source === 'none') {
		return { ok: false, error: 'No Claude Code executable found on this machine', executable: where };
	}

	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), 60_000);

	try {
		const stream = query({
			prompt: 'Reply with exactly one word: pong',
			options: {
				systemPrompt: 'You are a connection check. Follow the instruction literally.',
				model: launch.settings.model,
				maxTurns: 1,
				tools: [],
				settingSources: [],
				persistSession: false,
				cwd: launch.home,
				env: subprocessEnv(launch),
				abortController: abort,
				...(executable.path ? { pathToClaudeCodeExecutable: executable.path } : {})
			}
		});

		let models: ConnectionTest['models'];
		let reply = '';
		let error: string | undefined;

		try {
			for await (const message of stream) {
				if (message.type === 'system' && message.subtype === 'init' && !models) {
					models = await reportModels(stream);
				}

				if (message.type === 'result') {
					if (message.subtype === 'success' && !message.is_error) {
						reply = message.result;
					} else {
						error = message.subtype === 'success'
							? message.result
							: message.subtype;
					}
				}
			}
		} catch (err) {
			// the SDK throws after an error result; the result's own text is the better one
			error ??= err instanceof Error ? err.message : String(err);
		}

		if (models && models.length > 0) {
			await recordAgentModels(models);
		}

		return error
			? { ok: false, error, models, executable: where }
			: { ok: true, reply, models, executable: where };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err), executable: where };
	} finally {
		clearTimeout(timer);
	}
}
