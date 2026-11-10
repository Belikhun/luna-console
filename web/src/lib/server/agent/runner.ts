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
 * - `tools` keeps no built-in Claude Code tool that reaches anything (no shell,
 *   no web): the scratch-folder file tools, the checklist, the helper launcher
 *   and the question. Everything on the cluster is luna's, reached over
 *   `/api/mcp` with a per-run bearer (`bearer.ts`). The agent token's scope is
 *   therefore the whole of its reach, checked on every call by the endpoint.
 * - In Auto, every tool not marked destructive (and the agent's own memory) runs unasked;
 *   every other call waits in `canUseTool` until the operator who owns the
 *   conversation approves or denies it in the panel.
 *
 * The subprocess runs with its own HOME and CLAUDE_CONFIG_DIR under the cluster
 * root, so it never reads or writes the ~/.claude of whoever runs the console.
 *
 * A message sent while the agent works is folded into the answer it is giving
 * (`priority: 'next'`, the way Claude Code takes one mid-turn): the session
 * hands it to the model with its next tool result rather than after the turn.
 *
 * A shared conversation has several writers, but a run has one authority: its
 * `actor`, whose bearer it carries and who alone approves its calls. Another
 * writer's message mid-answer hands the run over (`handOver`): from then on the
 * bearer, the approvals and the screen are the new sender's, so nobody's words
 * act on anybody else's permissions.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { CanUseTool, PermissionResult, Query, SDKMessage, SDKRateLimitInfo, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import {
	AGENT_EFFORTS,
	AGENT_MODEL_PATTERN,
	agentLaunch,
	agentScratch,
	appendAgentTurn,
	getAgentConversation,
	recordAgentModels,
	refreshAgentModels,
	setAgentAllowedTools
} from '$core/agent';
import type { AgentContextUsage, AgentConversationView, AgentEffort, AgentEntry, AgentLaunch, AgentSharedFile } from '$core/agent';
import { loadCluster } from '$core/config';
import { statInstancePath } from '$core/instancefiles';
import { refuseFor, toolChecks } from '$lib/server/mcp/iam';
import {
	AGENT_ASK_TOOL,
	AGENT_NAVIGATE_TOOL,
	AGENT_SCRATCH_TOOLS,
	AGENT_SCREENSHOT_TOOL,
	AGENT_SHARE_TOOL,
	AGENT_SUBAGENT_TOOL,
	AGENT_TASK_TOOLS,
	AGENT_WORK_TOOLS,
	agentCanAsk,
	isConsolePath
} from '$shared/agent';
import type { AgentMode, AgentUsage, AgentUsageWindow } from '$shared/agent';
import { runsUnasked } from './approval';
import {
	cancelTask,
	cancelTrigger,
	createTrigger,
	INSTANCE_STATES,
	listTasks,
	listTriggers,
	MAX_REFIRE_GAP_SECONDS,
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
import { attachmentPath, SCRATCH_TOOL_MATCHER, scratchGate } from './scratch';
import { subagentDefinitions } from './subagents';
import { copyUpload } from './uploads';
import { INSTANCE_TABS } from '$lib/components/instancetabs';

/** The name luna's MCP server is registered under; the SDK prefixes its tools with it. */
const SERVER = 'luna';
const TOOL_PREFIX = `mcp__${SERVER}__`;

/** The in-process server carrying the tools only the operator's browser can answer. */
const CONSOLE_SERVER = 'console';
const SCREENSHOT_SDK_NAME = `mcp__${CONSOLE_SERVER}__screenshot`;
const SHARE_SDK_NAME = `mcp__${CONSOLE_SERVER}__share_file`;
const NAVIGATE_SDK_NAME = `mcp__${CONSOLE_SERVER}__navigate`;

/** The SDK names of the console's own tools, by the name the panel and the transcript use. */
const SCREEN_SDK_NAMES: Record<string, string> = {
	[SCREENSHOT_SDK_NAME]: AGENT_SCREENSHOT_TOOL,
	[NAVIGATE_SDK_NAME]: AGENT_NAVIGATE_TOOL,
	[SHARE_SDK_NAME]: AGENT_SHARE_TOOL,
	...Object.fromEntries(AGENT_TASK_TOOLS.map((name) => [`mcp__${CONSOLE_SERVER}__${name}`, name]))
};

/** The largest scratch file the agent may hand over; it is copied, so the copy is capped too. */
const SHARE_FILE_BYTES = 512 * 1024 * 1024;

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

/** A megabyte, as the attachment copy limit in the agent settings counts it. */
const MB = 1024 * 1024;

/** How long the session gets to measure its context after a turn before the estimate is used. */
const CONTEXT_TIMEOUT_MS = 5_000;

/** Longest focus note a manual compaction takes; it rides along on the command line. */
export const MAX_COMPACT_FOCUS = 500;

/** What the panel receives over the stream. */
export type AgentEvent =
	| { type: 'state'; running: boolean }
	| {
		type: 'user';
		text: string;
		author: string;
		at: number;
		mode: AgentMode;
		/** The model and effort it is answered with */
		model?: string;
		effort?: string;
		attachments?: Array<{ name: string; size: number; image?: string }>;
		uuid: string;
		/** What the sender's window called it, so it can match the echo to what it already shows */
		nonce?: string;
		/** It waits for another account's run to end before it starts its own */
		queued?: boolean;
	}
	| { type: 'text'; delta: string }
	| { type: 'assistant'; text: string }
	| { type: 'thinking'; delta: string }
	| { type: 'thought'; text: string }
	| {
		type: 'tool';
		id: string;
		name: string;
		input?: unknown;
		status: 'running' | 'awaiting' | 'ok' | 'error' | 'denied';
		output?: string;
		decidedBy?: string;
		/** The helper call this one was made inside */
		parent?: string;
		/** The account whose run made the call: who decides it while it waits, and whose permissions its result reflects */
		actor?: string;
		/** Images its result carried, saved for the chat to show; see `saveResultImages` */
		images?: string[];
		/** Files it handed over for download */
		files?: AgentSharedFile[];
	}
	/** A helper's progress: tool calls so far, the last one, time spent */
	| { type: 'progress'; id: string; tools: number; last?: string; ms: number }
	/**
	 * A held message that will not be sent after all: its sender took it back, or
	 * the run was stopped (`restore`, so the sender's message box gets it back)
	 */
	| { type: 'unqueue'; uuid: string; restore?: boolean; author?: string; text?: string }
	| { type: 'suggestion'; text: string }
	| { type: 'stats'; at: number; ms: number; tools: number; costUsd: number }
	/** `for` is the account whose browser answers: the run's actor, never a viewer */
	| { type: 'screenshot'; id: string; for: string }
	| { type: 'navigate'; id: string; path: string; for: string }
	| { type: 'error'; text: string; code?: AgentErrorCode }
	| { type: 'event'; source: 'task' | 'trigger'; label: string; text: string; at: number }
	| { type: 'context'; context: AgentContextUsage }
	| { type: 'compacting'; active: boolean }
	| { type: 'compact'; trigger: 'manual' | 'auto'; by?: string; preTokens: number; postTokens?: number; at: number }
	| { type: 'done'; costUsd: number }
	/** The run started; who it runs as */
	| { type: 'actor'; actor: string };

/** Failures the panel words itself, in the operator's language; anything else shows its text. */
export type AgentErrorCode =
	| 'stopped'
	| 'maxTurns'
	| 'toolsUnavailable'
	| 'busy'
	| 'noExecutable'
	| 'bypassOff'
	| 'badModel'
	| 'nothingToCompact'
	| 'readOnly'
	| 'compactFailed';

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

/** What came with a decision besides yes or no. */
export interface DecisionExtras {
	answers?: AgentAnswers;
	/** Stop asking about this tool in this conversation, for the account deciding */
	always?: boolean;
	/** Why it was denied, handed to the model */
	reason?: string;
}

interface Pending {
	resolve: (allow: boolean, by: string, extras: DecisionExtras) => void;
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

	/** Called as the session takes each message, which is when a message's turn budget starts */
	onRead: () => void = () => {};

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
			this.onRead();
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
					this.onRead();

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

const IMAGE_EXTENSIONS: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp'
};

/**
 * Keep the pictures a tool result carried (a screenshot, an image file the
 * agent read) beside the conversation's scratch files, so the chat can show
 * what the model was shown. A result block is the API's `image` with a base64
 * source; an MCP result's own `{ data, mimeType }` shape is taken too.
 * Returns the saved file names, in order.
 */
function saveResultImages(run: Run, toolUseId: string, content: unknown): string[] {
	if (!run.scratch || !Array.isArray(content)) {
		return [];
	}

	const names: string[] = [];
	const dir = join(run.scratch, '.images');
	const stem = toolUseId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100);

	for (const part of content as Array<Record<string, unknown>>) {
		if (part?.type !== 'image') {
			continue;
		}

		const source = part.source as { type?: string; media_type?: string; data?: string } | undefined;
		const mime = source?.media_type ?? (typeof part.mimeType === 'string' ? part.mimeType : '');
		const data = source?.type === 'base64'
			? source.data
			: typeof part.data === 'string'
				? part.data
				: undefined;
		const extension = IMAGE_EXTENSIONS[mime];

		if (!data || !extension) {
			continue;
		}

		const name = `${stem}-${names.length}.${extension}`;

		try {
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, name), Buffer.from(data, 'base64'));
			names.push(name);
		} catch (err) {
			console.error('[agent] could not keep an image a tool returned:', err);
		}
	}

	return names;
}

/** The files a share call's result names, taken off the run as they are filed. */
function sharedFiles(run: Run, output: string): AgentSharedFile[] {
	const out: AgentSharedFile[] = [];

	for (const match of output.matchAll(/\bfile_[0-9a-f]{12}\b/g)) {
		const file = run.files.get(match[0]);

		if (file) {
			run.files.delete(match[0]);
			out.push(file);
		}
	}

	return out;
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

/**
 * A helper's report out of the structured result the SDK hands back with the
 * call: its own words, without the frame the model is given around them (a
 * hand-back notice, the agent id, usage), and its totals. Null when the result
 * is not one, so the call's text stands.
 */
function helperReport(result: unknown): { text: string; tools: number; ms: number } | null {
	const shaped = result as { content?: unknown; totalToolUseCount?: unknown; totalDurationMs?: unknown } | null | undefined;

	if (!shaped || !Array.isArray(shaped.content)) {
		return null;
	}

	const text = shaped.content
		.map((part) => (typeof part === 'object' && part !== null && 'text' in part ? String(part.text) : ''))
		.join('\n')
		.trim();

	return text
		? { text, tools: Number(shaped.totalToolUseCount) || 0, ms: Number(shaped.totalDurationMs) || 0 }
		: null;
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
		DISABLE_AUTOUPDATER: '1',
		// the checklist the chat docks above the composer is TodoWrite's; recent builds put a
		// persisted task list in its place, which has no place in a console conversation
		CLAUDE_CODE_ENABLE_TASKS: 'false',
		// a helper's report belongs to the turn that asked for it; work meant to outlive a
		// turn goes through the console's own background tasks, which report into the chat
		CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1'
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
	readonly calls = new Map<string, { name: string; input: unknown; decidedBy?: string; denied?: boolean; parent?: string }>();

	/** Tools the actor allowed for this conversation; they run unasked here whatever the mode, Plan aside */
	readonly allowed = new Set<string>();

	/** When the session took the message it is answering, and the calls made since: one answer's stats */
	turnStartedAt = Date.now();
	turnTools = 0;

	/** The session's running cost when the current answer began, so an answer's own cost is the difference */
	costMark = 0;

	/** Operators' messages filed before the session said its id, to be marked with it when the run saves */
	readonly unstamped: string[] = [];

	running = true;

	/** Set once the last turn finished with nothing queued; a later message starts a new run */
	closing = false;

	/** The prompt queue the query reads from */
	readonly input = new InputQueue();

	/** Messages held until the answer being given ends, oldest first; each starts the next turn */
	readonly held: StartRunInput[] = [];

	/** Whether others can write in the conversation, so each message names its sender */
	shared = false;

	/** Files the agent shared during this run, by id, until the call's result files them */
	readonly files = new Map<string, AgentSharedFile>();

	/** What the agent token reaches of instance files: whether it reads them, and on which instances */
	fileScope: { read: boolean; instances: string[] | null } = { read: false, instances: null };

	/** Moves the run's MCP bearer to another account; set once the query starts */
	retarget: ((account: string) => void) | null = null;

	/** The live query, once started; model and effort changes go through it */
	query: Query | null = null;

	/** The approval mode in force now; `canUseTool` reads it on every call */
	mode: AgentMode;

	/** The mode the persona was written for; a message sent after a switch says so */
	readonly startMode: AgentMode;

	model: string;
	effort: string;

	/** How full the session's context is, as last measured */
	usage: AgentContextUsage | null = null;

	/** What the latest main-loop response sent, the estimate used when the session cannot be asked */
	lastPrompt: { tokens: number; model: string } | null = null;

	/** Context windows by model, as the turn results report them */
	readonly windows = new Map<string, number>();

	/** Compactions seen during this run, saved with its transcript */
	compactions = 0;

	/** Who asked for the compaction the session is about to run; cleared when it reports back */
	compactBy: string | null = null;

	/** Set by a compaction until the turn is measured; see `measureContext` */
	compactedSinceMeasure = false;

	/**
	 * Model responses since the session last took a message. The SDK's own
	 * `maxTurns` counts across the whole query, so a run the operator kept
	 * talking to (or that triggers kept feeding) ran out of turns however short
	 * each message was; the limit is counted here instead, per message.
	 */
	turns = 0;

	/** The response the last assistant message belonged to; one response arrives as several messages */
	lastResponseId = '';

	maxTurns = 0;

	/** Attachments up to this size are also copied into the scratch folder, where the file tools can read them; refreshed from the settings by every message */
	scratchAttachmentBytes = 0;

	/** Set when the turn limit interrupted the session, so the result that follows says so */
	turnCapped = false;

	/** The limit's stop was reported; the SDK may still throw over the interrupted turn */
	capReported = false;

	/** The conversation's scratch folder, where the file tools are confined */
	scratch = '';

	/** The SDK session, once the run's first message says which */
	sessionId: string | null = null;

	/** Attachments copied into the scratch folder, by upload id */
	readonly attachmentPaths = new Map<string, string>();

	/** Settles when the run has saved its transcript and stopped */
	readonly finished: Promise<void>;

	#settle: () => void = () => {};

	constructor(
		readonly conversationId: string,
		/** The conversation's owner */
		readonly owner: string,
		/**
		 * Who the run acts as and answers to: the account that started it, until
		 * another participant's message joins it and the run is handed to them
		 */
		public actor: string,
		settings: { mode: AgentMode; model: string; effort: string }
	) {
		this.mode = settings.mode;
		this.startMode = settings.mode;
		this.model = settings.model;
		this.effort = settings.effort;
		this.finished = new Promise((resolve) => {
			this.#settle = resolve;
		});
		this.input.onRead = () => {
			this.turns = 0;
			this.turnStartedAt = Date.now();
			this.turnTools = 0;
		};
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

	decide(toolUseId: string, allow: boolean, by: string, extras: DecisionExtras = {}): boolean {
		const pending = this.pending.get(toolUseId);

		if (!pending) {
			return false;
		}

		this.pending.delete(toolUseId);
		pending.resolve(allow, by, extras);

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

		// as Claude Code does on an interrupt: what was held goes back to its sender's message box
		for (const held of this.held.splice(0)) {
			this.emit({ type: 'unqueue', uuid: held.uuid ?? '', restore: true, author: held.actor, text: held.text });
		}

		this.closing = true;
		this.input.close();
		this.abort.abort();
	}
}

const runs = new Map<string, Run>();

export interface StartRunInput {
	conversationId: string;
	/** Who sends it, and so who the run it starts acts as */
	actor: string;
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
	/** Set to summarise the session's history instead of saying anything; `text` is then the focus */
	compact?: true;
	/** What the sender's window called the message, echoed back so it can match it */
	nonce?: string;
	/** Hold it until the answer being given ends, rather than fold it into that answer */
	hold?: boolean;
	/** The SDK uuid the message goes in under; given once, kept while it waits in the queue */
	uuid?: string;
}

/** What became of a message: it started a run, joined the one going, or waits for another account's to end. */
export type StartOutcome = 'started' | 'joined' | 'queued';

/** Background reports waiting for another account's run to end, per conversation, oldest first. */
const waiting = new Map<string, StartRunInput[]>();

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

/** The attachments as a transcript names them. */
function fileList(input: StartRunInput): Array<{ name: string; size: number; image?: string }> | undefined {
	return input.attachments?.length
		? input.attachments.map((file) => {
			const image = attachmentImage(file);

			return image
				? { name: file.name, size: file.size, image }
				: { name: file.name, size: file.size };
		})
		: undefined;
}

/** The largest attached picture the chat keeps a copy of to show. */
const ATTACHMENT_IMAGE_BYTES = 16 * 1024 * 1024;

/**
 * The name the chat's copy of an attached picture goes by under `.images`, or
 * null when the attachment is not one. Derived from the upload id, so the
 * message can name it before the copy is made.
 */
function attachmentImage(file: { id: string; name: string; size: number }): string | null {
	const extension = /\.(png|jpe?g|gif|webp)$/i.exec(file.name)?.[1]?.toLowerCase();

	if (!extension || file.size > ATTACHMENT_IMAGE_BYTES || !/^att_[0-9a-f]{16}$/.test(file.id)) {
		return null;
	}

	return `${file.id}.${extension === 'jpeg' ? 'jpg' : extension}`;
}

/** The `user` event every window following the run shows a message by. */
function userFrame(
	input: StartRunInput,
	settings: { mode: AgentMode; model: string; effort: string },
	at: number,
	queued = false
): AgentEvent {
	const attachments = fileList(input);

	return {
		type: 'user',
		text: input.text,
		author: input.actor,
		at,
		mode: settings.mode,
		model: settings.model,
		effort: settings.effort,
		uuid: input.uuid!,
		...(input.nonce ? { nonce: input.nonce } : {}),
		...(attachments ? { attachments } : {}),
		...(queued ? { queued: true } : {})
	};
}

/**
 * Send a message to Mèo Béo. With no run going it starts one, resolving once
 * the run is under way (the message saved, the subprocess launching). With one
 * going, the message joins it: the session takes it with its next tool result,
 * as Claude Code does with a message typed mid-answer. A run going as another
 * account is handed over to the sender first, so nobody's words ride on
 * anybody else's authority; a background report for another account still
 * waits for that run to end. The answer arrives
 * on the stream, which echoes every message, so each window following the
 * conversation shows it the same way.
 */
export async function startRun(input: StartRunInput): Promise<StartOutcome> {
	const conversation = await getAgentConversation(input.conversationId, input.actor);

	if (!conversation) {
		throw new Error(`No conversation ${input.conversationId}`);
	}

	if (conversation.role === 'viewer') {
		throw new AgentRunError('readOnly', 'You can read this conversation but not write in it');
	}

	input.uuid ??= crypto.randomUUID();

	const launch = await agentLaunch(input.actor);

	checkSettings(launch, input);

	const live = runs.get(input.conversationId);
	const shared = conversation.owner !== input.actor || (conversation.shares?.length ?? 0) > 0;

	if (live) {
		live.shared = shared;
		live.scratchAttachmentBytes = launch.settings.scratchAttachmentMb * MB;
	}

	if (input.hold && live?.running && !live.closing && !input.compact && !input.event) {
		live.held.push(input);
		await copyAttachments(live, input);
		live.emit(userFrame(input, { mode: input.mode, model: input.model || live.model, effort: input.effort || live.effort }, Date.now(), true));

		return 'queued';
	}

	if (live?.running && live.actor !== input.actor && input.compact) {
		throw new AgentRunError('busy', `${live.actor}'s answer is still running`);
	}

	// another participant speaking mid-answer takes the run over, as Claude Code
	// folds a message into the turn it is in; from there on the run is theirs, so
	// their words never act on anybody else's permissions
	if (live?.running && !live.closing && live.actor !== input.actor && !input.event) {
		const allowed = conversation.allowedTools;

		if (await joinRun(live, input, () => handOver(live, input.actor, allowed))) {
			return 'joined';
		}
	}

	// a background report acts for whoever armed it, and waits for a run that is somebody else's
	if (live?.running && live.actor !== input.actor && input.event) {
		const queue = waiting.get(input.conversationId) ?? [];

		queue.push(input);
		waiting.set(input.conversationId, queue);

		return 'queued';
	}

	if (live?.running && !live.closing && live.actor === input.actor) {
		if (await joinRun(live, input)) {
			return 'joined';
		}
	}

	// a run winding down still owns the session; the next one resumes it once it is saved
	if (live?.running) {
		await live.finished;

		return await startRun(input);
	}

	if (input.compact && !conversation.sessionId && !conversation.pendingFork) {
		throw new AgentRunError('nothingToCompact', 'This conversation has no history to compact yet');
	}

	const executable = findClaudeExecutable(launch.settings.executable);

	if (executable.source === 'none') {
		throw new AgentRunError('noExecutable', 'No Claude Code executable found on this machine; set its path in the agent settings');
	}

	const run = new Run(input.conversationId, conversation.owner, input.actor, {
		mode: input.mode,
		model: input.model || launch.settings.model,
		effort: input.effort || launch.settings.effort
	});

	run.scratchAttachmentBytes = launch.settings.scratchAttachmentMb * MB;

	for (const tool of conversation.allowedTools) {
		run.allowed.add(tool);
	}

	// the session's running total carries across a resume and into a branch, so an
	// answer's own cost is measured from what the session had counted before it
	run.costMark = conversation.pendingFork
		? conversation.pendingFork.costBase ?? 0
		: conversation.sessionId
			? Math.max(0, conversation.costUsd - (conversation.costBeforeUsd ?? 0)) + (conversation.costBaseUsd ?? 0)
			: 0;

	run.shared = shared;
	runs.set(input.conversationId, run);
	run.scratch = await agentScratch(input.conversationId, input.actor);
	run.context = {
		conversationId: input.conversationId,
		owner: input.actor,
		origin: input.origin,
		machine: input.machine,
		locale: input.locale
	};
	run.emit({ type: 'actor', actor: input.actor });

	const at = Date.now();

	// a compaction says nothing and files itself once the session reports it;
	// a notice is nobody's words: it is filed as an event, and never names the chat
	if (input.compact) {
		run.compactBy = input.actor;
	} else {
		const attachments = fileList(input);

		await appendAgentTurn(input.conversationId, input.actor, input.event
			? { entries: [eventEntry(input)] }
			: {
				entries: [{
					kind: 'user',
					at,
					author: input.actor,
					text: input.text,
					mode: input.mode,
					model: run.model,
					effort: run.effort,
					uuid: input.uuid,
					...(attachments ? { attachments } : {})
				}],
				title: input.text
			});
		run.unstamped.push(input.uuid);
	}

	if (input.event) {
		run.emit(eventFrame(input));
	} else if (!input.compact) {
		run.emit(userFrame(input, { mode: input.mode, model: run.model, effort: run.effort }, at));
	}

	await copyAttachments(run, input);
	run.input.push(userMessage(promptFor(input, run), input.uuid));
	run.emit({ type: 'state', running: true });
	announceRunStart(input.conversationId);

	void drive(run, input, launch, executable.path, conversation);

	return 'started';
}

/**
 * Hand a message to a run already going as the same account. The settings it
 * was sent with apply from here on, it is filed in the transcript between what
 * came before and after it, and every window following the run shows it. False
 * when the run closed its queue in the meantime, so the caller starts a new one.
 */
async function joinRun(run: Run, input: StartRunInput, before?: () => void, midTurn = true): Promise<boolean> {
	before?.();
	await applyRunSettings(run, input);

	const at = Date.now();
	const attachments = fileList(input);
	const priority = midTurn && !input.compact
		? 'next'
		: undefined;

	await copyAttachments(run, input);

	if (!run.input.push(userMessage(promptFor(input, run), input.uuid, priority))) {
		return false;
	}

	if (input.compact) {
		run.compactBy = input.actor;

		return true;
	}

	if (input.event) {
		run.entries.push(eventEntry(input));
		run.emit(eventFrame(input));

		return true;
	}

	run.entries.push({
		kind: 'user',
		at,
		author: input.actor,
		text: input.text,
		mode: run.mode,
		model: run.model,
		effort: run.effort,
		uuid: input.uuid,
		...(midTurn ? { midTurn: true } : {}),
		...(attachments ? { attachments } : {})
	});
	run.emit(userFrame(input, { mode: run.mode, model: run.model, effort: run.effort }, at));

	return true;
}

/**
 * Give a live run to another participant: their bearer, their tools allowed in
 * this chat, their screen, and the calls still waiting for a decision, which
 * are announced again as theirs to make.
 */
function handOver(run: Run, actor: string, allowed: string[]): void {
	run.actor = actor;
	run.retarget?.(actor);
	run.allowed.clear();

	for (const tool of allowed) {
		run.allowed.add(tool);
	}

	if (run.context) {
		run.context = { ...run.context, owner: actor };
	}

	run.emit({ type: 'actor', actor });

	for (const id of run.pending.keys()) {
		const call = run.calls.get(id);

		if (call) {
			run.emit({ type: 'tool', id, name: call.name, input: call.input, status: 'awaiting', actor, ...(call.parent ? { parent: call.parent } : {}) });
		}
	}
}

/**
 * Send the oldest held message as the next turn, handing the run to its sender
 * when that is somebody else. A sender who can no longer write here (a share
 * taken back meanwhile) has theirs dropped. False when nothing was sent.
 */
async function deliverHeld(run: Run): Promise<boolean> {
	while (run.held.length && !run.abort.signal.aborted) {
		const next = run.held.shift()!;
		const view = await getAgentConversation(run.conversationId, next.actor).catch(() => undefined);

		if (!view || view.role === 'viewer') {
			run.emit({ type: 'unqueue', uuid: next.uuid ?? '' });

			continue;
		}

		const before = next.actor !== run.actor
			? () => handOver(run, next.actor, view.allowedTools)
			: undefined;

		if (await joinRun(run, next, before, false)) {
			return true;
		}

		run.held.unshift(next);

		return false;
	}

	return false;
}

/**
 * Take back a held message before it is sent. Only its sender may; the
 * windows following the conversation drop it.
 */
export function revokeHeld(conversationId: string, account: string, uuid: string): boolean {
	const run = runs.get(conversationId);
	const queues = [run?.held ?? [], waiting.get(conversationId) ?? []];

	for (const queue of queues) {
		const index = queue.findIndex((entry) => entry.uuid === uuid && entry.actor === account && !entry.event);

		if (index >= 0) {
			queue.splice(index, 1);
			run?.emit({ type: 'unqueue', uuid });

			return true;
		}
	}

	return false;
}

/** Start the next message that waited for a run to end, as its own sender. */
async function startWaiting(conversationId: string): Promise<void> {
	const queue = waiting.get(conversationId);
	const next = queue?.shift();

	if (!queue?.length) {
		waiting.delete(conversationId);
	}

	if (!next) {
		return;
	}

	try {
		await startRun(next);
	} catch (err) {
		console.error('[agent] a queued message could not start its run:', err);

		// the next in line still deserves its turn
		await startWaiting(conversationId);
	}
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
export async function updateRun(conversationId: string, account: string, change: RunSettings): Promise<boolean> {
	const run = runs.get(conversationId);

	if (!run || run.actor !== account || !run.running || run.closing) {
		return false;
	}

	checkSettings(await agentLaunch(account), change);
	await applyRunSettings(run, change);

	return true;
}

/** A notice as the transcript files it. */
function eventEntry(input: StartRunInput): AgentEntry {
	return { kind: 'event', at: Date.now(), source: input.event!.source, label: input.event!.label, text: input.text, uuid: input.uuid };
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
		actor: notice.ctx.owner,
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
	// the session runs its own /compact; a focus note rides on the same line
	if (input.compact) {
		const focus = input.text.replace(/\s+/g, ' ').trim();

		return focus
			? `/compact ${focus}`
			: '/compact';
	}

	if (input.event) {
		return `<luna-event source="${input.event.source}">\n${input.text}\n</luna-event>\n\nThis is not the operator speaking: something you set up has reported back. Act on it as you planned, and tell the operator what you did.`;
	}

	const notes = [
		...(run.shared ? [`<sender>${input.actor}</sender>`] : []),
		...(input.attachments ?? []).map((file) => {
			const copy = run.attachmentPaths.get(file.id);
			const path = copy
				? ` path="${copy}"`
				: '';

			return `<attachment id="${file.id}" name="${file.name.replace(/"/g, "'")}" bytes="${file.size}"${path} />`;
		}),
		...(input.page ? [`<console-page>${input.page}</console-page>`] : []),
		...(run.mode !== run.startMode ? [`<approval-mode>${run.mode}</approval-mode>`] : [])
	];

	return notes.length
		? `${input.text}\n\n${notes.join('\n')}`
		: input.text;
}

/**
 * Put a message's attachments in the scratch folder too, so the agent can read
 * a pasted log, a screenshot or a PDF with its own file tools; the upload id
 * still names the file for the luna tools that install or place it. Files past
 * the settings' copy limit stay staged only.
 */
async function copyAttachments(run: Run, input: StartRunInput): Promise<void> {
	for (const file of input.attachments ?? []) {
		if (run.attachmentPaths.has(file.id) || file.size > run.scratchAttachmentBytes || !run.scratch) {
			continue;
		}

		const dest = attachmentPath(run.scratch, file.id, file.name);

		try {
			if (await copyUpload(file.id, input.actor, dest)) {
				run.attachmentPaths.set(file.id, dest);

				const image = attachmentImage(file);

				// the chat shows the picture from its own copy, which the agent's edits never touch
				if (image) {
					await mkdir(join(run.scratch, '.images'), { recursive: true });
					await copyFile(dest, join(run.scratch, '.images', image));
				}
			}
		} catch (err) {
			console.error('[agent] could not copy an attachment into the scratch folder:', err);
		}
	}
}

/** A message as the session reads it; the uuid is what a later fork or rewind cuts at. */
function userMessage(text: string, uuid?: string, priority?: SDKUserMessage['priority']): SDKUserMessage {
	return {
		type: 'user',
		message: { role: 'user', content: text },
		parent_tool_use_id: null,
		...(priority ? { priority } : {}),
		...(uuid ? { uuid: uuid as SDKUserMessage['uuid'] } : {})
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
						const shot = await run.askPanel<Screenshot>((id) => ({ type: 'screenshot', id, for: run.actor }), 'capture');

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
						const landed = await run.askPanel<Navigated>((id) => ({ type: 'navigate', id, path, for: run.actor }), 'navigate');

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
			tool(
				'share_file',
				'Hand the operator a file to download straight from this chat: an export, a report, a generated config, a log you gathered. Give `path` to a file in your scratch folder (write it there first with Write), or `instance` with `path` for a file on that server (relative to its folder), which they download with their own permissions. The chat shows it as a download card under this call, so do not paste its content too; say in a line what it is. Never copy files into a server folder just to hand them over.',
				{
					path: z.string().describe('A file in your scratch folder (absolute, or relative to it); with `instance`, a path inside that server'),
					instance: z.string().optional().describe('The instance the file is on, for a server file'),
					name: z.string().optional().describe('The name it downloads as; defaults to the file name')
				},
				async ({ path, instance, name }) => {
					try {
						const file = instance
							? await shareInstanceFile(run, instance, path, name)
							: await shareScratchFile(run, path, name);

						run.files.set(file.id, file);

						return answer(`Shared ${file.name} (${file.size} bytes) as a download in the chat [${file.id}].`);
					} catch (err) {
						return answer((err as Error).message, true);
					}
				},
				{ annotations: { readOnlyHint: true, openWorldHint: false } }
			),
			...taskTools(run)
		]
	});
}

/** A name a download may carry: the last path part, without what a file system would read as a folder. */
function downloadName(given: string | undefined, fallback: string): string {
	const name = basename((given ?? '').trim()).replace(/[\\/\u0000]/g, '').slice(0, 200);

	return name && name !== '.' && name !== '..'
		? name
		: fallback;
}

/** Copy a scratch file under `.files/<id>`, so the download stays what was shared whatever the agent writes next. */
async function shareScratchFile(run: Run, given: string, name: string | undefined): Promise<AgentSharedFile> {
	if (!run.scratch) {
		throw new Error('this conversation has no scratch folder to share from');
	}

	const scratch = await realpath(run.scratch);
	const target = await realpath(isAbsolute(given) ? given : join(scratch, given)).catch(() => null);

	if (!target) {
		throw new Error(`${given} does not exist`);
	}

	const inside = relative(scratch, target);

	if (inside.startsWith('..') || isAbsolute(inside) || inside.split(sep)[0]?.startsWith('.')) {
		throw new Error(`${given} is not a file in your scratch folder`);
	}

	const info = await stat(target);

	if (!info.isFile()) {
		throw new Error(`${given} is not a file`);
	}

	if (info.size > SHARE_FILE_BYTES) {
		throw new Error(`${given} is ${info.size} bytes; the most a chat download takes is ${SHARE_FILE_BYTES}`);
	}

	const id = `file_${randomBytes(6).toString('hex')}`;
	const file = downloadName(name, basename(target));
	const dir = join(scratch, '.files', id);

	await mkdir(dir, { recursive: true });
	await copyFile(target, join(dir, file));

	return { id, name: file, size: info.size };
}

/**
 * Name a file on an instance, after checking the run's account could download
 * it and the agent's token reaches it; the chat links it through the instance
 * file route, which checks each reader again.
 */
async function shareInstanceFile(run: Run, instance: string, path: string, name: string | undefined): Promise<AgentSharedFile> {
	if (!run.fileScope.read || (run.fileScope.instances !== null && !run.fileScope.instances.includes(instance))) {
		throw new Error(`instance files on ${instance} are outside your tools`);
	}

	const refusal = await refuseFor(run.actor, toolChecks('file_read', { instance, path }) ?? []);

	if (refusal) {
		throw new Error(`${run.actor} may not download files from ${instance} (${refusal.reason})`);
	}

	const info = await statInstancePath(await loadCluster(), instance, path);

	if (!info || info.kind !== 'file') {
		throw new Error(`${path} is not a file on ${instance}`);
	}

	return {
		id: `file_${randomBytes(6).toString('hex')}`,
		name: downloadName(name, basename(info.path)),
		size: info.size,
		instance,
		path: info.path
	};
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
A trigger fires once unless maxFires is higher; a repeating one leaves minGapSeconds between reports (default 5), collecting what happened in between, so raise it for a noisy source you only need a summary of. It expires after expiresInMinutes (default 60, at most ${MAX_TRIGGER_MINUTES}), reporting that too. Write in note what you intend to do when it fires; it is handed back to you then. Triggers live in the console's memory, so a console restart drops them.`,
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
				minGapSeconds: z.number().optional().describe(`Least time between two reports of a repeating trigger, 0 to ${MAX_REFIRE_GAP_SECONDS} (default 5)`),
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
 * Wait for the run's actor to decide a call: allow, deny (with a reason the
 * model hears) or answer a question. Another participant cannot: the call runs
 * on the actor's authority, so the yes is theirs to give. Stopping the run or
 * ten minutes of silence deny it.
 */
function awaitDecision(run: Run, toolUseId: string, signal: AbortSignal): Promise<{ allow: boolean; by: string } & DecisionExtras> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			run.decide(toolUseId, false, 'timeout');
		}, APPROVAL_TIMEOUT_MS);

		run.pending.set(toolUseId, {
			resolve: (allow, by, extras) => {
				clearTimeout(timer);
				resolve({ allow, by, ...extras });
			}
		});

		signal.addEventListener('abort', () => {
			run.decide(toolUseId, false, 'stopped');
		});
	});
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
	const parent = run.calls.get(toolUseId)?.parent;

	run.calls.set(toolUseId, { name: AGENT_ASK_TOOL, input: toolInput, parent });
	run.emit({ type: 'tool', id: toolUseId, name: AGENT_ASK_TOOL, input: toolInput, status: 'awaiting', actor: run.actor, ...(parent ? { parent } : {}) });

	const reply = await awaitDecision(run, toolUseId, signal);
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

/**
 * A helper launch as the console runs it: in the foreground, so its report
 * arrives within the turn that asked for it (the console has its own
 * background tasks for work that should outlive a turn), and never in an
 * isolated copy of anything, which means nothing here.
 */
function foreground(input: Record<string, unknown>): Record<string, unknown> {
	const { run_in_background: _background, isolation: _isolation, ...rest } = input;

	return { ...rest, run_in_background: false };
}

/** Models that think adaptively, whose thinking can be shown as a summary. */
function thinksAdaptively(model: string): boolean {
	return /^(opus|sonnet|fable)$/.test(model) || /^claude-(opus|sonnet|fable)-(5|4-[6-9])/.test(model);
}

async function drive(
	run: Run,
	input: StartRunInput,
	launch: AgentLaunch,
	executable: string | undefined,
	conversation: AgentConversationView
): Promise<void> {
	const fork = conversation.pendingFork;
	const grant = issueRunBearer(launch.token.id, {
		label: input.actor,
		account: input.actor,
		conversation: input.conversationId,
		via: 'meo-beo'
	});

	run.retarget = grant.retarget;
	run.fileScope = { read: launch.token.tools.includes('file_read'), instances: launch.token.scope.instances };

	// Every call comes through here, none is pre-allowed: the operator can switch
	// mode mid-run, so whether a call runs unasked is decided at the call, by the
	// mode in force then, rather than by a list fixed when the run started.
	const canUseTool: CanUseTool = async (toolName, rawInput, options) => {
		const name = stripPrefix(toolName);
		const toolInput = toolName === AGENT_SUBAGENT_TOOL
			? foreground(rawInput)
			: rawInput;

		if (toolName === AGENT_ASK_TOOL) {
			if (agentCanAsk(run.mode)) {
				return await askOperator(run, toolInput, options.toolUseID, options.signal);
			}

			return {
				behavior: 'deny',
				message: 'Auto mode: nobody is watching the panel to answer questions. Decide with your best judgement and carry on.'
			};
		}

		// only luna's tools, the console's own and Claude Code's local ones exist; anything else is refused outright
		if (!toolName.startsWith(TOOL_PREFIX) && !SCREEN_SDK_NAMES[toolName] && !AGENT_SCRATCH_TOOLS.includes(toolName) && !AGENT_WORK_TOOLS.includes(toolName)) {
			return { behavior: 'deny', message: 'Only the luna tools are available.' };
		}

		const tool = SCREEN_SDK_NAMES[toolName] ?? name;
		const known = run.calls.get(options.toolUseID);
		const parent = known?.parent;

		if (runsUnasked(tool, run.mode) || (run.allowed.has(tool) && run.mode !== 'plan')) {
			return { behavior: 'allow', updatedInput: toolInput };
		}

		// plan mode never changes anything; the refusal tells the model what to do instead
		if (run.mode === 'plan') {
			run.calls.set(options.toolUseID, { name, input: toolInput, decidedBy: 'plan', denied: true, parent });
			run.emit({ type: 'tool', id: options.toolUseID, name, input: toolInput, status: 'denied', decidedBy: 'plan', ...(parent ? { parent } : {}) });

			return {
				behavior: 'deny',
				message: 'Plan mode: nothing may be changed. Finish investigating with read-only tools, then present the steps you would take.'
			};
		}

		run.calls.set(options.toolUseID, { name, input: toolInput, parent });
		run.emit({ type: 'tool', id: options.toolUseID, name, input: toolInput, status: 'awaiting', actor: run.actor, ...(parent ? { parent } : {}) });

		const decision = await awaitDecision(run, options.toolUseID, options.signal);
		const call = run.calls.get(options.toolUseID);

		if (call) {
			call.decidedBy = decision.by;
			call.denied = !decision.allow;
		}

		if (decision.allow && decision.always && !run.allowed.has(tool)) {
			run.allowed.add(tool);
			void setAgentAllowedTools(run.conversationId, run.actor, [...run.allowed]).catch((err) => {
				console.error('[agent] could not remember an allowed tool:', err);
			});
		}

		const reason = decision.reason
			? ` They said: "${decision.reason.replace(/"/g, "'")}".`
			: '';
		const result: PermissionResult = decision.allow
			? { behavior: 'allow', updatedInput: toolInput }
			: { behavior: 'deny', message: `The operator (${decision.by}) denied this call.${reason} Do not retry it another way.` };

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
					operator: input.actor,
					owner: conversation.owner,
					machine: input.machine,
					extra: launch.settings.instructions,
					locale: input.locale,
					mode: input.mode,
					scratch: run.scratch,
					instanceFiles: launch.token.tools.includes('file_read')
				}),
				model: run.model,
				effort: run.effort as AgentEffort,
				...(thinksAdaptively(run.model) ? { thinking: { type: 'adaptive', display: 'summarized' } as const } : {}),
				// the only built-ins: the file tools, confined to the scratch folder by the hook
				// below, the checklist and the helper launcher, and the question one, only where
				// someone is watching
				tools: agentCanAsk(input.mode)
					? [...AGENT_SCRATCH_TOOLS, ...AGENT_WORK_TOOLS, AGENT_ASK_TOOL]
					: [...AGENT_SCRATCH_TOOLS, ...AGENT_WORK_TOOLS],
				agents: subagentDefinitions(launch.settings.subagents, launch.token.tools),
				additionalDirectories: [run.scratch],
				hooks: {
					PreToolUse: [{
						matcher: SCRATCH_TOOL_MATCHER,
						hooks: [scratchGate({
							scratch: run.scratch,
							home: launch.home,
							sessionId: () => run.sessionId ?? fork?.session ?? conversation.sessionId ?? null,
							unasked: (tool) => runsUnasked(tool, run.mode)
						})]
					}]
				},
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
				promptSuggestions: launch.settings.suggestions,
				// a fork or a rewind branches the session at the cut; otherwise it carries on
				...(fork
					? { resume: fork.session, forkSession: true, ...(fork.at ? { resumeSessionAt: fork.at } : {}) }
					: { resume: conversation.sessionId }),
				cwd: launch.home,
				env: subprocessEnv(launch),
				abortController: run.abort,
				...(executable ? { pathToClaudeCodeExecutable: executable } : {})
			}
		});

		run.query = stream;
		run.maxTurns = launch.settings.maxTurns;

		for await (const message of stream) {
			if (message.type === 'rate_limit_event') {
				noteRateLimit(message.rate_limit_info);
			}

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

			// measured before the queue may close, since the session answers only while the query lives
			if (outcome.turnDone) {
				await refreshContext(run);
			}

			// a turn is over; a held message starts the next one, and with nothing
			// queued in the session or still waiting to be read from ours, the queue
			// closes and the query ends after it
			if (outcome.turnDone && outcome.queued === 0 && run.input.buffered === 0) {
				if (await deliverHeld(run)) {
					continue;
				}

				run.closing = true;
				run.input.close();
			}
		}
	} catch (err) {
		// the SDK throws after an interrupt the turn limit caused; that stop was already said
		const reported = failed || run.capReported;

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

		// what was filed before the session said its id belongs to it all the same
		const session = sessionId ?? run.sessionId ?? undefined;
		const entries = session
			? run.entries.map((entry) => ('uuid' in entry && entry.uuid && !entry.session ? { ...entry, session } : entry))
			: run.entries;

		try {
			await appendAgentTurn(input.conversationId, run.actor, {
				entries,
				sessionId,
				costUsd,
				completed: !failed,
				forked: !!fork && !!sessionId,
				...(fork?.costBase ? { costBase: fork.costBase } : {}),
				...(session && run.unstamped.length ? { stamp: { session, uuids: run.unstamped } } : {}),
				...(run.usage ? { context: run.usage } : {}),
				...(run.compactions ? { compactions: run.compactions } : {})
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

		// a run that ended on its own (an error, the turn limit) still owes its held messages a turn
		if (run.held.length) {
			waiting.set(input.conversationId, [...run.held.splice(0), ...(waiting.get(input.conversationId) ?? [])]);
		}

		void startWaiting(input.conversationId);
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
			if (message.subtype === 'compact_boundary') {
				noteCompaction(run, message.compact_metadata);

				return {};
			}

			if (message.subtype === 'status') {
				noteStatus(run, message.status, message.compact_result, message.compact_error);

				return {};
			}

			// a helper's running tally, shown on its card while it works
			if (message.subtype === 'task_progress') {
				if (message.tool_use_id) {
					run.emit({
						type: 'progress',
						id: message.tool_use_id,
						tools: message.usage.tool_uses,
						ms: message.usage.duration_ms,
						...(message.last_tool_name ? { last: stripPrefix(message.last_tool_name) } : {})
					});
				}

				return {};
			}

			if (message.subtype !== 'init') {
				return {};
			}

			const luna = message.mcp_servers.find((server) => server.name === SERVER);

			if (luna && luna.status !== 'connected') {
				const text = `The luna tools are unavailable (${luna.status}).`;

				run.entries.push({ kind: 'error', at: Date.now(), text: '#toolsUnavailable' });
				run.emit({ type: 'error', text, code: 'toolsUnavailable' });
			}

			run.sessionId = message.session_id;

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

			if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') {
				run.emit({ type: 'thinking', delta: event.delta.thinking });
			}

			return {};
		}

		case 'assistant': {
			// an API failure arrives as a synthetic assistant message carrying the error
			// text; the result that follows reports it once, as an error, not as a reply
			if (message.error) {
				return {};
			}

			if (!message.parent_tool_use_id) {
				countTurn(run, message.message.id);
			}

			// a subagent's request is not the session's context
			if (!message.parent_tool_use_id && message.message.usage) {
				const usage = message.message.usage;

				run.lastPrompt = {
					tokens: usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
					model: message.message.model
				};
			}

			// a helper's own words are its business; its report arrives as the tool's result
			const parent = message.parent_tool_use_id ?? undefined;

			for (const block of message.message.content) {
				if (block.type === 'text' && block.text.trim() && !parent) {
					run.entries.push({ kind: 'assistant', at: Date.now(), text: block.text, uuid: message.uuid, session: message.session_id });
					run.emit({ type: 'assistant', text: block.text });
				}

				if (block.type === 'thinking' && block.thinking.trim() && !parent) {
					run.entries.push({ kind: 'thinking', at: Date.now(), text: block.thinking });
					run.emit({ type: 'thought', text: block.thinking });
				}

				if (block.type === 'tool_use') {
					const name = stripPrefix(block.name);
					const known = run.calls.get(block.id);

					run.turnTools += 1;

					// a call that needs approval is about to reach canUseTool; showing it as
					// running first would flash a spinner over a call nobody has allowed
					if (!known) {
						const unasked = runsUnasked(name, mode) || (run.allowed.has(name) && mode !== 'plan');

						run.calls.set(block.id, { name, input: block.input, parent });
						run.emit({
							type: 'tool',
							id: block.id,
							name,
							input: block.input,
							status: name === AGENT_ASK_TOOL
								? 'awaiting'
								: unasked
									? 'running'
									: mode === 'plan'
										? 'denied'
										: 'awaiting',
							actor: run.actor,
							...(parent ? { parent } : {})
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
				const report = call?.name === AGENT_SUBAGENT_TOOL
					? helperReport(message.tool_use_result)
					: null;
				const output = report?.text ?? resultText(block.content);
				const images = saveResultImages(run, block.tool_use_id, block.content);
				const files = call?.name === AGENT_SHARE_TOOL
					? sharedFiles(run, output)
					: [];

				if (report) {
					run.emit({ type: 'progress', id: block.tool_use_id, tools: report.tools, ms: report.ms });
				}
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
					decidedBy: call?.decidedBy,
					actor: run.actor,
					...(images.length ? { images } : {}),
					...(files.length ? { files } : {}),
					...(call?.parent
						? { parent: call.parent }
						: { uuid: message.uuid, session: message.session_id ?? run.sessionId ?? undefined })
				});

				run.emit({
					type: 'tool',
					id: block.tool_use_id,
					name: call?.name ?? 'unknown',
					status,
					output: output.slice(0, 4096),
					decidedBy: call?.decidedBy,
					actor: run.actor,
					...(images.length ? { images } : {}),
					...(files.length ? { files } : {}),
					...(call?.parent ? { parent: call.parent } : {})
				});
			}

			return {};
		}

		case 'prompt_suggestion': {
			if (message.suggestion.trim()) {
				run.emit({ type: 'suggestion', text: message.suggestion.trim().slice(0, 500) });
			}

			return {};
		}

		case 'result': {
			const turn = { turnDone: true, queued: message.queued_turn_count ?? 0 };

			noteStats(run, message.total_cost_usd);

			for (const [model, usage] of Object.entries(message.modelUsage ?? {})) {
				if (usage.contextWindow) {
					run.windows.set(model, usage.contextWindow);
				}
			}

			// the interrupt ends the turn however the SDK words it; the run takes the next message
			if (run.turnCapped) {
				run.turnCapped = false;
				run.capReported = true;
				run.entries.push({ kind: 'error', at: Date.now(), text: '#maxTurns' });
				run.emit({ type: 'error', text: 'Stopped at the turn limit for this message.', code: 'maxTurns' });

				return { ...turn, costUsd: message.total_cost_usd };
			}

			run.capReported = false;

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

/**
 * File what the answer just finished took: its wall time from when the session
 * took the message, the tool calls made, and its share of the session's cost.
 */
function noteStats(run: Run, total: number | undefined): void {
	const costUsd = total !== undefined
		? Math.max(0, total - run.costMark)
		: 0;
	const stats = { at: Date.now(), ms: Date.now() - run.turnStartedAt, tools: run.turnTools, costUsd };

	if (total !== undefined) {
		run.costMark = total;
	}

	run.entries.push({ kind: 'stats', ...stats });
	run.emit({ type: 'stats', ...stats });
}

/**
 * Count a model response against the message it is answering, and interrupt
 * the session's turn once a message has used its share. Only the turn stops: a
 * message queued behind it still gets its own answer.
 */
function countTurn(run: Run, responseId: string): void {
	if (!responseId || responseId === run.lastResponseId) {
		return;
	}

	run.lastResponseId = responseId;
	run.turns += 1;

	if (run.maxTurns > 0 && run.turns > run.maxTurns && !run.turnCapped) {
		run.turnCapped = true;
		void run.query?.interrupt().catch(() => {});
	}
}

/**
 * File a compaction the session reported. A manual one is credited to whoever
 * asked for it; one the session ran on its own near the limit names nobody.
 */
function noteCompaction(run: Run, meta: { trigger: 'manual' | 'auto'; pre_tokens: number; post_tokens?: number }): void {
	const at = Date.now();
	const by = meta.trigger === 'manual'
		? run.compactBy ?? undefined
		: undefined;
	const detail = {
		trigger: meta.trigger,
		...(by ? { by } : {}),
		preTokens: meta.pre_tokens,
		...(meta.post_tokens !== undefined ? { postTokens: meta.post_tokens } : {})
	};

	run.compactBy = null;
	run.compactions += 1;
	run.compactedSinceMeasure = true;
	run.entries.push({ kind: 'compact', at, ...detail });
	run.emit({ type: 'compact', at, ...detail });

	// the session's figures count the history alone, the meter the whole request (persona and
	// tool schemas too), so what the summary freed is taken off; the turn's own measurement follows
	if (meta.post_tokens !== undefined && run.usage) {
		const freed = Math.max(0, meta.pre_tokens - meta.post_tokens);

		run.usage = { ...run.usage, tokens: Math.max(0, run.usage.tokens - freed), at };
		run.emit({ type: 'context', context: run.usage });
	}
}

/** The session started or finished summarising its history. */
function noteStatus(run: Run, status: string | null, result?: 'success' | 'failed', error?: string): void {
	if (status === 'compacting') {
		run.emit({ type: 'compacting', active: true });

		return;
	}

	if (!result) {
		return;
	}

	run.emit({ type: 'compacting', active: false });

	if (result === 'failed') {
		run.compactBy = null;
		run.entries.push({ kind: 'error', at: Date.now(), text: '#compactFailed' });
		run.emit({ type: 'error', text: error || 'The conversation could not be compacted.', code: 'compactFailed' });
	}
}

/**
 * Ask the session how full its context is, the way `/context` does, from the
 * last response's usage without extra token-count calls. Right after a
 * compaction that response is the summarising request, which still carried the
 * whole old history, so the context is counted properly once instead. When the
 * session cannot say in time, the last response's prompt size over the model's
 * window stands in.
 */
async function refreshContext(run: Run): Promise<void> {
	// the last response predates a compaction, so its size would undo the interim figure
	const compacted = run.compactedSinceMeasure;
	const measured = await measureContext(run);
	const context = measured ?? (compacted ? run.usage : estimateContext(run));

	if (!context) {
		return;
	}

	run.usage = context;
	run.emit({ type: 'context', context });
}

async function measureContext(run: Run): Promise<AgentContextUsage | null> {
	if (!run.query) {
		return null;
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	const detail = run.compactedSinceMeasure
		? 'full'
		: 'summary';

	run.compactedSinceMeasure = false;

	try {
		const usage = await Promise.race([
			run.query.getContextUsage({ detail }),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('no answer')), CONTEXT_TIMEOUT_MS);
			})
		]);

		return { tokens: usage.totalTokens, window: usage.rawMaxTokens, model: usage.model, at: Date.now() };
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

function estimateContext(run: Run): AgentContextUsage | null {
	const last = run.lastPrompt;

	if (!last) {
		return null;
	}

	const window = run.windows.get(last.model) ?? [...run.windows.values()][0];

	if (!window) {
		return null;
	}

	return { tokens: last.tokens, window, model: last.model, at: Date.now() };
}

/**
 * Attach to a conversation's live run: replays what happened so far, then
 * follows. Null when nothing runs. The caller has already checked that the
 * reader may open the conversation; every participant follows the same run.
 */
export function followRun(conversationId: string, listener: Listener): (() => void) | null {
	const run = runs.get(conversationId);

	if (!run) {
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
const startWatchers = new Map<string, Set<() => void>>();

function announceRunStart(conversationId: string): void {
	for (const notify of startWatchers.get(conversationId) ?? []) {
		notify();
	}
}

/**
 * Be told when a run starts in a conversation: a background task, a trigger or
 * another participant can start one while this reader is not typing, and a
 * chat sitting on that conversation has to attach to it. Fires at once when
 * one is already going. Returns the unsubscriber.
 */
export function watchRunStarts(conversationId: string, notify: () => void): () => void {
	const set = startWatchers.get(conversationId) ?? new Set();

	set.add(notify);
	startWatchers.set(conversationId, set);

	if (runs.get(conversationId)?.running) {
		queueMicrotask(notify);
	}

	return () => {
		set.delete(notify);

		if (set.size === 0) {
			startWatchers.delete(conversationId);
		}
	};
}

/** Whether a conversation has a run in progress. */
export function isRunning(conversationId: string): boolean {
	return runs.get(conversationId)?.running ?? false;
}

/** A scratch file a live run shared, before the run has saved its transcript. */
export function liveSharedFile(conversationId: string, fileId: string): AgentSharedFile | null {
	const run = runs.get(conversationId);

	for (const entry of run?.entries ?? []) {
		const found = entry.kind === 'tool'
			? entry.files?.find((item) => item.id === fileId && !item.instance)
			: undefined;

		if (found) {
			return found;
		}
	}

	return null;
}

/** Whether a live run's unsaved messages name an attached picture by this name. */
export function liveAttachmentImage(conversationId: string, image: string): boolean {
	const run = runs.get(conversationId);
	const inEntries = run?.entries.some((entry) => entry.kind === 'user' && !!entry.attachments?.some((file) => file.image === image)) ?? false;
	const held = run?.held.some((input) => input.attachments?.some((file) => attachmentImage(file) === image)) ?? false;

	return inEntries || held;
}

/** The tool call a live run filed an image under, before the run has saved its transcript. */
export function liveImageEntry(conversationId: string, image: string): Extract<AgentEntry, { kind: 'tool' }> | null {
	const run = runs.get(conversationId);

	return run?.entries.find(
		(entry): entry is Extract<AgentEntry, { kind: 'tool' }> => entry.kind === 'tool' && !!entry.images?.includes(image)
	) ?? null;
}

/** Who a conversation's live run acts as, or null when none goes. */
export function runActor(conversationId: string): string | null {
	const run = runs.get(conversationId);

	return run?.running
		? run.actor
		: null;
}

/**
 * Hand the panel's answer (a `Screenshot`, a `Navigated`) to the run that asked
 * for it. Only the run's actor may: it is their screen the agent asked about,
 * and nobody else's browser should answer for it.
 */
export function deliverPanelAnswer(conversationId: string, account: string, requestId: string, answer: Screenshot | Navigated): boolean {
	const run = runs.get(conversationId);

	if (!run || run.actor !== account) {
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
 * keyed by question text; denying a question dismisses it). Only the run's
 * actor may, since the call runs on their authority.
 */
export function decideCall(
	conversationId: string,
	account: string,
	toolUseId: string,
	allow: boolean,
	extras: DecisionExtras = {}
): boolean {
	const run = runs.get(conversationId);

	if (!run || run.actor !== account) {
		return false;
	}

	return run.decide(toolUseId, allow, account, extras);
}

/**
 * Stop a conversation's run, denying anything still waiting. Its actor may, and
 * so may the conversation's owner, whose conversation it is. Messages queued
 * behind it still start afterwards.
 */
export function stopRun(conversationId: string, account: string): boolean {
	const run = runs.get(conversationId);

	if (!run || !run.running || (run.actor !== account && run.owner !== account)) {
		return false;
	}

	run.stop(account);

	return true;
}

/** Drop the messages waiting in a conversation's queue; a deleted conversation has nowhere to send them. */
export function dropWaiting(conversationId: string): void {
	waiting.delete(conversationId);
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
				if (message.type === 'rate_limit_event') {
					noteRateLimit(message.rate_limit_info);
				}

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

/**
 * The plan windows the API reported on the agent's own turns, newest per
 * window. A `claude setup-token` token may only call the model, so the
 * `/usage` read refuses it; these are what its answers still say. Held in
 * memory, so a console restart forgets them until the next turn.
 */
const observedLimits = new Map<string, AgentUsageWindow>();

function noteRateLimit(info: SDKRateLimitInfo): void {
	const id = info.rateLimitType;

	if (!id || id === 'overage') {
		return;
	}

	// the headers carry a fraction and epoch seconds; the window view is percent and ISO
	const utilization = info.utilization === undefined
		? null
		: info.utilization <= 1
			? info.utilization * 100
			: info.utilization;
	const resetsAt = info.resetsAt === undefined
		? null
		: new Date(info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt).toISOString();

	observedLimits.set(id, { id, label: null, utilization, resetsAt, status: info.status, at: Date.now() });
}

function observedUsage(): AgentUsage {
	const windows = [...observedLimits.values()].filter((window) => {
		return !window.resetsAt || Date.parse(window.resetsAt) > Date.now();
	});

	return {
		available: windows.length > 0,
		source: 'observed',
		subscription: null,
		email: null,
		organization: null,
		windows,
		extra: null,
		at: Math.max(0, ...windows.map((window) => window.at ?? 0)) || Date.now()
	};
}

interface AccountProbe {
	models?: Array<{ value: string; label: string; description: string }>;
	usage?: AgentUsage;
}

/** A prompt that never sends anything: the session starts, answers control requests and spends no turn. */
async function* idlePrompt(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
	await new Promise<void>((resolve) => {
		signal.addEventListener('abort', () => resolve(), { once: true });
	});
}

type UsageAnswer = Awaited<ReturnType<Query['usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET']>>;

function usageWindows(limits: NonNullable<UsageAnswer['rate_limits']>): AgentUsageWindow[] {
	const windows: AgentUsageWindow[] = [];

	for (const id of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps'] as const) {
		const window = limits[id];

		if (window) {
			windows.push({ id, label: null, utilization: window.utilization, resetsAt: window.resets_at });
		}
	}

	for (const window of limits.model_scoped ?? []) {
		windows.push({ id: 'model', label: window.display_name, utilization: window.utilization, resetsAt: window.resets_at });
	}

	return windows;
}

/**
 * Open a session without sending it anything and ask it what Claude Code's own
 * screens would show: the models it offers and the account's plan usage. No
 * turn is spent; the session is closed as soon as it has answered.
 */
async function probeAccount(actor: string, want: { models?: boolean; usage?: boolean }): Promise<AccountProbe> {
	const launch = await agentLaunch(actor);
	const executable = findClaudeExecutable(launch.settings.executable);

	if (executable.source === 'none') {
		throw new Error('No Claude Code executable found on this machine');
	}

	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), 30_000);
	const stream = query({
		prompt: idlePrompt(abort.signal),
		options: {
			model: launch.settings.model,
			tools: [],
			settingSources: [],
			persistSession: false,
			cwd: launch.home,
			env: subprocessEnv(launch),
			abortController: abort,
			...(executable.path ? { pathToClaudeCodeExecutable: executable.path } : {})
		}
	});

	// nothing is expected on the stream, but it is read so the session never stalls on a full pipe
	const drain = (async (): Promise<void> => {
		for await (const message of stream) {
			void message;
		}
	})().catch(() => undefined);

	try {
		const [models, account, usage] = await Promise.all([
			want.models
				? stream.supportedModels().catch(() => undefined)
				: undefined,
			want.usage
				? stream.accountInfo().catch(() => undefined)
				: undefined,
			want.usage
				? stream.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
				: undefined
		]);

		const probe: AccountProbe = {};

		if (models) {
			probe.models = models.map((model) => ({
				value: model.value,
				label: model.displayName,
				description: model.description
			}));
		}

		if (usage) {
			const limits = usage.rate_limits;
			const extra = limits?.extra_usage;

			probe.usage = {
				available: usage.rate_limits_available && limits !== null,
				source: 'plan',
				subscription: usage.subscription_type ?? account?.subscriptionType ?? null,
				email: account?.email ?? null,
				organization: account?.organization ?? null,
				windows: limits
					? usageWindows(limits)
					: [],
				extra: extra
					? {
							enabled: extra.is_enabled,
							limit: extra.monthly_limit,
							used: extra.used_credits,
							utilization: extra.utilization,
							currency: extra.currency ?? null
						}
					: null,
				at: Date.now()
			};
		}

		return probe;
	} finally {
		clearTimeout(timer);
		abort.abort();
		stream.close();
		await drain;
	}
}

/** Usage reads within this long of the last one are answered from it; each read starts a subprocess. */
const USAGE_CACHE_MS = 60_000;

let usageCache: AgentUsage | null = null;

let usageInFlight: Promise<AgentUsage> | null = null;

/**
 * The account's plan usage (the 5-hour and weekly windows, extra usage),
 * read through the Claude Code subprocess as its `/usage` does. A subscription
 * token has these; an API key answers `available: false`. `fresh` skips the
 * minute-long cache, for the screen's refresh button.
 */
export async function agentUsage(actor: string, fresh = false): Promise<AgentUsage> {
	if (!fresh && usageCache && Date.now() - usageCache.at < USAGE_CACHE_MS) {
		return usageCache;
	}

	if (usageInFlight) {
		return await usageInFlight;
	}

	usageInFlight = (async (): Promise<AgentUsage> => {
		const probe = await probeAccount(actor, { usage: true });

		if (!probe.usage) {
			throw new Error('Claude Code did not report usage');
		}

		// an inference-only token cannot read the plan; what its own turns reported is the next best answer
		const answer = probe.usage.available
			? probe.usage
			: { ...observedUsage(), subscription: probe.usage.subscription, email: probe.usage.email, organization: probe.usage.organization };

		usageCache = answer;

		return answer;
	})();

	try {
		return await usageInFlight;
	} finally {
		usageInFlight = null;
	}
}

/** Where a model list refresh got its answer. */
export interface ModelsRefresh {
	source: 'api' | 'sdk';
	count: number;
	/** Why the Models API was not used, when the list came from the subprocess instead */
	apiError?: string;
}

/**
 * Refresh the models offered on the settings screen and the composer. The
 * Models API names every model the credential can call, so it is asked first;
 * when it refuses (a subscription token may not reach it), the Claude Code
 * subprocess's own list is the answer.
 */
export async function refreshModels(actor: string): Promise<ModelsRefresh> {
	let apiError: string | undefined;

	try {
		const fetched = await refreshAgentModels();

		if (fetched.length > 0) {
			return { source: 'api', count: fetched.length };
		}

		apiError = 'the Models API listed nothing';
	} catch (err) {
		apiError = err instanceof Error ? err.message : String(err);
	}

	const probe = await probeAccount(actor, { models: true });

	if (!probe.models || probe.models.length === 0) {
		throw new Error(`No model list: ${apiError}`);
	}

	await recordAgentModels(probe.models);

	return { source: 'sdk', count: probe.models.length, apiError };
}
