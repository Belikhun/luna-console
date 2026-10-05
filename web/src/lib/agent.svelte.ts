// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The browser side of Mèo Béo: whether the panel is open, which conversation
 * it shows, and the chat as the panel renders it, kept in one place so the
 * navbar button and the panel agree.
 *
 * A run lives on the server. Sending a message only starts it; the answer comes
 * back over `/api/agent/conversations/<id>/stream`, which replays everything the
 * run has done so far, so reopening the panel or reloading mid-answer picks up
 * where it was rather than losing the reply.
 */

import { browser } from '$app/environment';
import { api, del, patch, post } from '$lib/api';
import { currentLanguage } from '$lib/i18n.svelte';
import { AGENT_MODES, DEFAULT_AGENT_MODE, isAgentMode, type AgentMode } from '$shared/agent';

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
	| { kind: 'error'; text: string; code?: string };

export interface ConversationRow {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	costUsd: number;
	turns: number;
	running?: boolean;
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
	kind: 'user' | 'assistant' | 'tool' | 'error';
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
	| { type: 'text'; delta: string }
	| { type: 'assistant'; text: string }
	| { type: 'tool'; id: string; name: string; input?: unknown; status: ToolStatus; output?: string; decidedBy?: string }
	| { type: 'error'; text: string; code?: string }
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

/** px; the panel is resized by dragging, which is measured in device pixels */
export const AGENT_MIN_WIDTH = 320;
export const AGENT_MAX_WIDTH = 760;
const DEFAULT_WIDTH = 420;

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

class AgentStore {
	open = $state(false);
	width = $state(DEFAULT_WIDTH);

	state: AgentState | null = $state(null);
	conversations: ConversationRow[] = $state([]);
	conversationId: string | null = $state(null);
	items: ChatItem[] = $state([]);
	running = $state(false);
	sending = $state(false);
	loading = $state(false);

	/** How tool calls are approved; see `shared/agent.ts` */
	mode: AgentMode = $state(DEFAULT_AGENT_MODE);

	/** Per-browser overrides of the settings; empty means "use the settings" */
	model = $state('');
	effort = $state('');

	/** Whether the page the operator has open goes along with each message */
	sharePage = $state(true);

	/** Files attached to the next message; `id` is empty while the upload runs */
	attachments: Attachment[] = $state([]);

	#source: EventSource | null = null;
	#booted = false;

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

		this.conversationId = readStored(CONVERSATION_KEY);

		const mode = readStored(MODE_KEY);

		if (isAgentMode(mode)) {
			this.mode = mode;
		}

		this.model = readStored(MODEL_KEY) ?? '';
		this.effort = readStored(EFFORT_KEY) ?? '';
		this.sharePage = readStored(PAGE_KEY) !== '0';

		if (this.open) {
			void this.refresh();
		}
	}

	toggle(): void {
		this.setOpen(!this.open);
	}

	setOpen(open: boolean): void {
		this.open = open;
		writeStored(OPEN_KEY, open ? '1' : '0');

		if (open) {
			void this.refresh();
		} else {
			this.#detach();
		}
	}

	setMode(mode: AgentMode): void {
		this.mode = mode;
		writeStored(MODE_KEY, mode);
	}

	/** The next mode for Shift+Tab, skipping bypass when the console has it switched off. */
	nextMode(): AgentMode {
		const modes = AGENT_MODES.filter((mode) => mode !== 'bypass' || this.state?.settings.bypassAllowed);
		const index = modes.indexOf(this.mode);

		return modes[(index + 1) % modes.length] ?? DEFAULT_AGENT_MODE;
	}

	setModel(model: string): void {
		this.model = model;
		writeStored(MODEL_KEY, model || null);
	}

	setEffort(effort: string): void {
		this.effort = effort;
		writeStored(EFFORT_KEY, effort || null);
	}

	setSharePage(share: boolean): void {
		this.sharePage = share;
		writeStored(PAGE_KEY, share ? '1' : '0');
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

	setWidth(width: number): void {
		this.width = Math.round(Math.min(Math.max(width, AGENT_MIN_WIDTH), AGENT_MAX_WIDTH));
		writeStored(WIDTH_KEY, String(this.width));
	}

	/** Reload status and the conversation list, then the open conversation. */
	async refresh(): Promise<void> {
		this.loading = true;

		try {
			const [state, list] = await Promise.all([
				api<AgentState>('/agent'),
				api<{ conversations: ConversationRow[] }>('/agent/conversations')
			]);

			this.state = state;
			this.conversations = list.conversations;

			const current = this.conversationId && list.conversations.some((row) => row.id === this.conversationId)
				? this.conversationId
				: null;

			if (current) {
				await this.select(current);
			} else {
				this.#reset(null);
			}
		} catch {
			// the panel shows its own empty state; a failed load is retried on reopen
		} finally {
			this.loading = false;
		}
	}

	async reloadState(): Promise<void> {
		this.state = await api<AgentState>('/agent');
	}

	async loadConversations(): Promise<void> {
		const list = await api<{ conversations: ConversationRow[] }>('/agent/conversations');

		this.conversations = list.conversations;
	}

	#reset(id: string | null): void {
		this.#detach();
		this.conversationId = id;
		this.items = [];
		this.running = false;
		writeStored(CONVERSATION_KEY, id);
	}

	/** Show a conversation: its saved transcript, then its live run if one is going. */
	async select(id: string): Promise<void> {
		this.#reset(id);

		const data = await api<{ conversation: { entries: StoredEntry[] }; running: boolean }>(
			`/agent/conversations/${id}`
		);

		if (this.conversationId !== id) {
			return;
		}

		this.items = itemsFromEntries(data.conversation.entries);

		if (data.running) {
			this.running = true;
			this.#attach(id);
		}
	}

	/** Start over in a fresh conversation; created on the server only when the first message is sent. */
	newChat(): void {
		this.#reset(null);
	}

	async send(text: string, page?: string): Promise<{ ok: boolean; error?: string; code?: string }> {
		const message = text.trim();
		const files = this.attachments.filter((file) => file.id && !file.error);

		if ((!message && files.length === 0) || this.running || this.sending) {
			return { ok: false };
		}

		if (this.attachments.some((file) => !file.id && !file.error)) {
			return { ok: false };
		}

		this.sending = true;

		try {
			let id = this.conversationId;

			if (!id) {
				const created = await post<{ conversation: ConversationRow }>('/agent/conversations', {});

				id = created.conversation.id;
				this.conversationId = id;
				writeStored(CONVERSATION_KEY, id);
			}

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
			this.attachments = [];

			const result = await post<{ ok: boolean; error?: string; code?: string }>(
				`/agent/conversations/${id}/messages`,
				{
					text: message,
					locale: currentLanguage(),
					mode: this.mode,
					model: this.model || undefined,
					effort: this.effort || undefined,
					page: this.sharePage ? page : undefined,
					attachments: files
				}
			).catch((err: Error) => ({ ok: false, error: err.message, code: undefined }));

			if (!result.ok) {
				this.items = [...this.items, { kind: 'error', text: result.error ?? '', code: result.code }];

				return result;
			}

			this.running = true;
			this.#attach(id);
			void this.loadConversations();

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

	async stop(): Promise<void> {
		if (!this.conversationId) {
			return;
		}

		await post(`/agent/conversations/${this.conversationId}/stop`);
	}

	async rename(id: string, title: string): Promise<void> {
		await patch(`/agent/conversations/${id}`, { title });
		await this.loadConversations();
	}

	async remove(id: string): Promise<void> {
		await del(`/agent/conversations/${id}`);

		if (this.conversationId === id) {
			this.#reset(null);
		}

		await this.loadConversations();
	}

	#detach(): void {
		this.#source?.close();
		this.#source = null;
	}

	#attach(id: string): void {
		this.#detach();

		const source = new EventSource(`/api/agent/conversations/${id}/stream`);
		let finished = false;

		this.#source = source;

		source.onmessage = (event) => {
			if (this.conversationId !== id) {
				source.close();

				return;
			}

			const data = JSON.parse(event.data) as StreamEvent;

			if (data.type === 'done' || data.type === 'idle') {
				finished = true;
			}

			this.#apply(data);
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
					if (this.conversationId === id && this.open) {
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

	#apply(event: StreamEvent): void {
		switch (event.type) {
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

			case 'state':
				this.running = event.running;
				break;

			case 'done':
			case 'idle':
				this.running = false;

				for (const item of this.items) {
					if (item.kind === 'assistant') {
						item.streaming = false;
					}
				}

				void this.loadConversations();
				break;

			default:
				break;
		}
	}
}

/** The one agent store the chrome and the panel share. */
export const Agent = new AgentStore();
