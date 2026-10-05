// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Mèo Béo, the console's chat agent: the credential it runs on, its settings,
 * the MCP token it acts through, and the conversations people have with it.
 *
 * The agent itself runs in the console's server (it is a Claude Agent SDK
 * subprocess the console spawns), so this module only keeps its state. Two
 * decisions shape that state:
 *
 * - **It acts through an ordinary MCP token.** Every tool call goes through the
 *   console's own `/api/mcp`, so the token's scope is the agent's authorization,
 *   each call lands in the MCP call log, and its memories are knowledge items in
 *   that token's scope, managed on the knowledge screen like any other. The
 *   token's secret is never used: the console presents a per-run bearer it holds
 *   only in memory.
 * - **The credential is write-only.** A pasted Claude token or API key is never
 *   returned by a read; `agentLaunch` is the one path it leaves the daemon, to
 *   start the subprocess, the same trust boundary as `revealAndRecord`.
 *
 * Both stores are primary-local and never mirrored, like `sessions.json`: the
 * console only runs beside the primary. `agent.json` holds the credential, the
 * settings and the conversation index; each transcript is its own file under
 * `.data/agent/`, so a long conversation never rewrites the others.
 */

import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { t } from "../shared/i18n";
import { MCP_DEFAULT_GROUPS, type McpScope } from "../shared/mcptools";
import { dataDir, statePath } from "./config";
import { appendJournal } from "./journal";
import { createMcpToken, getMcpToken, type McpTokenSummary } from "./mcp";
import { newId } from "./secrets";

const STORE_FILE = "agent.json";

/** The MCP token the agent acts through is created under this name. */
export const AGENT_TOKEN_NAME = "meo-beo";

/** Conversations one account keeps; the oldest are dropped past it. */
export const MAX_AGENT_CONVERSATIONS = 100;

/** Transcript entries kept per conversation; older ones fall off the front. */
export const MAX_AGENT_ENTRIES = 1_000;

/** Longest tool output a transcript keeps; the model saw all of it, a reader needs the gist. */
export const MAX_AGENT_TOOL_OUTPUT = 4 * 1024;

/** Longest message an operator may send in one turn. */
export const MAX_AGENT_MESSAGE = 16 * 1024;

/**
 * The models offered before a connection test has asked the SDK which ones the
 * credential can use; the first is the default. Any well-formed id is accepted
 * (`AGENT_MODEL_PATTERN`), so a model released after this build still works.
 */
export const AGENT_MODELS = [
	"claude-sonnet-5-5",
	"claude-opus-5-5",
	"claude-fable-5-1",
	"claude-haiku-4-5-20251001",
	"claude-sonnet-5",
	"claude-opus-5",
] as const;

/** A model id or alias the SDK may resolve (`sonnet`, `claude-opus-5-5[1m]`). */
export const AGENT_MODEL_PATTERN = /^[a-z0-9][a-z0-9.\-]{0,79}(\[[a-z0-9]+\])?$/;

/** How hard the model thinks, as the SDK names the levels. */
export const AGENT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type AgentEffort = typeof AGENT_EFFORTS[number];

export type AgentCredentialKind = "oauth" | "apikey";

interface StoredCredential {
	kind: AgentCredentialKind;
	value: string;
	setAt: number;
	setBy?: string;
}

export interface AgentSettings {
	enabled: boolean;
	model: string;
	effort: AgentEffort;
	/** Appended to the built-in persona; how this cluster wants the agent to behave */
	instructions: string;
	/** Model turns one message may take before the run is stopped */
	maxTurns: number;
	/** Path to a Claude Code executable; empty means find one */
	executable: string;
	/** Whether anyone may pick bypass mode, where tool calls run without approval */
	bypassAllowed: boolean;
}

export interface AgentConversation {
	id: string;
	owner: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	/** The SDK session to resume, once the first turn has run */
	sessionId?: string;
	/** Estimated spend across every turn, in USD, as the SDK reports it */
	costUsd: number;
	turns: number;
}

/** A model as the SDK described it to the last connection test. */
export interface AgentModelChoice {
	value: string;
	label: string;
	description: string;
}

interface AgentStore {
	credential?: StoredCredential;
	settings: AgentSettings;
	/** What the last successful connection test said the credential can use */
	models?: AgentModelChoice[];
	tokenId?: string;
	conversations: AgentConversation[];
}

export type AgentEntry =
	| {
		kind: "user";
		at: number;
		author: string;
		text: string;
		mode?: string;
		model?: string;
		/** Files attached to the message, by name; the bytes were staged, not kept */
		attachments?: Array<{ name: string; size: number }>;
	}
	| { kind: "assistant"; at: number; text: string }
	| {
		kind: "tool";
		at: number;
		id: string;
		name: string;
		input: unknown;
		status: "ok" | "error" | "denied";
		output?: string;
		/** Who approved or denied it, when it needed approval */
		decidedBy?: string;
	}
	| { kind: "error"; at: number; text: string };

export interface AgentTranscript extends AgentConversation {
	entries: AgentEntry[];
}

/** What every reader sees: the credential described, never shown. */
export interface AgentStatus {
	credential: { kind: AgentCredentialKind; hint: string; setAt: number; setBy: string | null } | null;
	settings: AgentSettings;
	token: McpTokenSummary | null;
	/** The models the credential offered on the last connection test; null until one ran */
	models: AgentModelChoice[] | null;
	/** Whether a message can be sent right now, and if not, why */
	ready: boolean;
	reason: string | null;
}

/** What the console needs to start one run; the credential is in `env`. */
export interface AgentLaunch {
	env: Record<string, string>;
	settings: AgentSettings;
	token: McpTokenSummary;
	/** Where the subprocess keeps its own state, apart from any operator's ~/.claude */
	home: string;
}

export interface AgentSettingsPatch {
	enabled?: boolean;
	model?: string;
	effort?: AgentEffort;
	instructions?: string;
	maxTurns?: number;
	executable?: string;
	bypassAllowed?: boolean;
}

/** The token a fresh agent gets: it reads, operates instances, manages addons and remembers. Files, shells and config stay off. */
const AGENT_SCOPE: McpScope = {
	groups: [...new Set([...MCP_DEFAULT_GROUPS, "control" as const, "addons" as const, "addons-write" as const, "knowledge-write" as const])],
	allow: [],
	deny: [],
	instances: null,
};

const MAX_TURNS_CEILING = 100;

const MAX_INSTRUCTIONS = 8 * 1024;

function defaultSettings(): AgentSettings {
	return {
		enabled: true,
		model: AGENT_MODELS[0],
		effort: "medium",
		instructions: "",
		maxTurns: 30,
		executable: "",
		bypassAllowed: true,
	};
}

function storePath(): string {
	return statePath(STORE_FILE);
}

/** Transcripts sit beside the store, one file each. */
function transcriptsDir(): string {
	return join(dataDir(), "agent");
}

function transcriptPath(id: string): string {
	return join(transcriptsDir(), `${id}.json`);
}

async function loadStore(): Promise<AgentStore> {
	if (!existsSync(storePath())) {
		return { settings: defaultSettings(), conversations: [] };
	}

	const store: AgentStore = await Bun.file(storePath()).json();

	store.settings = { ...defaultSettings(), ...store.settings };
	store.conversations ??= [];

	return store;
}

/** Not announced through `notifySave`; see the module header. */
async function saveStore(store: AgentStore): Promise<void> {
	await Bun.write(storePath(), JSON.stringify(store, null, "\t") + "\n");
}

let writeChain: Promise<unknown> = Promise.resolve();

/** Every read-modify-write goes through one chain; a run's save and a rename can land together. */
function serialized<T>(work: () => Promise<T>): Promise<T> {
	const next = writeChain.then(work, work);

	writeChain = next.catch(() => undefined);

	return next;
}

function credentialKind(value: string): AgentCredentialKind | null {
	if (value.startsWith("sk-ant-oat")) {
		return "oauth";
	}

	if (value.startsWith("sk-ant-api")) {
		return "apikey";
	}

	return null;
}

function hintOf(value: string): string {
	return `${value.slice(0, 10)}…${value.slice(-4)}`;
}

async function agentToken(store: AgentStore): Promise<McpTokenSummary | null> {
	if (!store.tokenId) {
		return null;
	}

	return (await getMcpToken(store.tokenId)) ?? null;
}

function notReadyReason(store: AgentStore, token: McpTokenSummary | null): string | null {
	if (!store.settings.enabled) {
		return t("core.agent.disabled");
	}

	if (!store.credential) {
		return t("core.agent.noCredential");
	}

	if (token && (!token.enabled || token.expired)) {
		return t("core.agent.tokenDisabled", { name: token.name });
	}

	return null;
}

/** The agent's state as every caller sees it: settings, its token, and the credential masked. */
export async function agentStatus(): Promise<AgentStatus> {
	const store = await loadStore();
	const token = await agentToken(store);
	const reason = notReadyReason(store, token);
	const credential = store.credential;

	return {
		credential: credential
			? { kind: credential.kind, hint: hintOf(credential.value), setAt: credential.setAt, setBy: credential.setBy ?? null }
			: null,
		settings: store.settings,
		token,
		models: store.models ?? null,
		ready: reason === null,
		reason,
	};
}

/**
 * Store the credential the agent runs on: a Claude subscription token from
 * `claude setup-token` (`sk-ant-oat…`) or an Anthropic API key (`sk-ant-api…`).
 * The value is never readable again; the journal records that it changed.
 */
export async function setAgentCredential(value: string, actor?: string): Promise<AgentStatus> {
	const trimmed = value.trim();
	const kind = credentialKind(trimmed);

	if (!kind || /\s/.test(trimmed) || trimmed.length > 512) {
		throw new Error(t("core.agent.badCredential"));
	}

	await serialized(async () => {
		const store = await loadStore();

		store.credential = { kind, value: trimmed, setAt: Date.now(), setBy: actor };
		delete store.models;
		await saveStore(store);
	});

	await appendJournal({ source: "agent", level: "info", message: `agent credential set (${kind})`, actor });

	return await agentStatus();
}

/**
 * Keep the model list a connection test reported, so the settings screen and the
 * panel offer what the credential can actually use. A new credential clears it.
 */
export async function recordAgentModels(models: AgentModelChoice[]): Promise<void> {
	await serialized(async () => {
		const store = await loadStore();

		store.models = models.slice(0, 50).map((model) => ({
			value: String(model.value).slice(0, 80),
			label: String(model.label).slice(0, 80),
			description: String(model.description ?? "").slice(0, 200),
		}));
		await saveStore(store);
	});
}

/** Forget the credential; the agent stops answering until a new one is pasted. */
export async function clearAgentCredential(actor?: string): Promise<AgentStatus> {
	await serialized(async () => {
		const store = await loadStore();

		delete store.credential;
		await saveStore(store);
	});

	await appendJournal({ source: "agent", level: "info", message: "agent credential removed", actor });

	return await agentStatus();
}

/** Change the agent's settings, each value validated before anything is written. */
export async function updateAgentSettings(patch: AgentSettingsPatch, actor?: string): Promise<AgentStatus> {
	await serialized(async () => {
		const store = await loadStore();
		const next = { ...store.settings };

		if (patch.enabled !== undefined) {
			next.enabled = !!patch.enabled;
		}

		if (patch.model !== undefined) {
			const model = patch.model.trim();

			if (!AGENT_MODEL_PATTERN.test(model)) {
				throw new Error(t("core.agent.badModel", { model }));
			}

			next.model = model;
		}

		if (patch.effort !== undefined) {
			if (!(AGENT_EFFORTS as readonly string[]).includes(patch.effort)) {
				throw new Error(t("core.agent.badEffort", { effort: String(patch.effort) }));
			}

			next.effort = patch.effort;
		}

		if (patch.instructions !== undefined) {
			if (patch.instructions.length > MAX_INSTRUCTIONS) {
				throw new Error(t("core.agent.instructionsTooLong", { max: MAX_INSTRUCTIONS }));
			}

			next.instructions = patch.instructions;
		}

		if (patch.maxTurns !== undefined) {
			const turns = Math.round(Number(patch.maxTurns));

			if (!Number.isFinite(turns) || turns < 1 || turns > MAX_TURNS_CEILING) {
				throw new Error(t("core.agent.badMaxTurns", { max: MAX_TURNS_CEILING }));
			}

			next.maxTurns = turns;
		}

		if (patch.executable !== undefined) {
			next.executable = patch.executable.trim();
		}

		if (patch.bypassAllowed !== undefined) {
			next.bypassAllowed = !!patch.bypassAllowed;
		}

		store.settings = next;
		await saveStore(store);
	});

	await appendJournal({
		source: "agent",
		level: "info",
		message: `agent settings changed: ${Object.keys(patch).join(", ")}`,
		actor,
	});

	return await agentStatus();
}

/**
 * The MCP token the agent acts through, created on first use. A token removed
 * on the MCP screen is recreated (read-only plus control and memory, the same
 * as the first time); one that is disabled stays disabled, because that is how
 * an operator switches the agent's hands off without touching anything else.
 */
export async function ensureAgentToken(actor?: string): Promise<McpTokenSummary> {
	return await serialized(async () => {
		const store = await loadStore();
		const existing = await agentToken(store);

		if (existing) {
			return existing;
		}

		// a token of that name left behind by an older store is adopted rather than duplicated
		const named = await getMcpToken(AGENT_TOKEN_NAME);
		const token = named ?? (await createMcpToken({
			name: AGENT_TOKEN_NAME,
			description: "Mèo Béo, the console's chat agent",
			scope: AGENT_SCOPE,
		}, actor)).token;

		store.tokenId = token.id;
		await saveStore(store);

		return token;
	});
}

/**
 * Everything one run needs, including the credential as environment for the
 * subprocess. The only path the credential leaves the daemon; never call it to
 * show anything.
 */
export async function agentLaunch(actor?: string): Promise<AgentLaunch> {
	const token = await ensureAgentToken(actor);
	const store = await loadStore();
	const reason = notReadyReason(store, token);

	if (reason || !store.credential) {
		throw new Error(reason ?? t("core.agent.noCredential"));
	}

	const env: Record<string, string> = store.credential.kind === "oauth"
		? { CLAUDE_CODE_OAUTH_TOKEN: store.credential.value }
		: { ANTHROPIC_API_KEY: store.credential.value };

	const home = join(transcriptsDir(), "claude");

	await mkdir(home, { recursive: true });

	return { env, settings: store.settings, token, home };
}

// -- conversations ---------------------------------------------------------------

function requireConversation(store: AgentStore, id: string, owner: string): AgentConversation {
	const conversation = store.conversations.find((entry) => entry.id === id && entry.owner === owner);

	if (!conversation) {
		throw new Error(t("core.agent.unknownConversation", { id }));
	}

	return conversation;
}

async function readEntries(id: string): Promise<AgentEntry[]> {
	if (!existsSync(transcriptPath(id))) {
		return [];
	}

	try {
		const data = await Bun.file(transcriptPath(id)).json();

		return Array.isArray(data.entries)
			? data.entries
			: [];
	} catch {
		return [];
	}
}

/** One account's conversations, newest first. Nobody reads anybody else's. */
export async function listAgentConversations(owner: string): Promise<AgentConversation[]> {
	const store = await loadStore();

	return store.conversations
		.filter((entry) => entry.owner === owner)
		.sort((left, right) => right.updatedAt - left.updatedAt);
}

/** One conversation with its transcript, or undefined when the owner has none by that id. */
export async function getAgentConversation(id: string, owner: string): Promise<AgentTranscript | undefined> {
	const store = await loadStore();
	const conversation = store.conversations.find((entry) => entry.id === id && entry.owner === owner);

	if (!conversation) {
		return undefined;
	}

	return { ...conversation, entries: await readEntries(id) };
}

/** Start an empty conversation, dropping the owner's oldest past the cap. */
export async function createAgentConversation(owner: string, title = ""): Promise<AgentConversation> {
	return await serialized(async () => {
		const store = await loadStore();
		const now = Date.now();

		const conversation: AgentConversation = {
			id: newId("chat"),
			owner,
			title: title.trim().slice(0, 120),
			createdAt: now,
			updatedAt: now,
			costUsd: 0,
			turns: 0,
		};

		store.conversations.push(conversation);

		const mine = store.conversations
			.filter((entry) => entry.owner === owner)
			.sort((left, right) => left.updatedAt - right.updatedAt);
		const excess = mine.slice(0, Math.max(0, mine.length - MAX_AGENT_CONVERSATIONS));

		for (const old of excess) {
			store.conversations = store.conversations.filter((entry) => entry !== old);
			await rm(transcriptPath(old.id), { force: true });
		}

		await saveStore(store);

		return conversation;
	});
}

function clipEntry(entry: AgentEntry): AgentEntry {
	if (entry.kind === "tool" && entry.output && entry.output.length > MAX_AGENT_TOOL_OUTPUT) {
		return { ...entry, output: `${entry.output.slice(0, MAX_AGENT_TOOL_OUTPUT)}\n… [truncated]` };
	}

	return entry;
}

export interface AgentTurnUpdate {
	entries: AgentEntry[];
	sessionId?: string;
	/** The SDK's running total for this run, added to the conversation's */
	costUsd?: number;
	/** Set on the first message, so the list has something to show */
	title?: string;
	/** Whether this update closes a turn (counted) or only saves progress */
	completed?: boolean;
}

/** Append a turn's entries to a transcript and update the index. */
export async function appendAgentTurn(id: string, owner: string, update: AgentTurnUpdate): Promise<AgentConversation> {
	return await serialized(async () => {
		const store = await loadStore();
		const conversation = requireConversation(store, id, owner);
		const entries = [...(await readEntries(id)), ...update.entries.map(clipEntry)].slice(-MAX_AGENT_ENTRIES);

		await mkdir(transcriptsDir(), { recursive: true });
		await Bun.write(transcriptPath(id), JSON.stringify({ id, entries }) + "\n");

		conversation.updatedAt = Date.now();

		if (update.sessionId) {
			conversation.sessionId = update.sessionId;
		}

		if (update.costUsd) {
			conversation.costUsd += update.costUsd;
		}

		if (update.completed) {
			conversation.turns += 1;
		}

		if (update.title && !conversation.title) {
			conversation.title = update.title.trim().replace(/\s+/g, " ").slice(0, 120);
		}

		await saveStore(store);

		return conversation;
	});
}

/** Rename a conversation. */
export async function renameAgentConversation(id: string, owner: string, title: string): Promise<AgentConversation> {
	return await serialized(async () => {
		const store = await loadStore();
		const conversation = requireConversation(store, id, owner);

		conversation.title = title.trim().slice(0, 120);
		await saveStore(store);

		return conversation;
	});
}

/** Delete a conversation and its transcript; returns what was removed. */
export async function removeAgentConversation(id: string, owner: string): Promise<AgentConversation> {
	return await serialized(async () => {
		const store = await loadStore();
		const conversation = requireConversation(store, id, owner);

		store.conversations = store.conversations.filter((entry) => entry !== conversation);
		await rm(transcriptPath(id), { force: true });
		await saveStore(store);

		return conversation;
	});
}
