// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The browser side of Mèo Béo, in two parts.
 *
 * `Agent` is the shell every window shares: whether the docked panel is open
 * and how wide, the agent's status, the conversation list, and the picks this
 * browser last made (mode, model, effort, sharing the page).
 *
 * A `ChatSession` is one open chat: which conversation it shows, the messages
 * as they render, its stream and its attachments. The docked panel has one, the
 * full-page screen one per pane, and a popped-out window its own, so several
 * chats can be open and running at once without seeing each other's state.
 *
 * A run lives on the server. Sending a message only starts it (or, mid-run,
 * joins it); the answer comes back over `/api/agent/conversations/<id>/stream`,
 * which replays everything the run has done so far, so reopening a chat or
 * reloading mid-answer picks up where it was rather than losing the reply.
 */

import { browser } from '$app/environment';
import { api, del, patch, post } from '$lib/api';
import { currentLanguage } from '$lib/i18n.svelte';
import { AGENT_MODES, DEFAULT_AGENT_MODE, isAgentMode, isConsolePath, type AgentMode } from '$shared/agent';
import { goto } from '$app/navigation';

export type ToolStatus = 'running' | 'awaiting' | 'ok' | 'error' | 'denied';

export type ChatItem =
	| {
		kind: 'user';
		text: string;
		author: string;
		at: number;
		mode?: string;
		attachments?: Array<{ name: string; size: number }>;
	}
	| { kind: 'assistant'; text: string; streaming: boolean }
	| {
		kind: 'tool';
		id: string;
		name: string;
		input?: unknown;
		status: ToolStatus;
		output?: string;
		decidedBy?: string;
	}
	| { kind: 'error'; text: string; code?: string }
	/** A background task or a trigger reporting back; nobody's message */
	| { kind: 'event'; source: 'task' | 'trigger'; label: string; text: string; at: number }
	/** The session's history was summarised; `by` is absent when it did so on its own */
	| { kind: 'compact'; trigger: 'manual' | 'auto'; by?: string; preTokens: number; postTokens?: number; at: number };

/** How full a session's context was after its last response. */
export interface ContextUsage {
	tokens: number;
	/** Where the session compacts on its own */
	window: number;
	model: string;
	at: number;
}

export interface ConversationRow {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	costUsd: number;
	turns: number;
	running?: boolean;
	context?: ContextUsage;
	compactions?: number;
}

export interface AgentModelChoice {
	value: string;
	label: string;
	description: string;
}

export interface AgentState {
	credential: { kind: 'oauth' | 'apikey'; hint: string; setAt: number; setBy: string | null } | null;
	settings: {
		enabled: boolean;
		model: string;
		effort: string;
		instructions: string;
		maxTurns: number;
		executable: string;
		bypassAllowed: boolean;
	};
	token: { id: string; name: string; enabled: boolean; tools: string[] } | null;
	ready: boolean;
	reason: string | null;
	executable: { path?: string; source: string };
	models: AgentModelChoice[];
	modelsReported: boolean;
	efforts: string[];
	skills: Array<{ name: string; description: string }>;
}

interface StoredEntry {
	kind: 'user' | 'assistant' | 'tool' | 'error' | 'event' | 'compact';
	source?: 'task' | 'trigger';
	trigger?: 'manual' | 'auto';
	by?: string;
	preTokens?: number;
	postTokens?: number;
	label?: string;
	at: number;
	author?: string;
	text?: string;
	mode?: string;
	attachments?: Array<{ name: string; size: number }>;
	id?: string;
	name?: string;
	input?: unknown;
	status?: 'ok' | 'error' | 'denied';
	output?: string;
	decidedBy?: string;
}

type StreamEvent =
	| { type: 'state'; running: boolean }
	| { type: 'user'; text: string; author: string; at: number; mode: string; attachments?: Array<{ name: string; size: number }> }
	| { type: 'text'; delta: string }
	| { type: 'assistant'; text: string }
	| { type: 'tool'; id: string; name: string; input?: unknown; status: ToolStatus; output?: string; decidedBy?: string }
	| { type: 'screenshot'; id: string }
	| { type: 'navigate'; id: string; path: string }
	| { type: 'error'; text: string; code?: string }
	| { type: 'event'; source: 'task' | 'trigger'; label: string; text: string; at: number }
	| { type: 'context'; context: ContextUsage }
	| { type: 'compacting'; active: boolean }
	| { type: 'compact'; trigger: 'manual' | 'auto'; by?: string; preTokens: number; postTokens?: number; at: number }
	| { type: 'done'; costUsd: number }
	| { type: 'idle' }
	| { type: 'ping' };

const OPEN_KEY = 'luna:agent:open';
const WIDTH_KEY = 'luna:agent:width';
const CONVERSATION_KEY = 'luna:agent:conversation';
const MODE_KEY = 'luna:agent:mode';
const MODEL_KEY = 'luna:agent:model';
const EFFORT_KEY = 'luna:agent:effort';
const PAGE_KEY = 'luna:agent:sharePage';

/** The channel a popped-out chat asks the console windows over; see `startConsoleBridge` */
const BRIDGE_CHANNEL = 'luna:agent:bridge';

/** px; the panel is resized by dragging, which is measured in device pixels */
export const AGENT_MIN_WIDTH = 320;
export const AGENT_MAX_WIDTH = 760;
const DEFAULT_WIDTH = 420;

/** px; the size a popped-out chat window opens at */
const POPOUT_WIDTH = 560;
const POPOUT_HEIGHT = 820;

function readStored(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeStored(key: string, value: string | null): void {
	try {
		if (value === null) {
			localStorage.removeItem(key);
		} else {
			localStorage.setItem(key, value);
		}
	} catch {
		// a private window keeps no preferences; the panel still works
	}
}

/** Transcript entries as the panel shows them; an `#code` error is translated by the panel. */
function itemsFromEntries(entries: StoredEntry[]): ChatItem[] {
	const items: ChatItem[] = [];

	for (const entry of entries) {
		if (entry.kind === 'user') {
			items.push({
				kind: 'user',
				text: entry.text ?? '',
				author: entry.author ?? '',
				at: entry.at,
				mode: entry.mode,
				attachments: entry.attachments
			});
		} else if (entry.kind === 'assistant') {
			items.push({ kind: 'assistant', text: entry.text ?? '', streaming: false });
		} else if (entry.kind === 'event') {
			items.push({ kind: 'event', source: entry.source ?? 'task', label: entry.label ?? '', text: entry.text ?? '', at: entry.at });
		} else if (entry.kind === 'compact') {
			items.push({
				kind: 'compact',
				trigger: entry.trigger ?? 'auto',
				by: entry.by,
				preTokens: entry.preTokens ?? 0,
				postTokens: entry.postTokens,
				at: entry.at
			});
		} else if (entry.kind === 'tool') {
			items.push({
				kind: 'tool',
				id: entry.id ?? '',
				name: entry.name ?? '',
				input: entry.input,
				status: entry.status ?? 'ok',
				output: entry.output,
				decidedBy: entry.decidedBy
			});
		} else {
			const text = entry.text ?? '';

			items.push(
				text.startsWith('#')
					? { kind: 'error', text, code: text.slice(1) }
					: { kind: 'error', text }
			);
		}
	}

	return items;
}

export interface Attachment {
	/** Staged upload id; empty until the upload finishes */
	id: string;
	name: string;
	size: number;
	error?: string;
}

/**
 * Answer the agent's `console_screenshot` from this window: render the console
 * as it shows here, without the docked panel, and post it to the run. Every
 * window that tries races; the first upload wins and the rest are refused.
 */
async function uploadScreenshot(conversation: string, requestId: string): Promise<void> {
	try {
		const { captureConsole } = await import('$lib/screenshot');
		const shot = await captureConsole(Agent.open ? Agent.width : 0);
		const query = new URLSearchParams({
			request: requestId,
			page: shot.page,
			w: String(shot.width),
			h: String(shot.height)
		});

		await fetch(`/api/agent/conversations/${encodeURIComponent(conversation)}/screenshot?${query}`, {
			method: 'POST',
			headers: { 'content-type': shot.image.type },
			body: shot.image
		});
	} catch (err) {
		// the run times out and tells the model; the console is the place to see why
		console.error('screenshot failed', err);
	}
}

/**
 * Answer the agent's `console_navigate` from this window: open the page as a
 * click would and report where it landed. The path is checked again here, so a
 * request can only ever move the operator between console screens.
 */
async function navigateFor(conversation: string, requestId: string, path: string): Promise<void> {
	let answer: { ok: boolean; page: string; error?: string };

	try {
		if (!isConsolePath(path)) {
			throw new Error('not a console page');
		}

		await goto(path);
		answer = { ok: true, page: `${location.pathname}${location.search}` };
	} catch (err) {
		answer = { ok: false, page: `${location.pathname}${location.search}`, error: (err as Error).message };
	}

	await post(`/agent/conversations/${conversation}/navigated`, { request: requestId, ...answer }).catch(() => {});
}

type BridgeRequest =
	| { type: 'screenshot'; conversation: string; request: string }
	| { type: 'navigate'; conversation: string; request: string; path: string };

/**
 * Let popped-out chats reach this console window. A pop-out has no console of
 * its own: a screenshot of it would show the chat, and navigating it would
 * replace the chat with a page. So it asks here instead, and the console the
 * operator is looking at answers; a hidden tab stays out of it, so a request
 * moves the screen in front of them rather than one in the background.
 * Returns the teardown.
 */
export function startConsoleBridge(): () => void {
	if (!browser || typeof BroadcastChannel === 'undefined') {
		return () => {};
	}

	const channel = new BroadcastChannel(BRIDGE_CHANNEL);

	channel.onmessage = (event: MessageEvent<BridgeRequest>) => {
		if (document.visibilityState !== 'visible') {
			return;
		}

		const request = event.data;

		if (request.type === 'screenshot') {
			void uploadScreenshot(request.conversation, request.request);
		} else if (request.type === 'navigate') {
			void navigateFor(request.conversation, request.request, request.path);
		}
	};

	return () => channel.close();
}

function relayToConsole(request: BridgeRequest): void {
	if (typeof BroadcastChannel === 'undefined') {
		return;
	}

	const channel = new BroadcastChannel(BRIDGE_CHANNEL);

	channel.postMessage(request);
	channel.close();
}

export interface ChatSessionOptions {
	/** Remember the conversation across reloads; only the docked panel does */
	persist?: boolean;

	/** Ask a console window to answer screenshots and navigation; a popped-out chat does */
	relay?: boolean;
}

export type SendResult = { ok: boolean; joined?: boolean; error?: string; code?: string };

/** One open chat; see the module comment. */
export class ChatSession {
	conversationId: string | null = $state(null);
	items: ChatItem[] = $state([]);
	running = $state(false);
	sending = $state(false);
	loading = $state(false);

	/** How tool calls are approved; see `shared/agent.ts` */
	mode: AgentMode = $state(DEFAULT_AGENT_MODE);

	/** Overrides of the settings for this chat; empty means "use the settings" */
	model = $state('');
	effort = $state('');

	/** Whether the page the operator has open goes along with each message */
	sharePage = $state(true);

	/** Files attached to the next message; `id` is empty while the upload runs */
	attachments: Attachment[] = $state([]);

	/** How full the session's context is, once a response has measured it */
	context: ContextUsage | null = $state(null);

	/** Whether a compaction was asked for or is running, until the session reports it */
	compacting = $state(false);

	readonly #persist: boolean;
	readonly #relay: boolean;
	#source: EventSource | null = null;
	/** Held open while the chat sits on an idle conversation, to hear of a run a trigger starts */
	#watch: EventSource | null = null;
	#disposed = false;

	constructor(options: ChatSessionOptions = {}) {
		this.#persist = options.persist ?? false;
		this.#relay = options.relay ?? false;
		this.mode = Agent.lastMode;
		this.model = Agent.lastModel;
		this.effort = Agent.lastEffort;
		this.sharePage = Agent.lastSharePage;
		Agent.register(this);
	}

	/** The conversation's row in the list, once it has one. */
	get row(): ConversationRow | null {
		return Agent.conversations.find((row) => row.id === this.conversationId) ?? null;
	}

	/** Stop following the run and leave the shell's registry; the chat's window is closing. */
	dispose(): void {
		this.#disposed = true;
		this.#detach();
		Agent.unregister(this);
	}

	setMode(mode: AgentMode): void {
		this.mode = mode;
		Agent.rememberMode(mode);
		void this.#updateRun();
	}

	/** The next mode for Shift+Tab, skipping bypass when the console has it switched off. */
	nextMode(): AgentMode {
		const modes = AGENT_MODES.filter((mode) => mode !== 'bypass' || Agent.state?.settings.bypassAllowed);
		const index = modes.indexOf(this.mode);

		return modes[(index + 1) % modes.length] ?? DEFAULT_AGENT_MODE;
	}

	setModel(model: string): void {
		this.model = model;
		Agent.rememberModel(model);
		void this.#updateRun();
	}

	setEffort(effort: string): void {
		this.effort = effort;
		Agent.rememberEffort(effort);
		void this.#updateRun();
	}

	setSharePage(share: boolean): void {
		this.sharePage = share;
		Agent.rememberSharePage(share);
	}

	/**
	 * Carry a pick over to the run going in this chat, as Claude Code does when
	 * the model or mode is switched mid-answer. The effective values are sent,
	 * so going back to "the settings' model" is a change too.
	 */
	async #updateRun(): Promise<void> {
		if (!this.running || !this.conversationId) {
			return;
		}

		const settings = Agent.state?.settings;

		await patch(`/agent/conversations/${this.conversationId}/run`, {
			mode: this.mode,
			model: this.model || settings?.model,
			effort: this.effort || settings?.effort
		}).catch(() => {});
	}

	/** Upload a file for the next message; it shows as a chip while it goes up. */
	async attach(file: File): Promise<void> {
		const pending: Attachment = { id: '', name: file.name, size: file.size };

		this.attachments = [...this.attachments, pending];

		try {
			const res = await fetch(`/api/agent/uploads?name=${encodeURIComponent(file.name)}`, {
				method: 'POST',
				headers: { 'content-type': 'application/octet-stream' },
				body: file
			});

			if (!res.ok) {
				throw new Error((await res.json().catch(() => ({}))).message ?? res.statusText);
			}

			const staged = (await res.json()) as { id: string; name: string; size: number };

			this.attachments = this.attachments.map((entry) => (entry === pending ? { ...staged } : entry));
		} catch (err) {
			this.attachments = this.attachments.map((entry) =>
				entry === pending ? { ...entry, error: (err as Error).message } : entry
			);
		}
	}

	detach(attachment: Attachment): void {
		this.attachments = this.attachments.filter((entry) => entry !== attachment);

		if (attachment.id) {
			void del(`/agent/uploads/${attachment.id}`).catch(() => {});
		}
	}

	#reset(id: string | null): void {
		this.#detach();
		this.conversationId = id;
		this.items = [];
		this.running = false;
		this.context = null;
		this.compacting = false;

		if (this.#persist) {
			writeStored(CONVERSATION_KEY, id);
		}
	}

	/** Show a conversation: its saved transcript, then its live run if one is going. */
	async select(id: string): Promise<void> {
		this.#reset(id);
		this.loading = true;

		try {
			const data = await api<{ conversation: { entries: StoredEntry[]; context?: ContextUsage }; running: boolean }>(
				`/agent/conversations/${id}`
			);

			if (this.conversationId !== id) {
				return;
			}

			this.items = itemsFromEntries(data.conversation.entries);
			this.context = data.conversation.context ?? null;

			// an idle chat still has to hear of a run a background task or trigger starts
			if (data.running) {
				this.running = true;
				this.#attach(id);
			} else {
				this.#awaitNextRun(id);
			}
		} finally {
			this.loading = false;
		}
	}

	/** Start over in a fresh conversation; created on the server only when the first message is sent. */
	newChat(): void {
		this.#reset(null);
	}

	/**
	 * Send a message. With nothing running it starts a run and shows the message
	 * at once; mid-run it joins the run, and the message appears when the run
	 * echoes it, which is also how every other window following it sees it.
	 */
	async send(text: string, page?: string): Promise<SendResult> {
		const message = text.trim();
		const files = this.attachments.filter((file) => file.id && !file.error);

		if ((!message && files.length === 0) || this.sending) {
			return { ok: false };
		}

		// typed as in Claude Code; what follows the command is the focus
		const command = /^\/compact(?:\s+([\s\S]*))?$/.exec(message);

		if (command && files.length === 0) {
			return await this.compact(command[1] ?? '');
		}

		if (this.attachments.some((file) => !file.id && !file.error)) {
			return { ok: false };
		}

		const joining = this.running;

		this.sending = true;

		try {
			let id = this.conversationId;

			if (!id) {
				const created = await post<{ conversation: ConversationRow }>('/agent/conversations', {});

				id = created.conversation.id;
				this.conversationId = id;

				if (this.#persist) {
					writeStored(CONVERSATION_KEY, id);
				}
			}

			if (!joining) {
				this.items = [
					...this.items,
					{
						kind: 'user',
						text: message,
						author: '',
						at: Date.now(),
						mode: this.mode,
						attachments: files.length ? files.map(({ name, size }) => ({ name, size })) : undefined
					}
				];
			}

			this.attachments = [];

			const settings = Agent.state?.settings;
			const result = await post<SendResult>(
				`/agent/conversations/${id}/messages`,
				{
					text: message,
					locale: currentLanguage(),
					mode: this.mode,
					model: this.model || (joining ? settings?.model : undefined),
					effort: this.effort || (joining ? settings?.effort : undefined),
					page: this.sharePage ? page : undefined,
					attachments: files
				}
			).catch((err: Error): SendResult => ({ ok: false, error: err.message }));

			if (!result.ok) {
				this.items = [...this.items, { kind: 'error', text: result.error ?? '', code: result.code }];

				return result;
			}

			// the run ended just before the message reached it, so it started a new
			// one, whose first message is not echoed: show it here after all
			if (joining && !result.joined) {
				this.items = [
					...this.items,
					{
						kind: 'user',
						text: message,
						author: '',
						at: Date.now(),
						mode: this.mode,
						attachments: files.length ? files.map(({ name, size }) => ({ name, size })) : undefined
					}
				];
			}

			if (!joining || !result.joined || !this.#source) {
				this.running = true;
				this.#attach(id);
			}

			void Agent.loadConversations();

			return result;
		} finally {
			this.sending = false;
		}
	}

	/** Allow or deny a waiting call; `answers` answers a question the agent asked. */
	async decide(toolUseId: string, allow: boolean, tool: string, answers?: Record<string, string>): Promise<void> {
		if (!this.conversationId) {
			return;
		}

		await post(`/agent/conversations/${this.conversationId}/approve`, { toolUseId, allow, tool, ...(answers ? { answers } : {}) });
	}

	/**
	 * Summarise the conversation's history so far, keeping what `focus` names.
	 * Mid-answer it waits its turn in the run; otherwise it starts a run that
	 * does only that. The result arrives on the stream as a compact row.
	 */
	async compact(focus = ''): Promise<SendResult> {
		const id = this.conversationId;

		if (this.compacting || this.sending) {
			return { ok: false };
		}

		if (!id) {
			this.items = [...this.items, { kind: 'error', text: '', code: 'nothingToCompact' }];

			return { ok: false, code: 'nothingToCompact' };
		}

		const joining = this.running;
		const settings = Agent.state?.settings;

		this.compacting = true;

		const result = await post<SendResult>(`/agent/conversations/${id}/compact`, {
			focus: focus.trim(),
			locale: currentLanguage(),
			mode: this.mode,
			model: this.model || (joining ? settings?.model : undefined),
			effort: this.effort || (joining ? settings?.effort : undefined)
		}).catch((err: Error): SendResult => ({ ok: false, error: err.message }));

		if (!result.ok) {
			this.compacting = false;
			this.items = [...this.items, { kind: 'error', text: result.error ?? '', code: result.code }];

			return result;
		}

		if (!result.joined || !this.#source) {
			this.running = true;
			this.#attach(id);
		}

		return result;
	}

	async stop(): Promise<void> {
		if (!this.conversationId) {
			return;
		}

		await post(`/agent/conversations/${this.conversationId}/stop`);
	}

	#detach(): void {
		this.#source?.close();
		this.#source = null;
		this.#watch?.close();
		this.#watch = null;
	}

	/**
	 * Listen for the next run in this conversation: a finished background task
	 * or a fired trigger starts one with nobody typing, and this chat should
	 * show it as it happens rather than on the next reload.
	 */
	#awaitNextRun(id: string): void {
		if (this.#disposed || this.conversationId !== id) {
			return;
		}

		this.#watch?.close();

		const watch = new EventSource(`/api/agent/conversations/${id}/watch`);

		this.#watch = watch;

		watch.onmessage = (event) => {
			const data = JSON.parse(event.data) as { type: string };

			if (data.type !== 'run') {
				return;
			}

			watch.close();

			if (this.#watch === watch) {
				this.#watch = null;
			}

			if (this.conversationId === id && !this.#disposed && !this.#source) {
				this.running = true;
				this.#attach(id);
			}
		};

		// the browser re-opens an EventSource on its own after a drop; only a closed one is given up
		watch.onerror = () => {
			if (watch.readyState === EventSource.CLOSED && this.#watch === watch) {
				this.#watch = null;
			}
		};
	}

	#attach(id: string): void {
		this.#detach();

		const source = new EventSource(`/api/agent/conversations/${id}/stream`);
		let finished = false;

		this.#source = source;

		source.onmessage = (event) => {
			if (this.conversationId !== id || this.#disposed) {
				source.close();

				return;
			}

			const data = JSON.parse(event.data) as StreamEvent;

			if (data.type === 'done' || data.type === 'idle') {
				finished = true;
			}

			this.#apply(data, id);
		};

		// the server closes the stream after `done`, which EventSource reports as an
		// error too; only a drop mid-run is worth re-attaching for
		source.onerror = () => {
			source.close();

			if (this.#source === source) {
				this.#source = null;
			}

			if (!finished && this.conversationId === id) {
				setTimeout(() => {
					if (this.conversationId === id && !this.#disposed) {
						void this.select(id);
					}
				}, 2000);
			}
		};
	}

	#lastStreaming(): number {
		for (let index = this.items.length - 1; index >= 0; index--) {
			const item = this.items[index]!;

			if (item.kind === 'assistant' && item.streaming) {
				return index;
			}

			if (item.kind !== 'assistant') {
				return -1;
			}
		}

		return -1;
	}

	#apply(event: StreamEvent, conversation: string): void {
		switch (event.type) {
			case 'user': {
				this.items.push({
					kind: 'user',
					text: event.text,
					author: event.author,
					at: event.at,
					mode: event.mode,
					attachments: event.attachments
				});

				break;
			}

			case 'text': {
				const index = this.#lastStreaming();

				if (index === -1) {
					this.items.push({ kind: 'assistant', text: event.delta, streaming: true });
				} else {
					const item = this.items[index] as Extract<ChatItem, { kind: 'assistant' }>;

					item.text += event.delta;
				}

				break;
			}

			case 'assistant': {
				const index = this.#lastStreaming();

				if (index === -1) {
					this.items.push({ kind: 'assistant', text: event.text, streaming: false });
				} else {
					this.items[index] = { kind: 'assistant', text: event.text, streaming: false };
				}

				break;
			}

			case 'screenshot': {
				if (this.#relay) {
					relayToConsole({ type: 'screenshot', conversation, request: event.id });
				} else {
					void uploadScreenshot(conversation, event.id);
				}

				break;
			}

			case 'navigate': {
				if (this.#relay) {
					relayToConsole({ type: 'navigate', conversation, request: event.id, path: event.path });
				} else {
					void navigateFor(conversation, event.id, event.path);
				}

				break;
			}

			case 'tool': {
				const existing = this.items.find(
					(item): item is Extract<ChatItem, { kind: 'tool' }> => item.kind === 'tool' && item.id === event.id
				);

				if (existing) {
					existing.status = event.status;

					if (event.input !== undefined) {
						existing.input = event.input;
					}

					if (event.output !== undefined) {
						existing.output = event.output;
					}

					if (event.decidedBy !== undefined) {
						existing.decidedBy = event.decidedBy;
					}
				} else {
					this.items.push({
						kind: 'tool',
						id: event.id,
						name: event.name,
						input: event.input,
						status: event.status,
						output: event.output,
						decidedBy: event.decidedBy
					});
				}

				break;
			}

			case 'error':
				this.items.push({ kind: 'error', text: event.text, code: event.code });
				break;

			case 'event':
				this.items.push({ kind: 'event', source: event.source, label: event.label, text: event.text, at: event.at });
				break;

			case 'context':
				this.context = event.context;
				break;

			case 'compacting':
				this.compacting = event.active;
				break;

			case 'compact':
				this.compacting = false;
				this.items.push({
					kind: 'compact',
					trigger: event.trigger,
					by: event.by,
					preTokens: event.preTokens,
					postTokens: event.postTokens,
					at: event.at
				});
				break;

			case 'state':
				this.running = event.running;
				break;

			case 'done':
			case 'idle':
				this.running = false;
				this.compacting = false;

				for (const item of this.items) {
					if (item.kind === 'assistant') {
						item.streaming = false;
					}
				}

				void Agent.loadConversations();
				this.#awaitNextRun(conversation);
				break;

			default:
				break;
		}
	}
}

class AgentShell {
	open = $state(false);
	width = $state(DEFAULT_WIDTH);

	state: AgentState | null = $state(null);
	conversations: ConversationRow[] = $state([]);

	/** The picks this browser made last; a new chat starts from them */
	lastMode: AgentMode = DEFAULT_AGENT_MODE;
	lastModel = '';
	lastEffort = '';
	lastSharePage = true;

	#sessions = new Set<ChatSession>();
	#panel: ChatSession | null = null;
	#booted = false;

	/** The docked panel's chat; created on first use, so it starts from the stored picks. */
	get panel(): ChatSession {
		this.#readPicks();
		this.#panel ??= new ChatSession({ persist: true });

		return this.#panel;
	}

	register(session: ChatSession): void {
		this.#sessions.add(session);
	}

	unregister(session: ChatSession): void {
		this.#sessions.delete(session);
	}

	/** Read the remembered panel state; called once the browser is there. */
	boot(): void {
		if (!browser || this.#booted) {
			return;
		}

		this.#booted = true;
		this.open = readStored(OPEN_KEY) === '1';

		const width = Number(readStored(WIDTH_KEY));

		if (width >= AGENT_MIN_WIDTH && width <= AGENT_MAX_WIDTH) {
			this.width = width;
		}

		if (this.open) {
			void this.refresh();
		}
	}

	#picksRead = false;

	#readPicks(): void {
		if (!browser || this.#picksRead) {
			return;
		}

		this.#picksRead = true;

		const mode = readStored(MODE_KEY);

		if (isAgentMode(mode)) {
			this.lastMode = mode;
		}

		this.lastModel = readStored(MODEL_KEY) ?? '';
		this.lastEffort = readStored(EFFORT_KEY) ?? '';
		this.lastSharePage = readStored(PAGE_KEY) !== '0';
	}

	rememberMode(mode: AgentMode): void {
		this.lastMode = mode;
		writeStored(MODE_KEY, mode);
	}

	rememberModel(model: string): void {
		this.lastModel = model;
		writeStored(MODEL_KEY, model || null);
	}

	rememberEffort(effort: string): void {
		this.lastEffort = effort;
		writeStored(EFFORT_KEY, effort || null);
	}

	rememberSharePage(share: boolean): void {
		this.lastSharePage = share;
		writeStored(PAGE_KEY, share ? '1' : '0');
	}

	toggle(): void {
		this.setOpen(!this.open);
	}

	setOpen(open: boolean): void {
		this.open = open;
		writeStored(OPEN_KEY, open ? '1' : '0');

		if (open) {
			void this.refresh();
		}
	}

	setWidth(width: number): void {
		this.width = Math.round(Math.min(Math.max(width, AGENT_MIN_WIDTH), AGENT_MAX_WIDTH));
		writeStored(WIDTH_KEY, String(this.width));
	}

	/** Reload status and the conversation list, then the panel's conversation. */
	async refresh(): Promise<void> {
		try {
			await this.loadAll();

			const panel = this.panel;
			const stored = panel.conversationId ?? readStored(CONVERSATION_KEY);
			const current = stored && this.conversations.some((row) => row.id === stored)
				? stored
				: null;

			if (current) {
				await panel.select(current);
			} else {
				panel.newChat();
			}
		} catch {
			// the panel shows its own empty state; a failed load is retried on reopen
		}
	}

	/** Status and the conversation list, without touching any chat. */
	async loadAll(): Promise<void> {
		this.#readPicks();

		const [state, list] = await Promise.all([
			api<AgentState>('/agent'),
			api<{ conversations: ConversationRow[] }>('/agent/conversations')
		]);

		this.state = state;
		this.conversations = list.conversations;
	}

	async reloadState(): Promise<void> {
		this.state = await api<AgentState>('/agent');
	}

	async loadConversations(): Promise<void> {
		const list = await api<{ conversations: ConversationRow[] }>('/agent/conversations');

		this.conversations = list.conversations;
	}

	async rename(id: string, title: string): Promise<void> {
		await patch(`/agent/conversations/${id}`, { title });
		await this.loadConversations();
	}

	/** Delete a conversation; every chat in this window showing it starts over. */
	async remove(id: string): Promise<void> {
		await del(`/agent/conversations/${id}`);

		for (const session of this.#sessions) {
			if (session.conversationId === id) {
				session.newChat();
			}
		}

		await this.loadConversations();
	}

	/**
	 * Open a chat in a window of its own. Each conversation gets one named
	 * window, so popping the same chat out twice brings the first one forward
	 * rather than opening a second copy; a new chat gets a fresh window.
	 */
	popOut(conversationId: string | null): void {
		const path = conversationId
			? `/agent/window?c=${encodeURIComponent(conversationId)}`
			: '/agent/window';
		const name = conversationId
			? `meo-beo-${conversationId}`
			: `meo-beo-new-${Date.now()}`;

		window.open(path, name, `popup,width=${POPOUT_WIDTH},height=${POPOUT_HEIGHT}`);
	}
}

/** The one agent shell every chat and the chrome share. */
export const Agent = new AgentShell();
