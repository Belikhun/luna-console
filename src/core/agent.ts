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
import { getAccount } from "./accounts";
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
 * The models offered until an operator has refreshed the list from Anthropic
 * (`refreshAgentModels`) or run a connection test; the first is the default. Any
 * well-formed id is accepted (`AGENT_MODEL_PATTERN`), so a model released
 * after this build still works, and the fetched list replaces this one.
 */
export const AGENT_MODELS = [
	"claude-sonnet-5-5",
	"claude-opus-5-5",
	"claude-fable-5-1",
	"claude-haiku-5-5",
	"claude-sonnet-5",
	"claude-opus-5",
] as const;

/** The Models API pages at most this many per request. */
const MODELS_PAGE_LIMIT = 1000;

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

/**
 * A helper the agent may hand a self-contained job to, as Claude Code's
 * subagents: its own instructions and a narrower set of luna tools, working in
 * a context of its own and reporting back one answer. Tools are catalog names
 * or `group:<name>`; whatever the agent's token cannot reach is dropped.
 */
export interface AgentSubagent {
	name: string;
	/** When the agent should reach for it; the model reads this to decide */
	description: string;
	prompt: string;
	tools: string[];
	/** A model id or alias; empty runs it on the conversation's model */
	model: string;
	enabled: boolean;
}

export interface AgentSettings {
	enabled: boolean;
	model: string;
	effort: AgentEffort;
	/** Appended to the built-in persona; how this cluster wants the agent to behave */
	instructions: string;
	/** Model turns one message may take before the run is stopped */
	maxTurns: number;
	/** Attachments up to this many megabytes are also copied into the conversation's scratch folder, where the file tools reach them; the panel never accepts less than this */
	scratchAttachmentMb: number;
	/** Path to a Claude Code executable; empty means find one */
	executable: string;
	/** Whether anyone may pick bypass mode, where tool calls run without approval */
	bypassAllowed: boolean;
	/** Whether the agent offers a likely next message after each answer (a small extra request) */
	suggestions: boolean;
	/** Helpers defined on this console, beside the built-in ones */
	subagents: AgentSubagent[];
}

/**
 * Who else may open a conversation. A viewer reads it and follows its runs; a
 * collaborator may also write in it. Nobody acts on another account's
 * authority: a message runs as whoever sent it, so a collaborator's message
 * waits for the run going to end rather than joining it.
 */
export const AGENT_SHARE_ROLES = ["viewer", "collaborator"] as const;

export type AgentShareRole = typeof AGENT_SHARE_ROLES[number];

/** What an account is to one conversation. */
export type AgentRole = "owner" | AgentShareRole;

export interface AgentShare {
	account: string;
	role: AgentShareRole;
	at: number;
	by: string;
}

/** Accounts one conversation may be shared with. */
export const MAX_AGENT_SHARES = 20;

/** Custom helpers one console may define. */
export const MAX_AGENT_SUBAGENTS = 20;

/** A helper's name: what the agent passes to pick it, so kept to one word. */
export const AGENT_SUBAGENT_NAME = /^[a-z][a-z0-9-]{1,39}$/;

export interface AgentConversation {
	id: string;
	owner: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	shares?: AgentShare[];
	/** Accounts that pinned it to the top of their list */
	pinnedBy?: string[];
	/** Accounts that put it out of their list */
	archivedBy?: string[];
	/** Tools each account allowed "for this chat", so they stop asking there */
	allowedTools?: Record<string, string[]>;
	/** The conversation this one was branched from */
	forkedFrom?: { id: string; title: string };
	/**
	 * The session the next run branches from, set by a fork or a rewind: it
	 * resumes `session` cut at `at` (a message uuid; absent means the whole of
	 * it) under a new session id, so the old branch stays as it was. `costBase`
	 * is the running total the branched session inherits from `session`.
	 */
	pendingFork?: { session: string; at?: string; costBase?: number };
	/** The SDK session to resume, once the first turn has run */
	sessionId?: string;
	/** Estimated spend across every turn, in USD, as the SDK reports it */
	costUsd: number;
	/**
	 * What sessions before the current one cost. The SDK's figure is the
	 * session's running total, carried across resumes, so the conversation's
	 * spend is this plus the latest total, never a sum of every run's.
	 */
	costBeforeUsd?: number;
	/**
	 * What the current session's running total had already counted when it
	 * began: a branched session carries its source's total, which belongs to
	 * the conversation it was branched from, not to this one.
	 */
	costBaseUsd?: number;
	/** Each session's running total as last reported, which a branch cut from it inherits */
	sessionCosts?: Record<string, number>;
	turns: number;
	/** How full the session's context was after its last response */
	context?: AgentContextUsage;
	/** How many times the session's history has been summarised, by hand or on its own */
	compactions?: number;
}

/** A session's context as the SDK measured it after a response. */
export interface AgentContextUsage {
	/** Tokens the next request would carry */
	tokens: number;
	/** The window those are measured against: where the session compacts on its own */
	window: number;
	model: string;
	at: number;
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
	/** What Anthropic's Models API listed for the credential, newest first; wins over `models` */
	apiModels?: AgentModelChoice[];
	/** When `apiModels` was fetched */
	apiModelsAt?: number;
	tokenId?: string;
	conversations: AgentConversation[];
}

/**
 * One line of a transcript. `uuid` is the SDK message it was filed from (for
 * the operator's own messages, the one the console gave it) and `session` the
 * session that message is in: together, where a fork or a rewind cuts. Entries
 * filed before forking existed have neither.
 */
export type AgentEntry =
	| {
		kind: "user";
		at: number;
		author: string;
		text: string;
		mode?: string;
		model?: string;
		/** The reasoning effort the answer to it was asked for */
		effort?: string;
		/** Files attached to the message, by name; `image` names the copy the chat shows of a picture */
		attachments?: Array<{ name: string; size: number; image?: string }>;
		uuid?: string;
		session?: string;
		/**
		 * Sent while an answer was going and folded into it: the session files it
		 * as an attachment under a uuid of its own, so this one is no cut point
		 */
		midTurn?: boolean;
	}
	| { kind: "assistant"; at: number; text: string; uuid?: string; session?: string }
	/** What the model thought before answering, as the API summarised it */
	| { kind: "thinking"; at: number; text: string }
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
		/** The helper call this one was made inside, when a subagent made it */
		parent?: string;
		/** Whose run made it, and so whose permissions its result reflects; absent means the owner's */
		actor?: string;
		/** Images the result carried (a screenshot, a picture it read), by file name; see `agentImagePath` */
		images?: string[];
		/** Files the agent handed over for download; see `AgentSharedFile` */
		files?: AgentSharedFile[];
		uuid?: string;
		session?: string;
	}
	| { kind: "error"; at: number; text: string }
	/**
	 * Something the agent set up reporting back: a background task finishing,
	 * a trigger firing or expiring. It reached the model as a message, but it
	 * is nobody's words, so the transcript keeps it apart from the operator's.
	 */
	| { kind: "event"; at: number; source: "task" | "trigger"; label: string; text: string; uuid?: string; session?: string }
	/** What one answer took: wall time, tool calls and what it cost */
	| { kind: "stats"; at: number; ms: number; tools: number; costUsd: number }
	/** The session's history was summarised; `by` is who asked, absent when it happened on its own */
	| {
		kind: "compact";
		at: number;
		trigger: "manual" | "auto";
		by?: string;
		preTokens: number;
		postTokens?: number;
	};

/**
 * A conversation as one account sees it: its own role, pins and allowed tools,
 * with the other accounts' bookkeeping left out.
 */
export interface AgentConversationView extends Omit<AgentConversation, "pinnedBy" | "archivedBy" | "allowedTools" | "sessionCosts"> {
	role: AgentRole;
	pinned: boolean;
	archived: boolean;
	allowedTools: string[];
}

export interface AgentTranscript extends AgentConversationView {
	entries: AgentEntry[];
}

/** What every reader sees: the credential described, never shown. */
export interface AgentStatus {
	credential: { kind: AgentCredentialKind; hint: string; setAt: number; setBy: string | null } | null;
	settings: AgentSettings;
	token: McpTokenSummary | null;
	/**
	 * The models the credential can use: Anthropic's list when it has been
	 * fetched, else what the last connection test reported; null until either ran.
	 */
	models: AgentModelChoice[] | null;
	/** When the list was last fetched from Anthropic; null when it never was */
	modelsCheckedAt: number | null;
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
	scratchAttachmentMb?: number;
	executable?: string;
	bypassAllowed?: boolean;
	suggestions?: boolean;
	subagents?: AgentSubagent[];
}

/** The token a fresh agent gets: it reads, operates instances, manages addons and remembers. Files, shells and config stay off. */
const AGENT_SCOPE: McpScope = {
	groups: [...new Set([...MCP_DEFAULT_GROUPS, "control" as const, "addons" as const, "addons-write" as const, "network" as const, "network-write" as const, "packs" as const, "packs-write" as const, "knowledge-write" as const])],
	allow: [],
	deny: [],
	instances: null,
};

const MAX_TURNS_CEILING = 100;

/** Largest attachment an operator may allow, in megabytes; `luna web` sets the console's request body limit to match. */
export const SCRATCH_ATTACHMENT_CEILING_MB = 4096;

const MAX_INSTRUCTIONS = 8 * 1024;

/** Names the console's own helpers take; a custom one may not shadow them. */
export const AGENT_BUILTIN_SUBAGENTS = ["investigator", "researcher", "general-purpose", "fork"] as const;

/** Validate a console's helper definitions, returning them cleaned; throws on the first fault. */
function checkSubagents(list: unknown): AgentSubagent[] {
	if (!Array.isArray(list)) {
		throw new Error(t("core.agent.badSubagents"));
	}

	if (list.length > MAX_AGENT_SUBAGENTS) {
		throw new Error(t("core.agent.tooManySubagents", { max: MAX_AGENT_SUBAGENTS }));
	}

	const seen = new Set<string>();

	return list.map((raw: Partial<AgentSubagent>) => {
		const name = String(raw?.name ?? "").trim();

		if (!AGENT_SUBAGENT_NAME.test(name) || (AGENT_BUILTIN_SUBAGENTS as readonly string[]).includes(name)) {
			throw new Error(t("core.agent.badSubagentName", { name }));
		}

		if (seen.has(name)) {
			throw new Error(t("core.agent.duplicateSubagent", { name }));
		}

		seen.add(name);

		const description = String(raw.description ?? "").trim();
		const prompt = String(raw.prompt ?? "").trim();
		const model = String(raw.model ?? "").trim();
		const tools = Array.isArray(raw.tools)
			? [...new Set(raw.tools.map((tool) => String(tool).trim()).filter(Boolean))]
			: [];

		if (!description || description.length > 300 || !prompt || prompt.length > MAX_INSTRUCTIONS) {
			throw new Error(t("core.agent.badSubagentText", { name }));
		}

		if (model && !AGENT_MODEL_PATTERN.test(model) && !["sonnet", "opus", "haiku", "fable", "inherit"].includes(model)) {
			throw new Error(t("core.agent.badModel", { model }));
		}

		if (tools.length > 200 || tools.some((tool) => !/^(group:)?[a-z0-9_-]{1,64}$/.test(tool))) {
			throw new Error(t("core.agent.badSubagentTools", { name }));
		}

		return { name, description, prompt, tools, model, enabled: raw.enabled !== false };
	});
}

function defaultSettings(): AgentSettings {
	return {
		enabled: true,
		model: AGENT_MODELS[0],
		effort: "medium",
		instructions: "",
		maxTurns: 30,
		scratchAttachmentMb: 1024,
		executable: "",
		bypassAllowed: true,
		suggestions: true,
		subagents: [],
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

/** A conversation's scratch folder: files the agent keeps while it works, removed with the conversation. */
function scratchPath(id: string): string {
	return join(transcriptsDir(), "scratch", id);
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
		models: describeModels(store.apiModels, store.models),
		modelsCheckedAt: store.apiModelsAt ?? null,
		ready: reason === null,
		reason,
	};
}

/**
 * The model list the screens offer. The Models API names every model but says
 * nothing about them, while Claude Code's own list (kept from the last connection
 * test) describes its current models as "Opus 5.5 · Best for …"; each API model
 * takes the words after its own name from there, and one Claude Code does not
 * describe (an older release) shows its id instead.
 */
function describeModels(api: AgentModelChoice[] | undefined, sdk: AgentModelChoice[] | undefined): AgentModelChoice[] | null {
	if (!api) {
		return sdk ?? null;
	}

	const blurbs = new Map<string, string>();

	for (const model of sdk ?? []) {
		const [name, ...rest] = String(model.description ?? "").split(" · ");

		if (name && rest.length > 0 && !blurbs.has(name)) {
			blurbs.set(name, rest.join(" · "));
		}
	}

	return api.map((model) => ({
		...model,
		description: model.description || blurbs.get(model.label) || model.value,
	}));
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
		delete store.apiModels;
		delete store.apiModelsAt;
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

let modelsRefresh: Promise<AgentModelChoice[]> | null = null;

interface ApiModelPage {
	data?: Array<{ id?: unknown; display_name?: unknown; created_at?: unknown }>;
	has_more?: boolean;
	last_id?: string | null;
}

/**
 * Headers for Anthropic's API. A subscription token rides `Authorization` with
 * the OAuth beta, as Claude Code sends it; an API key rides `x-api-key`.
 */
function anthropicHeaders(credential: StoredCredential): Record<string, string> {
	const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };

	if (credential.kind === "oauth") {
		headers.authorization = `Bearer ${credential.value}`;
		headers["anthropic-beta"] = "oauth-2025-04-20";
	} else {
		headers["x-api-key"] = credential.value;
	}

	return headers;
}

async function fetchApiModels(credential: StoredCredential): Promise<AgentModelChoice[]> {
	// a gateway in front of the API is honoured here as it is for the subprocess
	const base = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
	const headers = anthropicHeaders(credential);
	const found: Array<{ id: string; label: string; created: number }> = [];
	let after: string | null = null;

	for (let page = 0; page < 10; page++) {
		const url = new URL(`${base}/v1/models`);

		url.searchParams.set("limit", String(MODELS_PAGE_LIMIT));

		if (after) {
			url.searchParams.set("after_id", after);
		}

		const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });

		if (!response.ok) {
			throw new Error(`models list: HTTP ${response.status}`);
		}

		const body = (await response.json()) as ApiModelPage;

		for (const model of body.data ?? []) {
			const id = typeof model.id === "string"
				? model.id
				: "";

			if (!AGENT_MODEL_PATTERN.test(id)) {
				continue;
			}

			const label = typeof model.display_name === "string" && model.display_name
				? model.display_name
				: id;
			const created = typeof model.created_at === "string"
				? Date.parse(model.created_at) || 0
				: 0;

			found.push({ id, label, created });
		}

		if (!body.has_more || !body.last_id) {
			break;
		}

		after = body.last_id;
	}

	found.sort((a, b) => b.created - a.created);

	return found.slice(0, 50).map((model) => ({
		value: model.id.slice(0, 80),
		label: model.label.replace(/^Claude\s+/, "").slice(0, 80),
		description: "",
	}));
}

/**
 * Ask Anthropic's Models API which models the stored credential can use and
 * keep the answer, newest first, so a model released after this build is
 * offered without anybody updating `AGENT_MODELS`. An operator asks for it
 * (the settings screen's refresh); concurrent callers share one request, and a
 * failure throws and keeps the previous list.
 *
 * @returns The fetched list; an empty list when there is no credential.
 */
export async function refreshAgentModels(): Promise<AgentModelChoice[]> {
	if (modelsRefresh) {
		return await modelsRefresh;
	}

	modelsRefresh = (async (): Promise<AgentModelChoice[]> => {
		const credential = (await loadStore()).credential;

		if (!credential) {
			return [];
		}

		const models = await fetchApiModels(credential);

		if (models.length === 0) {
			return [];
		}

		await serialized(async () => {
			const store = await loadStore();

			// the credential changed while the list was in flight; it belongs to the old one
			if (store.credential?.value !== credential.value) {
				return;
			}

			store.apiModels = models;
			store.apiModelsAt = Date.now();
			await saveStore(store);
		});

		return models;
	})();

	try {
		return await modelsRefresh;
	} finally {
		modelsRefresh = null;
	}
}

/** Forget the credential; the agent stops answering until a new one is pasted. */
export async function clearAgentCredential(actor?: string): Promise<AgentStatus> {
	await serialized(async () => {
		const store = await loadStore();

		delete store.credential;
		delete store.apiModels;
		delete store.apiModelsAt;
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

		if (patch.scratchAttachmentMb !== undefined) {
			const megabytes = Math.round(Number(patch.scratchAttachmentMb));

			if (!Number.isFinite(megabytes) || megabytes < 0 || megabytes > SCRATCH_ATTACHMENT_CEILING_MB) {
				throw new Error(t("core.agent.badScratchAttachment", { max: SCRATCH_ATTACHMENT_CEILING_MB }));
			}

			next.scratchAttachmentMb = megabytes;
		}

		if (patch.executable !== undefined) {
			next.executable = patch.executable.trim();
		}

		if (patch.bypassAllowed !== undefined) {
			next.bypassAllowed = !!patch.bypassAllowed;
		}

		if (patch.suggestions !== undefined) {
			next.suggestions = !!patch.suggestions;
		}

		if (patch.subagents !== undefined) {
			next.subagents = checkSubagents(patch.subagents);
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

/** What an account is to a conversation, or null when it may not open it. */
function roleOf(conversation: AgentConversation, account: string): AgentRole | null {
	if (conversation.owner === account) {
		return "owner";
	}

	return conversation.shares?.find((share) => share.account === account)?.role ?? null;
}

/** Whether a role may write in a conversation: send, approve its own calls, rename, rewind. */
function writes(role: AgentRole | null): boolean {
	return role === "owner" || role === "collaborator";
}

function viewOf(conversation: AgentConversation, account: string, role: AgentRole): AgentConversationView {
	const { pinnedBy, archivedBy, allowedTools, sessionCosts: _costs, ...rest } = conversation;

	return {
		...rest,
		role,
		pinned: pinnedBy?.includes(account) ?? false,
		archived: archivedBy?.includes(account) ?? false,
		allowedTools: allowedTools?.[account] ?? [],
	};
}

/**
 * A conversation the account may open, in the role it has there; `roles`
 * narrows who may (an owner-only verb passes `["owner"]`). Anyone else gets the
 * same "no such conversation", so a shared id says nothing to a stranger.
 */
function requireConversation(
	store: AgentStore,
	id: string,
	account: string,
	roles: readonly AgentRole[] = ["owner", "collaborator", "viewer"],
): { conversation: AgentConversation; role: AgentRole } {
	const conversation = store.conversations.find((entry) => entry.id === id);
	const role = conversation
		? roleOf(conversation, account)
		: null;

	if (!conversation || !role) {
		throw new Error(t("core.agent.unknownConversation", { id }));
	}

	if (!roles.includes(role)) {
		throw new Error(t("core.agent.notAllowedHere", { role }));
	}

	return { conversation, role };
}

/**
 * The scratch folder of a conversation, created on first use: the one place on
 * disk the agent's own file tools may read and write. Whoever may write in the
 * conversation runs there; nobody else gets its folder.
 */
export async function agentScratch(id: string, account: string): Promise<string> {
	const store = await loadStore();

	requireConversation(store, id, account, ["owner", "collaborator"]);

	const dir = scratchPath(id);

	await mkdir(dir, { recursive: true });

	return dir;
}

/**
 * A file the agent shared in the chat. One from its scratch folder is copied
 * under `.files/<id>/<name>` and served by the conversation; one on an instance
 * (`instance` set) is only named, and downloads through the instance's own
 * file route with the reader's permissions.
 */
export interface AgentSharedFile {
	id: string;
	name: string;
	size: number;
	instance?: string;
	/** The file's path inside the instance, for an instance file */
	path?: string;
}

/** What a shared file's id looks like. */
export const AGENT_FILE_ID = /^file_[0-9a-f]{12}$/;

/**
 * Where a file the agent shared from its scratch folder is kept: the
 * conversation's scratch folder, under `.files/<id>`. Anyone who can open the
 * conversation may ask; the caller checks the transcript names it. Throws for
 * an id or a name that is not one.
 */
export async function agentSharedFilePath(id: string, account: string, fileId: string, name: string): Promise<string> {
	const store = await loadStore();

	requireConversation(store, id, account, ["owner", "collaborator", "viewer"]);

	if (!AGENT_FILE_ID.test(fileId) || !name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
		throw new Error(t("core.agent.unknownFile"));
	}

	return join(scratchPath(id), ".files", fileId, name);
}

/** What an image saved from a tool result may be called: the call id, its index, a picture's extension. */
export const AGENT_IMAGE_NAME = /^[A-Za-z0-9_-]{1,128}\.(png|jpg|gif|webp)$/;

/**
 * Where an image a tool result carried is kept: the conversation's scratch
 * folder, under `.images`, so it goes with the conversation. Anyone who can
 * open the conversation may ask; whether they may see that call's result is
 * the caller's to decide. Throws for a name that is not one.
 */
export async function agentImagePath(id: string, account: string, name: string): Promise<string> {
	const store = await loadStore();

	requireConversation(store, id, account, ["owner", "collaborator", "viewer"]);

	if (!AGENT_IMAGE_NAME.test(name)) {
		throw new Error(t("core.agent.unknownImage"));
	}

	return join(scratchPath(id), ".images", name);
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

async function writeEntries(id: string, entries: AgentEntry[]): Promise<void> {
	await mkdir(transcriptsDir(), { recursive: true });
	await Bun.write(transcriptPath(id), JSON.stringify({ id, entries }) + "\n");
}

/** Every conversation an account may open, its own and those shared with it, newest first. */
export async function listAgentConversations(account: string): Promise<AgentConversationView[]> {
	const store = await loadStore();
	const views: AgentConversationView[] = [];

	for (const conversation of store.conversations) {
		const role = roleOf(conversation, account);

		if (role) {
			views.push(viewOf(conversation, account, role));
		}
	}

	return views.sort((left, right) => right.updatedAt - left.updatedAt);
}

/** One conversation with its transcript, or undefined when the account may not open it. */
export async function getAgentConversation(id: string, account: string): Promise<AgentTranscript | undefined> {
	const store = await loadStore();
	const conversation = store.conversations.find((entry) => entry.id === id);
	const role = conversation
		? roleOf(conversation, account)
		: null;

	if (!conversation || !role) {
		return undefined;
	}

	return { ...viewOf(conversation, account, role), entries: await readEntries(id) };
}

/** Drop an owner's oldest conversations past the cap; shared ones count only for their owner. */
async function trimOwned(store: AgentStore, owner: string): Promise<void> {
	const mine = store.conversations
		.filter((entry) => entry.owner === owner)
		.sort((left, right) => left.updatedAt - right.updatedAt);
	const excess = mine.slice(0, Math.max(0, mine.length - MAX_AGENT_CONVERSATIONS));

	for (const old of excess) {
		store.conversations = store.conversations.filter((entry) => entry !== old);
		await rm(transcriptPath(old.id), { force: true });
		await rm(scratchPath(old.id), { recursive: true, force: true });
	}
}

/** Start an empty conversation, dropping the owner's oldest past the cap. */
export async function createAgentConversation(owner: string, title = ""): Promise<AgentConversationView> {
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
		await trimOwned(store, owner);
		await saveStore(store);

		return viewOf(conversation, owner, "owner");
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
	/** The SDK's running total for the session, which already includes its earlier runs */
	costUsd?: number;
	context?: AgentContextUsage;
	/** Compactions this run saw */
	compactions?: number;
	/** Set on the first message, so the list has something to show */
	title?: string;
	/** Whether this update closes a turn (counted) or only saves progress */
	completed?: boolean;
	/** The run branched the session a fork or rewind asked for; the next one resumes plainly */
	forked?: boolean;
	/** Entries filed before the session said its id (a run's first message), to be marked as its own */
	stamp?: { session: string; uuids: string[] };
	/** What a new session's running total started from (a branch's inherited cost) */
	costBase?: number;
}

/** A conversation's current session's running total, as the SDK counts it. */
function sessionTotal(conversation: AgentConversation): number {
	return Math.max(0, conversation.costUsd - (conversation.costBeforeUsd ?? 0)) + (conversation.costBaseUsd ?? 0);
}

/** Sessions whose running totals a conversation remembers; older ones fall off. */
const MAX_SESSION_COSTS = 20;

/** The running total a session cut from `session` inherits, as best this conversation knows it. */
function inheritedCost(conversation: AgentConversation, session: string): number {
	if (conversation.pendingFork?.session === session) {
		return conversation.pendingFork.costBase ?? 0;
	}

	if (conversation.sessionId === session) {
		return sessionTotal(conversation);
	}

	return conversation.sessionCosts?.[session] ?? 0;
}

/** Append a turn's entries to a transcript and update the index; `account` is whoever ran it. */
export async function appendAgentTurn(id: string, account: string, update: AgentTurnUpdate): Promise<AgentConversationView> {
	return await serialized(async () => {
		const store = await loadStore();
		const { conversation, role } = requireConversation(store, id, account, ["owner", "collaborator"]);
		const stamped = new Set(update.stamp?.uuids ?? []);
		const earlier = (await readEntries(id)).map((entry) =>
			update.stamp && "uuid" in entry && entry.uuid && stamped.has(entry.uuid)
				? { ...entry, session: update.stamp.session }
				: entry
		);
		const entries = [...earlier, ...update.entries.map(clipEntry)].slice(-MAX_AGENT_ENTRIES);

		await writeEntries(id, entries);

		conversation.updatedAt = Date.now();

		// a new session's total starts from what it inherited (zero, unless it is a
		// branch), so what the old one cost is banked first
		if (update.sessionId && update.sessionId !== conversation.sessionId) {
			if (conversation.sessionId) {
				conversation.costBeforeUsd = conversation.costUsd;
			}

			conversation.costBaseUsd = update.costBase || undefined;
		}

		if (update.sessionId) {
			conversation.sessionId = update.sessionId;
		}

		if (update.forked) {
			delete conversation.pendingFork;
		}

		if (update.costUsd) {
			conversation.costUsd = (conversation.costBeforeUsd ?? 0) + Math.max(0, update.costUsd - (conversation.costBaseUsd ?? 0));

			if (conversation.sessionId) {
				const costs = { ...(conversation.sessionCosts ?? {}) };

				delete costs[conversation.sessionId];
				costs[conversation.sessionId] = update.costUsd;
				conversation.sessionCosts = Object.fromEntries(Object.entries(costs).slice(-MAX_SESSION_COSTS));
			}
		}

		if (update.context) {
			conversation.context = update.context;
		}

		if (update.compactions) {
			conversation.compactions = (conversation.compactions ?? 0) + update.compactions;
		}

		if (update.completed) {
			conversation.turns += 1;
		}

		if (update.title && !conversation.title) {
			conversation.title = update.title.trim().replace(/\s+/g, " ").slice(0, 120);
		}

		await saveStore(store);

		return viewOf(conversation, account, role);
	});
}

/** Rename a conversation; anyone who may write in it may. */
export async function renameAgentConversation(id: string, account: string, title: string): Promise<AgentConversationView> {
	return await serialized(async () => {
		const store = await loadStore();
		const { conversation, role } = requireConversation(store, id, account, ["owner", "collaborator"]);

		conversation.title = title.trim().slice(0, 120);
		await saveStore(store);

		return viewOf(conversation, account, role);
	});
}

export interface AgentConversationFlags {
	pinned?: boolean;
	archived?: boolean;
}

/** Pin or archive a conversation in one account's own list; nobody else's list moves. */
export async function flagAgentConversation(id: string, account: string, flags: AgentConversationFlags): Promise<AgentConversationView> {
	return await serialized(async () => {
		const store = await loadStore();
		const { conversation, role } = requireConversation(store, id, account);

		const toggle = (list: string[] | undefined, on: boolean | undefined): string[] | undefined => {
			if (on === undefined) {
				return list;
			}

			const rest = (list ?? []).filter((name) => name !== account);
			const next = on
				? [...rest, account]
				: rest;

			return next.length
				? next
				: undefined;
		};

		conversation.pinnedBy = toggle(conversation.pinnedBy, flags.pinned);
		conversation.archivedBy = toggle(conversation.archivedBy, flags.archived);
		await saveStore(store);

		return viewOf(conversation, account, role);
	});
}

/**
 * The tools an account allowed "for this chat": in that conversation, and only
 * in runs that account starts, they no longer stop to ask. What a tool may
 * reach is unchanged; this only decides whether someone is asked first.
 */
export async function setAgentAllowedTools(id: string, account: string, tools: string[]): Promise<AgentConversationView> {
	return await serialized(async () => {
		const store = await loadStore();
		const { conversation, role } = requireConversation(store, id, account, ["owner", "collaborator"]);
		const clean = [...new Set(tools.map((tool) => String(tool).trim()).filter((tool) => /^[A-Za-z0-9_:-]{1,80}$/.test(tool)))].slice(0, 100);
		const all = { ...(conversation.allowedTools ?? {}) };

		if (clean.length) {
			all[account] = clean;
		} else {
			delete all[account];
		}

		conversation.allowedTools = Object.keys(all).length
			? all
			: undefined;
		await saveStore(store);

		return viewOf(conversation, account, role);
	});
}

/**
 * Share a conversation with another console account, change its role, or
 * (`role` null) take it back. Only the owner may. The account has to exist and
 * be enabled; the answer for one that does not is the same either way.
 */
export async function shareAgentConversation(
	id: string,
	owner: string,
	account: string,
	role: AgentShareRole | null,
): Promise<AgentConversationView> {
	const target = account.trim();

	if (role !== null) {
		const known = target && target !== owner
			? await getAccount(target).catch(() => undefined)
			: undefined;

		if (!known || !known.enabled || !(AGENT_SHARE_ROLES as readonly string[]).includes(role)) {
			throw new Error(t("core.agent.cannotShare", { account: target }));
		}
	}

	const view = await serialized(async () => {
		const store = await loadStore();
		const { conversation } = requireConversation(store, id, owner, ["owner"]);
		const shares = (conversation.shares ?? []).filter((share) => share.account !== target);

		if (role !== null) {
			if (shares.length >= MAX_AGENT_SHARES) {
				throw new Error(t("core.agent.tooManyShares", { max: MAX_AGENT_SHARES }));
			}

			shares.push({ account: target, role, at: Date.now(), by: owner });
		}

		conversation.shares = shares.length
			? shares
			: undefined;

		// what the account had pinned or allowed there is its own, and goes with it
		if (role === null) {
			conversation.pinnedBy = conversation.pinnedBy?.filter((name) => name !== target);
			conversation.archivedBy = conversation.archivedBy?.filter((name) => name !== target);

			if (conversation.allowedTools) {
				delete conversation.allowedTools[target];
			}
		}

		await saveStore(store);

		return viewOf(conversation, owner, "owner");
	});

	await appendJournal({
		source: "agent",
		level: "info",
		message: role
			? `conversation ${id} shared with ${target} (${role})`
			: `conversation ${id} no longer shared with ${target}`,
		actor: owner,
	});

	return view;
}

/** Stop seeing a conversation someone shared; the owner's copy is untouched. */
export async function leaveAgentConversation(id: string, account: string): Promise<void> {
	await serialized(async () => {
		const store = await loadStore();
		const { conversation } = requireConversation(store, id, account, ["viewer", "collaborator"]);

		conversation.shares = conversation.shares?.filter((share) => share.account !== account);
		conversation.pinnedBy = conversation.pinnedBy?.filter((name) => name !== account);
		conversation.archivedBy = conversation.archivedBy?.filter((name) => name !== account);

		if (conversation.allowedTools) {
			delete conversation.allowedTools[account];
		}

		await saveStore(store);
	});
}

/**
 * Where a cut after `keep` entries lands: the session and message uuid of the
 * last kept entry that has them, `null` when nothing kept reached a session, or
 * undefined when a kept entry predates uuids and the cut cannot be placed. A
 * uuid is only meaningful in the session it was filed in, since a branched
 * session renumbers its messages, so the pair travels together.
 */
function cutPoint(entries: AgentEntry[], keep: number): { session: string; at: string } | null | undefined {
	for (let index = keep - 1; index >= 0; index--) {
		const entry = entries[index]!;

		if (entry.kind === "user" && entry.midTurn) {
			continue;
		}

		if ("uuid" in entry && entry.uuid && entry.session) {
			return { session: entry.session, at: entry.uuid };
		}

		// an operator's message or a report without one was filed before forking existed
		if (entry.kind === "user" || entry.kind === "assistant" || entry.kind === "event") {
			return undefined;
		}
	}

	return null;
}

/** How many entries come before the message `before` names, or all of them when it is omitted. */
function keepBefore(entries: AgentEntry[], before: string | undefined): number {
	if (before === undefined) {
		return entries.length;
	}

	const index = entries.findIndex((entry) => "uuid" in entry && entry.uuid === before && (entry.kind === "user" || entry.kind === "event"));

	if (index < 0) {
		throw new Error(t("core.agent.unknownMessage"));
	}

	return index;
}

/**
 * Branch a conversation into a new one the account owns, keeping what came
 * before the message `before` names (everything when it is omitted). The new conversation's first run
 * resumes the session cut at that point, so the agent remembers exactly what
 * the copy shows. Only the owner may: a fork hands the model the whole history,
 * tool results a viewer was not shown included.
 */
export async function forkAgentConversation(id: string, account: string, before?: string): Promise<AgentConversationView> {
	return await serialized(async () => {
		const store = await loadStore();
		const { conversation: source } = requireConversation(store, id, account, ["owner"]);
		const all = await readEntries(id);
		const count = keepBefore(all, before);
		const kept = all.slice(0, count);
		const at = cutPoint(all, count);

		if (at === undefined) {
			throw new Error(t("core.agent.cannotFork"));
		}

		const now = Date.now();
		const title = t("core.agent.forkTitle", { title: source.title || id }).slice(0, 120);

		const conversation: AgentConversation = {
			id: newId("chat"),
			owner: account,
			title,
			createdAt: now,
			updatedAt: now,
			costUsd: 0,
			turns: 0,
			forkedFrom: { id: source.id, title: source.title },
			...(at
				? {
					pendingFork: count < all.length
						? { session: at.session, at: at.at, costBase: inheritedCost(source, at.session) }
						: source.pendingFork ?? { session: source.sessionId ?? at.session, costBase: inheritedCost(source, source.sessionId ?? at.session) },
				}
				: {}),
		};

		store.conversations.push(conversation);
		await writeEntries(conversation.id, kept);
		await trimOwned(store, account);
		await saveStore(store);

		return viewOf(conversation, account, "owner");
	});
}

/**
 * Take a conversation back to before the message `before` names, dropping it
 * and everything after: what "edit and resend" and "retry" do. The next run branches the
 * session at that point, so the agent forgets what was dropped. Anything the
 * agent already did on the cluster stays done; only the conversation rewinds.
 */
export async function rewindAgentConversation(id: string, account: string, before: string): Promise<AgentConversationView> {
	return await serialized(async () => {
		const store = await loadStore();
		const { conversation, role } = requireConversation(store, id, account, ["owner", "collaborator"]);
		const all = await readEntries(id);
		const keep = keepBefore(all, before);
		const at = cutPoint(all, keep);

		if (at === undefined) {
			throw new Error(t("core.agent.cannotFork"));
		}

		await writeEntries(id, all.slice(0, keep));

		// nothing kept reached the session: the next run starts a fresh one
		if (at === null) {
			delete conversation.sessionId;
			delete conversation.pendingFork;
			delete conversation.context;
			delete conversation.costBaseUsd;
			conversation.costBeforeUsd = conversation.costUsd;
		} else {
			conversation.pendingFork = { session: at.session, at: at.at, costBase: inheritedCost(conversation, at.session) };
		}

		conversation.updatedAt = Date.now();
		await saveStore(store);

		return viewOf(conversation, account, role);
	});
}

/**
 * Delete a conversation and its transcript; returns what was removed. Only the
 * owner may; everyone it was shared with loses it too.
 */
export async function removeAgentConversation(id: string, owner: string): Promise<AgentConversationView> {
	return await serialized(async () => {
		const store = await loadStore();
		const { conversation } = requireConversation(store, id, owner, ["owner"]);

		store.conversations = store.conversations.filter((entry) => entry !== conversation);
		await rm(transcriptPath(id), { force: true });
		await rm(scratchPath(id), { recursive: true, force: true });
		await saveStore(store);

		return viewOf(conversation, owner, "owner");
	});
}
