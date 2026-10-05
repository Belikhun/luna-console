// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Mèo Béo's runs: one Claude Agent SDK query per message, driven from the
 * console's server process.
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
 * - Tools that only read (or only touch the agent's own memory) run unasked;
 *   every other call waits in `canUseTool` until the operator who owns the
 *   conversation approves or denies it in the panel.
 *
 * The subprocess runs with its own HOME and CLAUDE_CONFIG_DIR under the cluster
 * root, so it never reads or writes the ~/.claude of whoever runs the console.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool, PermissionResult, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import {
	AGENT_EFFORTS,
	AGENT_MODEL_PATTERN,
	agentLaunch,
	appendAgentTurn,
	getAgentConversation,
	recordAgentModels
} from '$core/agent';
import type { AgentEffort, AgentEntry, AgentLaunch } from '$core/agent';
import { mcpTool } from '$shared/mcptools';
import type { AgentMode } from '$shared/agent';
import { issueRunBearer } from './bearer';
import { findClaudeExecutable } from './executable';
import { personaPrompt } from './persona';

/** The name luna's MCP server is registered under; the SDK prefixes its tools with it. */
const SERVER = 'luna';
const TOOL_PREFIX = `mcp__${SERVER}__`;

/** How long a call waits for the operator before it is denied for them. */
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

/** How long a finished run's events stay replayable for a panel that reconnects late. */
const LINGER_MS = 15_000;

/** Longest single tool call; lifecycle tools wait up to three minutes for a server to settle. */
const TOOL_TIMEOUT_MS = 4 * 60 * 1000;

/** What the panel receives over the stream. */
export type AgentEvent =
	| { type: 'state'; running: boolean }
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
	| { type: 'error'; text: string; code?: AgentErrorCode }
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

interface Pending {
	resolve: (allow: boolean, by: string) => void;
}

function stripPrefix(name: string): string {
	return name.startsWith(TOOL_PREFIX)
		? name.slice(TOOL_PREFIX.length)
		: name;
}

/** Tools that leave the cluster as it was: those that only read, and the agent's own memory. */
function leavesClusterAlone(name: string): boolean {
	const tool = mcpTool(name);

	if (!tool) {
		return false;
	}

	return tool.annotations.readOnlyHint === true || tool.group === 'knowledge-write';
}

/** Whether a tool runs without asking in a mode. Plan refuses the rest in `canUseTool` instead. */
function runsUnasked(name: string, mode: AgentMode): boolean {
	switch (mode) {
		case 'manual':
			return false;

		case 'bypass':
			return true;

		default:
			return leavesClusterAlone(name);
	}
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
	readonly events: AgentEvent[] = [];
	readonly listeners = new Set<Listener>();
	readonly pending = new Map<string, Pending>();
	readonly abort = new AbortController();

	/** Entries written to the transcript when the run ends */
	readonly entries: AgentEntry[] = [];

	/** Tool calls by id, so a result can be filed against its call */
	readonly calls = new Map<string, { name: string; input: unknown; decidedBy?: string; denied?: boolean }>();

	running = true;

	constructor(
		readonly conversationId: string,
		readonly owner: string
	) {}

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

	decide(toolUseId: string, allow: boolean, by: string): boolean {
		const pending = this.pending.get(toolUseId);

		if (!pending) {
			return false;
		}

		this.pending.delete(toolUseId);
		pending.resolve(allow, by);

		return true;
	}

	stop(by: string): void {
		for (const id of [...this.pending.keys()]) {
			this.decide(id, false, by);
		}

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
}

/**
 * Start a run for one message. Resolves once the run is under way (the
 * message saved, the subprocess launching); the answer arrives on the stream.
 */
export async function startRun(input: StartRunInput): Promise<void> {
	// a finished run lingers for late reconnects; only one still going blocks the next message
	if (runs.get(input.conversationId)?.running) {
		throw new AgentRunError('busy', 'Mèo Béo is still answering the last message');
	}

	const conversation = await getAgentConversation(input.conversationId, input.owner);

	if (!conversation) {
		throw new Error(`No conversation ${input.conversationId}`);
	}

	const launch = await agentLaunch(input.owner);
	const executable = findClaudeExecutable(launch.settings.executable);

	if (executable.source === 'none') {
		throw new AgentRunError('noExecutable', 'No Claude Code executable found on this machine; set its path in the agent settings');
	}

	if (input.mode === 'bypass' && !launch.settings.bypassAllowed) {
		throw new AgentRunError('bypassOff', 'Bypass mode is switched off in the agent settings');
	}

	if (input.model && !AGENT_MODEL_PATTERN.test(input.model)) {
		throw new AgentRunError('badModel', `Not a model id: ${input.model}`);
	}

	if (input.effort && !(AGENT_EFFORTS as readonly string[]).includes(input.effort)) {
		throw new AgentRunError('badModel', `Unknown effort level: ${input.effort}`);
	}

	const run = new Run(input.conversationId, input.owner);

	runs.set(input.conversationId, run);

	await appendAgentTurn(input.conversationId, input.owner, {
		entries: [{
			kind: 'user',
			at: Date.now(),
			author: input.owner,
			text: input.text,
			mode: input.mode,
			model: input.model || launch.settings.model,
			...(input.attachments?.length
				? { attachments: input.attachments.map(({ name, size }) => ({ name, size })) }
				: {})
		}],
		title: input.text
	});

	run.emit({ type: 'state', running: true });

	void drive(run, input, launch, executable.path, conversation.sessionId);
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

	const canUseTool: CanUseTool = async (toolName, toolInput, options) => {
		const name = stripPrefix(toolName);

		// only luna's tools exist; anything else reaching here is refused outright
		if (!toolName.startsWith(TOOL_PREFIX)) {
			return { behavior: 'deny', message: 'Only the luna tools are available.' };
		}

		// plan mode never changes anything; the refusal tells the model what to do instead
		if (input.mode === 'plan') {
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
		// the page is a hint about what "this" means, attached to the message rather
		// than the persona so a resumed session keeps it next to the words it explains
		const notes = [
			...(input.attachments ?? []).map(
				(file) => `<attachment id="${file.id}" name="${file.name.replace(/"/g, "'")}" bytes="${file.size}" />`
			),
			...(input.page ? [`<console-page>${input.page}</console-page>`] : [])
		];
		const prompt = notes.length
			? `${input.text}\n\n${notes.join('\n')}`
			: input.text;

		const stream = query({
			prompt,
			options: {
				systemPrompt: personaPrompt({
					operator: input.owner,
					machine: input.machine,
					extra: launch.settings.instructions,
					locale: input.locale,
					mode: input.mode
				}),
				model: input.model || launch.settings.model,
				effort: (input.effort || launch.settings.effort) as AgentEffort,
				maxTurns: launch.settings.maxTurns,
				tools: [],
				mcpServers: {
					[SERVER]: {
						type: 'http',
						url: `${input.origin}/api/mcp`,
						headers: { Authorization: `Bearer ${grant.bearer}` },
						alwaysLoad: true,
						timeout: TOOL_TIMEOUT_MS
					}
				},
				strictMcpConfig: true,
				allowedTools: launch.token.tools
					.filter((name) => runsUnasked(name, input.mode))
					.map((name) => `${TOOL_PREFIX}${name}`),
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

		for await (const message of stream) {
			const outcome = handleMessage(run, message, input.mode);

			if (outcome.sessionId) {
				sessionId = outcome.sessionId;
			}

			if (outcome.costUsd !== undefined) {
				costUsd = outcome.costUsd;
			}

			if (outcome.failed) {
				failed = true;
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
}

function handleMessage(run: Run, message: SDKMessage, mode: AgentMode): MessageOutcome {
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
							status: runsUnasked(name, mode)
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
			if (message.subtype === 'success' && !message.is_error) {
				return { costUsd: message.total_cost_usd };
			}

			if (message.subtype === 'error_max_turns') {
				run.entries.push({ kind: 'error', at: Date.now(), text: '#maxTurns' });
				run.emit({ type: 'error', text: 'Stopped at the turn limit.', code: 'maxTurns' });

				return { costUsd: message.total_cost_usd, failed: true };
			}

			const text = message.subtype === 'success'
				? message.result || 'The model returned an error.'
				: message.subtype.replace(/_/g, ' ');

			run.entries.push({ kind: 'error', at: Date.now(), text });
			run.emit({ type: 'error', text });

			return { costUsd: message.total_cost_usd, failed: true };
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

/** Whether a conversation has a run in progress. */
export function isRunning(conversationId: string): boolean {
	return runs.get(conversationId)?.running ?? false;
}

/** Approve or deny a waiting tool call. Only the conversation's owner may. */
export function decideCall(conversationId: string, owner: string, toolUseId: string, allow: boolean): boolean {
	const run = runs.get(conversationId);

	if (!run || run.owner !== owner) {
		return false;
	}

	return run.decide(toolUseId, allow, owner);
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
