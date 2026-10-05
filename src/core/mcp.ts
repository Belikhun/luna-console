// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * MCP access: the tokens an MCP client presents to the console's `/api/mcp`
 * endpoint, the record of every call made with them, and the knowledge (context,
 * memories, skills) the endpoint serves.
 *
 * A token is **not** a console account. An account is a person who can reach
 * everything; a token is a grant handed to a program (a Discord bot, an editor),
 * and its scope (`McpScope`, resolved against `shared/mcptools.ts`) is the whole
 * of what it may do. That scope is the authorization, so it is checked on every
 * call rather than once at connect.
 *
 * Three stores, all **primary-local and never mirrored**, for the same reason
 * `sessions.json` is not: the endpoint runs inside the console, the console only
 * runs beside the primary, and a follower has no use for a credential it could
 * never be presented with.
 *
 * - `mcp.json`: tokens (secret digests only) and the management audit trail.
 * - `knowledge.json`: context documents, memories and skills, each scoped to the
 *   whole console or to one token.
 * - `logs/mcp/<YYYY-MM>.ndjson`: one line per tool call, append-only, the same
 *   shape and reasoning as the console journal; per-call traffic must not
 *   rewrite a JSON store.
 */

import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { t } from "../shared/i18n";
import {
	allowedTools,
	defaultMcpScope,
	MCP_TOOL_GROUPS,
	mcpTool,
	type McpScope,
	type McpToolGroup,
} from "../shared/mcptools";
import { buildVersion } from "../version";
import { root, statePath } from "./config";
import { digest, newId, newSecret, sameDigest, splitBearer } from "./secrets";

const TOKENS_FILE = "mcp.json";
const KNOWLEDGE_FILE = "knowledge.json";

/** Audit entries kept, oldest dropped first. */
export const MCP_MAX_AUDIT = 2_000;

/**
 * How stale a token's `lastUsedAt` may get before a call persists it. Every call
 * authorizes, and saving the store each time would turn a chatty client into a
 * disk writer.
 */
export const MCP_TOUCH_MS = 60 * 1000;

/** Longest argument dump a call record keeps; past it the record says so. */
export const MCP_MAX_RECORDED_ARGS = 4 * 1024;

/** How many call records a read returns when the caller does not say. */
export const DEFAULT_MCP_CALLS = 200;

/** Upper bound on one call-log read. */
export const MAX_MCP_CALLS = 5_000;

/** Most of one month's call log a single read looks at. */
const MAX_READ_BYTES = 16 * 1024 * 1024;

/** Argument names whose values never reach the call log. */
const SECRET_ARG = /pass|secret|token|key|credential/i;

/** Token names: what the operator calls the client holding it. */
export const MCP_TOKEN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/** Skill names: a slug the model asks for by name. */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface McpToken {
	/** `mcp_<hex>`; also the public half of the bearer */
	id: string;
	name: string;
	description?: string;
	enabled: boolean;
	createdAt: number;
	createdBy?: string;
	lastUsedAt?: number;
	/** Epoch millis after which the token is refused; absent means it never expires */
	expiresAt?: number;
	rotatedAt?: number;
	/** SHA-256 of the secret half; never leaves the daemon */
	secretHash: string;
	scope: McpScope;
	/** Lifetime counters; the call log is the detail */
	stats: { calls: number; failures: number };
}

export type McpAuditAction =
	| "token.create"
	| "token.update"
	| "token.enable"
	| "token.disable"
	| "token.rotate"
	| "token.remove"
	| "knowledge.create"
	| "knowledge.update"
	| "knowledge.remove";

export interface McpAuditEntry {
	t: number;
	action: McpAuditAction;
	/** The token the change was about, by id */
	token?: string;
	/** The knowledge item the change was about, by id */
	item?: string;
	/** Console account, `root`, or `mcp:<token name>` for a change made over MCP */
	actor?: string;
	/** What changed, never a value that could be a credential */
	detail?: string;
}

interface TokenStore {
	tokens: McpToken[];
	audit: McpAuditEntry[];
}

/** A token as every caller outside this module sees it: no digest. */
export interface McpTokenSummary {
	id: string;
	name: string;
	description: string;
	enabled: boolean;
	createdAt: number;
	createdBy: string | null;
	lastUsedAt: number | null;
	expiresAt: number | null;
	rotatedAt: number | null;
	expired: boolean;
	scope: McpScope;
	/** The tool names the scope resolves to today */
	tools: string[];
	stats: { calls: number; failures: number };
}

/** A minted or rotated token: the bearer is shown once, here, and never again. */
export interface McpTokenSecret {
	token: McpTokenSummary;
	bearer: string;
}

/** Who a call is from, once its bearer checks out. */
export interface McpPrincipal {
	id: string;
	name: string;
	scope: McpScope;
	tools: string[];
}

export interface CreateMcpTokenInput {
	name: string;
	description?: string;
	expiresAt?: number | null;
	scope?: Partial<McpScope>;
}

export interface McpTokenPatch {
	name?: string;
	description?: string;
	expiresAt?: number | null;
	scope?: Partial<McpScope>;
}

function tokensPath(): string {
	return statePath(TOKENS_FILE);
}

function knowledgePath(): string {
	return statePath(KNOWLEDGE_FILE);
}

async function loadTokens(): Promise<TokenStore> {
	if (!existsSync(tokensPath())) {
		return { tokens: [], audit: [] };
	}

	const store: TokenStore = await Bun.file(tokensPath()).json();

	store.tokens ??= [];
	store.audit ??= [];

	for (const token of store.tokens) {
		token.scope = normalizeScope(token.scope);
		token.stats ??= { calls: 0, failures: 0 };
	}

	return store;
}

/**
 * Write the token store. Deliberately **not** announced through `notifySave`;
 * see the module header.
 */
async function saveTokens(store: TokenStore): Promise<void> {
	const sorted: TokenStore = {
		tokens: [...store.tokens].sort((left, right) => left.name.localeCompare(right.name)),
		audit: store.audit.slice(-MCP_MAX_AUDIT),
	};

	await Bun.write(tokensPath(), JSON.stringify(sorted, null, "\t") + "\n");
}

/**
 * Every read-modify-write of a store goes through this chain. Two MCP calls land
 * in the same millisecond as a matter of course (a model fanning out tools), and
 * without it the second save would drop the first one's counters.
 */
let writeChain: Promise<unknown> = Promise.resolve();

function serialized<T>(work: () => Promise<T>): Promise<T> {
	const next = writeChain.then(work, work);

	writeChain = next.catch(() => undefined);

	return next;
}

function recordAudit(store: TokenStore, entry: Omit<McpAuditEntry, "t">): void {
	store.audit.push({ t: Date.now(), ...entry });

	if (store.audit.length > MCP_MAX_AUDIT) {
		store.audit.splice(0, store.audit.length - MCP_MAX_AUDIT);
	}
}

/**
 * Bring a scope to its full shape, dropping groups and tool names the catalog
 * does not know; a token minted on a newer build and read on an older one keeps
 * working with whatever both agree on.
 */
export function normalizeScope(scope: Partial<McpScope> | undefined): McpScope {
	const base = defaultMcpScope();

	if (!scope) {
		return base;
	}

	const groups = (scope.groups ?? base.groups).filter((group): group is McpToolGroup =>
		MCP_TOOL_GROUPS.includes(group),
	);
	const known = (name: string): boolean => mcpTool(name) !== undefined;

	return {
		groups: [...new Set(groups)],
		allow: [...new Set((scope.allow ?? []).filter(known))],
		deny: [...new Set((scope.deny ?? []).filter(known))],
		instances: Array.isArray(scope.instances)
			? [...new Set(scope.instances.filter((name) => typeof name === "string" && name !== ""))]
			: null,
	};
}

function isExpired(token: McpToken, now = Date.now()): boolean {
	return token.expiresAt !== undefined && token.expiresAt <= now;
}

function summarize(token: McpToken): McpTokenSummary {
	return {
		id: token.id,
		name: token.name,
		description: token.description ?? "",
		enabled: token.enabled,
		createdAt: token.createdAt,
		createdBy: token.createdBy ?? null,
		lastUsedAt: token.lastUsedAt ?? null,
		expiresAt: token.expiresAt ?? null,
		rotatedAt: token.rotatedAt ?? null,
		expired: isExpired(token),
		scope: token.scope,
		tools: allowedTools(token.scope).map((tool) => tool.name),
		stats: { ...token.stats },
	};
}

function findToken(store: TokenStore, idOrName: string): McpToken | undefined {
	const wanted = idOrName.toLowerCase();

	return store.tokens.find((token) => token.id === idOrName || token.name.toLowerCase() === wanted);
}

function requireToken(store: TokenStore, idOrName: string): McpToken {
	const token = findToken(store, idOrName);

	if (!token) {
		throw new Error(t("core.mcp.unknownToken", { name: idOrName }));
	}

	return token;
}

function checkName(store: TokenStore, name: string, self?: McpToken): string {
	const trimmed = name.trim();

	if (!MCP_TOKEN_NAME_PATTERN.test(trimmed)) {
		throw new Error(t("core.mcp.badTokenName"));
	}

	const clash = store.tokens.find(
		(token) => token !== self && token.name.toLowerCase() === trimmed.toLowerCase(),
	);

	if (clash) {
		throw new Error(t("core.mcp.tokenNameTaken", { name: trimmed }));
	}

	return trimmed;
}

function checkExpiry(expiresAt: number | null | undefined): number | undefined {
	if (expiresAt === null || expiresAt === undefined) {
		return undefined;
	}

	if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
		throw new Error(t("core.mcp.expiryInPast"));
	}

	return expiresAt;
}

/** A human-readable diff of two scopes for the audit trail. */
function describeScope(scope: McpScope): string {
	const parts = [`groups=${scope.groups.join(",") || "-"}`];

	if (scope.allow.length > 0) {
		parts.push(`allow=${scope.allow.join(",")}`);
	}

	if (scope.deny.length > 0) {
		parts.push(`deny=${scope.deny.join(",")}`);
	}

	parts.push(`instances=${scope.instances === null ? "*" : scope.instances.join(",") || "-"}`);

	return parts.join(" ");
}

/** Every token, masked, name-sorted. */
export async function listMcpTokens(): Promise<McpTokenSummary[]> {
	const store = await loadTokens();

	return store.tokens.map(summarize);
}

/** One token, masked, or undefined when none goes by that id or name. */
export async function getMcpToken(idOrName: string): Promise<McpTokenSummary | undefined> {
	const store = await loadTokens();
	const token = findToken(store, idOrName);

	return token
		? summarize(token)
		: undefined;
}

/**
 * Mint a token. The bearer (`<id>.<secret>`) is returned once, here; only the
 * secret's digest is kept. A token with no scope given starts read-only.
 */
export async function createMcpToken(input: CreateMcpTokenInput, actor?: string): Promise<McpTokenSecret> {
	return await serialized(async () => {
		const store = await loadTokens();
		const name = checkName(store, input.name);
		const secret = newSecret();

		const token: McpToken = {
			id: newId("mcp"),
			name,
			description: input.description?.trim() || undefined,
			enabled: true,
			createdAt: Date.now(),
			createdBy: actor,
			expiresAt: checkExpiry(input.expiresAt),
			secretHash: digest(secret),
			scope: normalizeScope(input.scope),
			stats: { calls: 0, failures: 0 },
		};

		store.tokens.push(token);

		recordAudit(store, {
			action: "token.create",
			token: token.id,
			actor,
			detail: `${token.name} · ${describeScope(token.scope)}`,
		});

		await saveTokens(store);

		return { token: summarize(token), bearer: `${token.id}.${secret}` };
	});
}

/** Change a token's name, description, expiry or scope. */
export async function updateMcpToken(
	idOrName: string,
	patch: McpTokenPatch,
	actor?: string,
): Promise<McpTokenSummary> {
	return await serialized(async () => {
		const store = await loadTokens();
		const token = requireToken(store, idOrName);
		const changes: string[] = [];

		if (patch.name !== undefined && patch.name.trim() !== token.name) {
			const name = checkName(store, patch.name, token);

			changes.push(`name ${token.name} → ${name}`);
			token.name = name;
		}

		if (patch.description !== undefined && (patch.description.trim() || undefined) !== token.description) {
			token.description = patch.description.trim() || undefined;
			changes.push("description");
		}

		if (patch.expiresAt !== undefined && (patch.expiresAt ?? undefined) !== token.expiresAt) {
			token.expiresAt = checkExpiry(patch.expiresAt);

			const when = token.expiresAt
				? new Date(token.expiresAt).toISOString()
				: "never";

			changes.push(`expiry ${when}`);
		}

		if (patch.scope !== undefined) {
			const scope = normalizeScope({ ...token.scope, ...patch.scope });
			const before = describeScope(token.scope);
			const after = describeScope(scope);

			if (before !== after) {
				token.scope = scope;
				changes.push(`scope ${after}`);
			}
		}

		if (changes.length === 0) {
			return summarize(token);
		}

		recordAudit(store, {
			action: "token.update",
			token: token.id,
			actor,
			detail: `${token.name} · ${changes.join("; ")}`,
		});

		await saveTokens(store);

		return summarize(token);
	});
}

/** Enable or disable a token. A disabled token keeps its trail and is refused. */
export async function setMcpTokenEnabled(
	idOrName: string,
	enabled: boolean,
	actor?: string,
): Promise<McpTokenSummary> {
	return await serialized(async () => {
		const store = await loadTokens();
		const token = requireToken(store, idOrName);

		if (token.enabled === enabled) {
			return summarize(token);
		}

		token.enabled = enabled;

		recordAudit(store, {
			action: enabled ? "token.enable" : "token.disable",
			token: token.id,
			actor,
			detail: token.name,
		});

		await saveTokens(store);

		return summarize(token);
	});
}

/**
 * Replace a token's secret, keeping its id, scope, history and knowledge. The old
 * bearer stops working the moment this returns; the new one is shown once.
 */
export async function rotateMcpToken(idOrName: string, actor?: string): Promise<McpTokenSecret> {
	return await serialized(async () => {
		const store = await loadTokens();
		const token = requireToken(store, idOrName);
		const secret = newSecret();

		token.secretHash = digest(secret);
		token.rotatedAt = Date.now();

		recordAudit(store, { action: "token.rotate", token: token.id, actor, detail: token.name });

		await saveTokens(store);

		return { token: summarize(token), bearer: `${token.id}.${secret}` };
	});
}

/**
 * Remove a token, and with it every knowledge item scoped to it; a memory only
 * that token could read has no reader left. Returns how many items went with it.
 */
export async function removeMcpToken(
	idOrName: string,
	actor?: string,
): Promise<{ removed: McpTokenSummary; knowledgeRemoved: number }> {
	return await serialized(async () => {
		const store = await loadTokens();
		const token = requireToken(store, idOrName);

		store.tokens = store.tokens.filter((entry) => entry !== token);

		const knowledge = await loadKnowledge();
		const before = knowledge.items.length;

		knowledge.items = knowledge.items.filter(
			(item) => !(item.scope.kind === "token" && item.scope.token === token.id),
		);

		const knowledgeRemoved = before - knowledge.items.length;

		recordAudit(store, {
			action: "token.remove",
			token: token.id,
			actor,
			detail: knowledgeRemoved > 0
				? `${token.name} · ${knowledgeRemoved} knowledge item(s)`
				: token.name,
		});

		if (knowledgeRemoved > 0) {
			await saveKnowledge(knowledge);
		}

		await saveTokens(store);

		return { removed: summarize(token), knowledgeRemoved };
	});
}

/** The management audit trail, newest first, optionally about one token. */
export async function mcpAudit(opts: { token?: string; limit?: number } = {}): Promise<McpAuditEntry[]> {
	const store = await loadTokens();
	let entries = [...store.audit].reverse();

	if (opts.token) {
		const token = findToken(store, opts.token);
		const id = token?.id ?? opts.token;

		entries = entries.filter((entry) => entry.token === id || entry.actor === `mcp:${token?.name}`);
	}

	return entries.slice(0, opts.limit ?? entries.length);
}

/**
 * Check a presented bearer. Every refusal answers null alike (unknown id, wrong
 * secret, disabled, expired), so a caller cannot tell which half it got right.
 */
export async function authorizeMcpToken(bearer: string): Promise<McpPrincipal | null> {
	const parts = splitBearer(bearer.trim());

	if (!parts) {
		return null;
	}

	const store = await loadTokens();
	const token = store.tokens.find((entry) => entry.id === parts.id);
	const hash = digest(parts.secret);

	// the digest comparison runs even for an unknown id, against a throwaway value,
	// so a miss costs what a hit costs
	const expected = token?.secretHash ?? digest(parts.id);

	if (!sameDigest(expected, hash) || !token || !token.enabled || isExpired(token)) {
		return null;
	}

	return {
		id: token.id,
		name: token.name,
		scope: token.scope,
		tools: allowedTools(token.scope).map((tool) => tool.name),
	};
}

// -- call log ------------------------------------------------------------------

/** Who a call was made for, as the client reports it; informational, not verified. */
export interface McpOnBehalfOf {
	/** A human-readable label, e.g. a Discord username */
	label?: string;
	/** Free-form identifiers the client sent (user id, guild, channel, message) */
	[key: string]: unknown;
}

export interface McpCallRecord {
	t: number;
	token: string;
	tokenName: string;
	/** `tools/call` name, or the method for non-tool requests worth recording */
	tool: string;
	/** Arguments as JSON, secret-looking keys redacted, truncated past the cap */
	args?: string;
	ok: boolean;
	error?: string;
	durationMs: number;
	onBehalfOf?: McpOnBehalfOf;
	client?: string;
	ip?: string;
}

export interface McpCallInput extends Omit<McpCallRecord, "t" | "args"> {
	args?: unknown;
}

function callsDir(): string {
	return join(root(), "logs", "mcp");
}

function monthKey(at: number): string {
	const date = new Date(at);
	const month = String(date.getMonth() + 1).padStart(2, "0");

	return `${date.getFullYear()}-${month}`;
}

function redact(value: unknown, depth = 0): unknown {
	if (depth > 6 || typeof value !== "object" || value === null) {
		return value;
	}

	if (Array.isArray(value)) {
		return value.map((entry) => redact(entry, depth + 1));
	}

	const out: Record<string, unknown> = {};

	for (const [key, child] of Object.entries(value)) {
		out[key] = SECRET_ARG.test(key)
			? "[redacted]"
			: redact(child, depth + 1);
	}

	return out;
}

function recordedArgs(args: unknown): string | undefined {
	if (args === undefined) {
		return undefined;
	}

	const text = JSON.stringify(redact(args)) ?? "";

	return text.length > MCP_MAX_RECORDED_ARGS
		? `${text.slice(0, MCP_MAX_RECORDED_ARGS)}… [truncated]`
		: text;
}

/**
 * Record one call: a line in the month's call log, the token's counters, and a
 * throttled `lastUsedAt`. Never throws; recording is a side effect of answering,
 * and a full disk must not turn an answered call into a failed one.
 */
export async function recordMcpCall(input: McpCallInput): Promise<void> {
	const record: McpCallRecord = {
		t: Date.now(),
		token: input.token,
		tokenName: input.tokenName,
		tool: input.tool,
		args: recordedArgs(input.args),
		ok: input.ok,
		error: input.error,
		durationMs: input.durationMs,
		onBehalfOf: input.onBehalfOf,
		client: input.client,
		ip: input.ip,
	};

	try {
		await mkdir(callsDir(), { recursive: true });
		await appendFile(join(callsDir(), `${monthKey(record.t)}.ndjson`), JSON.stringify(record) + "\n", "utf8");
	} catch {
		// the call log is never the reason a call fails
	}

	try {
		await serialized(async () => {
			const store = await loadTokens();
			const token = store.tokens.find((entry) => entry.id === input.token);

			if (!token) {
				return;
			}

			token.stats.calls += 1;

			if (!input.ok) {
				token.stats.failures += 1;
			}

			const stale = !token.lastUsedAt || record.t - token.lastUsedAt >= MCP_TOUCH_MS;

			token.lastUsedAt = record.t;

			// counters ride along with the throttled touch: losing a minute of counts
			// to a crash is cheaper than rewriting the store on every call
			if (stale || !input.ok) {
				await saveTokens(store);
			}
		});
	} catch {
		// same as above
	}
}

export interface McpCallQuery {
	token?: string;
	tool?: string;
	ok?: boolean;
	since?: number;
	search?: string;
	limit?: number;
}

export interface McpCallPage {
	calls: McpCallRecord[];
	truncated: boolean;
}

function parseCall(line: string): McpCallRecord | undefined {
	if (!line.trim()) {
		return undefined;
	}

	try {
		const record = JSON.parse(line) as McpCallRecord;

		if (typeof record.t !== "number" || typeof record.tool !== "string") {
			return undefined;
		}

		return record;
	} catch {
		return undefined;
	}
}

function callPasses(record: McpCallRecord, query: McpCallQuery): boolean {
	if (query.token && record.token !== query.token) {
		return false;
	}

	if (query.tool && record.tool !== query.tool) {
		return false;
	}

	if (query.ok !== undefined && record.ok !== query.ok) {
		return false;
	}

	if (query.since !== undefined && record.t < query.since) {
		return false;
	}

	if (query.search) {
		const needle = query.search.toLowerCase();
		const behalf = record.onBehalfOf
			? JSON.stringify(record.onBehalfOf)
			: "";
		const haystack = `${record.tool} ${record.tokenName} ${record.args ?? ""} ${record.error ?? ""} ${behalf}`.toLowerCase();

		if (!haystack.includes(needle)) {
			return false;
		}
	}

	return true;
}

/** Read the call log, newest first, walking months backwards until the limit is met. */
export async function readMcpCalls(query: McpCallQuery = {}): Promise<McpCallPage> {
	const dir = callsDir();
	const wanted = Math.min(Math.max(1, query.limit ?? DEFAULT_MCP_CALLS), MAX_MCP_CALLS);

	if (!existsSync(dir)) {
		return { calls: [], truncated: false };
	}

	const names = (await readdir(dir)).filter((name) => name.endsWith(".ndjson")).sort().reverse();
	const calls: McpCallRecord[] = [];

	for (const name of names) {
		const path = join(dir, name);
		const info = await stat(path);
		const file = Bun.file(path);
		const text = info.size > MAX_READ_BYTES
			? await file.slice(info.size - MAX_READ_BYTES).text()
			: await file.text();
		const lines = text.split("\n");

		for (let i = lines.length - 1; i >= 0; i--) {
			const record = parseCall(lines[i]!);

			if (!record || !callPasses(record, query)) {
				continue;
			}

			if (calls.length >= wanted) {
				return { calls, truncated: true };
			}

			calls.push(record);
		}
	}

	return { calls, truncated: false };
}

// -- knowledge -----------------------------------------------------------------

/**
 * What a knowledge item is to the endpoint:
 *
 * - `context`: a standing document; pinned ones go into the `initialize`
 *   instructions, all of them are readable as resources and through `context_get`.
 * - `memory`: a short fact, searchable; pinned ones also go into the instructions.
 * - `skill`: a named procedure, listed by description and read on demand, as a
 *   prompt and through `skill_get`.
 */
export type KnowledgeKind = "context" | "memory" | "skill";

export const KNOWLEDGE_KINDS: KnowledgeKind[] = ["context", "memory", "skill"];

const ID_PREFIX: Record<KnowledgeKind, string> = { context: "ctx", memory: "mem", skill: "skill" };

export type KnowledgeScope = { kind: "console" } | { kind: "token"; token: string };

export interface KnowledgeItem {
	id: string;
	kind: KnowledgeKind;
	scope: KnowledgeScope;
	/** For a skill, its slug name */
	title: string;
	description: string;
	/** Markdown */
	body: string;
	tags: string[];
	pinned: boolean;
	enabled: boolean;
	createdAt: number;
	createdBy?: string;
	updatedAt: number;
	updatedBy?: string;
	expiresAt?: number;
}

interface KnowledgeStore {
	items: KnowledgeItem[];
}

export interface KnowledgeInput {
	kind: KnowledgeKind;
	scope?: KnowledgeScope;
	title: string;
	description?: string;
	body: string;
	tags?: string[];
	pinned?: boolean;
	enabled?: boolean;
	expiresAt?: number | null;
}

export type KnowledgePatch = Partial<Omit<KnowledgeInput, "kind">>;

export interface KnowledgeFilter {
	kind?: KnowledgeKind;
	/** `"console"`, or a token id/name for that token's items */
	scope?: string;
	search?: string;
}

/** Longest knowledge body the store accepts. */
export const MAX_KNOWLEDGE_BODY = 64 * 1024;

async function loadKnowledge(): Promise<KnowledgeStore> {
	if (!existsSync(knowledgePath())) {
		return { items: [] };
	}

	const store: KnowledgeStore = await Bun.file(knowledgePath()).json();

	store.items ??= [];

	const now = Date.now();

	store.items = store.items.filter((item) => !item.expiresAt || item.expiresAt > now);

	return store;
}

async function saveKnowledge(store: KnowledgeStore): Promise<void> {
	await Bun.write(knowledgePath(), JSON.stringify({ items: store.items }, null, "\t") + "\n");
}

function scopeLabel(scope: KnowledgeScope, tokens: McpToken[]): string {
	if (scope.kind === "console") {
		return "console";
	}

	const token = tokens.find((entry) => entry.id === scope.token);

	return `token ${token?.name ?? scope.token}`;
}

function cleanTags(tags: string[] | undefined): string[] {
	return [...new Set((tags ?? []).map((tag) => tag.trim().toLowerCase()).filter((tag) => tag !== ""))].slice(0, 20);
}

function validateItem(item: KnowledgeItem, items: KnowledgeItem[], tokens: McpToken[]): void {
	if (!KNOWLEDGE_KINDS.includes(item.kind)) {
		throw new Error(t("core.mcp.badKnowledgeKind"));
	}

	if (!item.title.trim()) {
		throw new Error(t("core.mcp.titleRequired"));
	}

	if (item.body.length > MAX_KNOWLEDGE_BODY) {
		throw new Error(t("core.mcp.bodyTooLong", { max: MAX_KNOWLEDGE_BODY }));
	}

	if (item.scope.kind === "token") {
		const tokenId = item.scope.token;

		if (!tokens.some((token) => token.id === tokenId)) {
			throw new Error(t("core.mcp.unknownToken", { name: tokenId }));
		}
	}

	if (item.kind !== "skill") {
		return;
	}

	if (!SKILL_NAME_PATTERN.test(item.title)) {
		throw new Error(t("core.mcp.badSkillName"));
	}

	// two skills of one name visible to the same token would make skill_get a coin
	// toss, so a name is unique within its scope and across console-wide skills
	const clash = items.find((other) => {
		if (other.id === item.id || other.kind !== "skill" || other.title !== item.title) {
			return false;
		}

		return other.scope.kind === "console"
			|| item.scope.kind === "console"
			|| (other.scope.kind === "token" && item.scope.kind === "token" && other.scope.token === item.scope.token);
	});

	if (clash) {
		throw new Error(t("core.mcp.skillNameTaken", { name: item.title }));
	}
}

function resolveScopeArg(scope: KnowledgeScope | undefined, tokens: McpToken[]): KnowledgeScope {
	if (!scope || scope.kind === "console") {
		return { kind: "console" };
	}

	const wanted = scope.token.toLowerCase();
	const token = tokens.find((entry) => entry.id === scope.token || entry.name.toLowerCase() === wanted);

	if (!token) {
		throw new Error(t("core.mcp.unknownToken", { name: scope.token }));
	}

	return { kind: "token", token: token.id };
}

/** Knowledge items, newest-edited first, narrowed by kind, scope and text. */
export async function listKnowledge(filter: KnowledgeFilter = {}): Promise<KnowledgeItem[]> {
	const [store, tokens] = await Promise.all([loadKnowledge(), loadTokens()]);
	let items = store.items;

	if (filter.kind) {
		items = items.filter((item) => item.kind === filter.kind);
	}

	if (filter.scope === "console") {
		items = items.filter((item) => item.scope.kind === "console");
	} else if (filter.scope) {
		const token = findToken(tokens, filter.scope);
		const id = token?.id ?? filter.scope;

		items = items.filter((item) => item.scope.kind === "token" && item.scope.token === id);
	}

	if (filter.search) {
		const needle = filter.search.toLowerCase();

		items = items.filter((item) =>
			`${item.title} ${item.description} ${item.body} ${item.tags.join(" ")}`.toLowerCase().includes(needle),
		);
	}

	return [...items].sort((left, right) => right.updatedAt - left.updatedAt);
}

/** One knowledge item by id. */
export async function getKnowledge(id: string): Promise<KnowledgeItem | undefined> {
	const store = await loadKnowledge();

	return store.items.find((item) => item.id === id);
}

/**
 * Everything one token can see: console-wide items plus its own, enabled only.
 * What the endpoint reads for every knowledge tool and for `initialize`.
 */
export async function knowledgeFor(tokenId: string, kind?: KnowledgeKind): Promise<KnowledgeItem[]> {
	const store = await loadKnowledge();

	return store.items
		.filter((item) => item.enabled)
		.filter((item) => !kind || item.kind === kind)
		.filter((item) => item.scope.kind === "console" || item.scope.token === tokenId)
		.sort((left, right) => right.updatedAt - left.updatedAt);
}

/** Create a knowledge item. */
export async function createKnowledge(input: KnowledgeInput, actor?: string): Promise<KnowledgeItem> {
	return await serialized(async () => {
		const [store, tokenStore] = await Promise.all([loadKnowledge(), loadTokens()]);
		const now = Date.now();

		const item: KnowledgeItem = {
			id: newId(ID_PREFIX[input.kind]),
			kind: input.kind,
			scope: resolveScopeArg(input.scope, tokenStore.tokens),
			title: input.title.trim(),
			description: input.description?.trim() ?? "",
			body: input.body,
			tags: cleanTags(input.tags),
			pinned: !!input.pinned,
			enabled: input.enabled ?? true,
			createdAt: now,
			createdBy: actor,
			updatedAt: now,
			updatedBy: actor,
			expiresAt: input.expiresAt ?? undefined,
		};

		validateItem(item, store.items, tokenStore.tokens);

		store.items.push(item);

		recordAudit(tokenStore, {
			action: "knowledge.create",
			item: item.id,
			token: item.scope.kind === "token" ? item.scope.token : undefined,
			actor,
			detail: `${item.kind} "${item.title}" · ${scopeLabel(item.scope, tokenStore.tokens)}`,
		});

		await saveKnowledge(store);
		await saveTokens(tokenStore);

		return item;
	});
}

/**
 * Change a knowledge item. `onlyScope`, when given, refuses an item outside it;
 * that is how an MCP token is kept to editing what it may see.
 */
export async function updateKnowledge(
	id: string,
	patch: KnowledgePatch,
	actor?: string,
	onlyScope?: string,
): Promise<KnowledgeItem> {
	return await serialized(async () => {
		const [store, tokenStore] = await Promise.all([loadKnowledge(), loadTokens()]);
		const item = store.items.find((entry) => entry.id === id);

		if (!item || !visibleTo(item, onlyScope)) {
			throw new Error(t("core.mcp.unknownKnowledge", { id }));
		}

		const next: KnowledgeItem = {
			...item,
			scope: patch.scope
				? resolveScopeArg(patch.scope, tokenStore.tokens)
				: item.scope,
			title: patch.title?.trim() ?? item.title,
			description: patch.description?.trim() ?? item.description,
			body: patch.body ?? item.body,
			tags: patch.tags
				? cleanTags(patch.tags)
				: item.tags,
			pinned: patch.pinned ?? item.pinned,
			enabled: patch.enabled ?? item.enabled,
			expiresAt: patch.expiresAt === null
				? undefined
				: patch.expiresAt ?? item.expiresAt,
			updatedAt: Date.now(),
			updatedBy: actor,
		};

		validateItem(next, store.items, tokenStore.tokens);

		Object.assign(item, next);

		recordAudit(tokenStore, {
			action: "knowledge.update",
			item: item.id,
			token: item.scope.kind === "token" ? item.scope.token : undefined,
			actor,
			detail: `${item.kind} "${item.title}" · ${scopeLabel(item.scope, tokenStore.tokens)}`,
		});

		await saveKnowledge(store);
		await saveTokens(tokenStore);

		return item;
	});
}

/** Remove a knowledge item; `onlyScope` as for `updateKnowledge`. */
export async function removeKnowledge(id: string, actor?: string, onlyScope?: string): Promise<KnowledgeItem> {
	return await serialized(async () => {
		const [store, tokenStore] = await Promise.all([loadKnowledge(), loadTokens()]);
		const item = store.items.find((entry) => entry.id === id);

		if (!item || !visibleTo(item, onlyScope)) {
			throw new Error(t("core.mcp.unknownKnowledge", { id }));
		}

		store.items = store.items.filter((entry) => entry !== item);

		recordAudit(tokenStore, {
			action: "knowledge.remove",
			item: item.id,
			token: item.scope.kind === "token" ? item.scope.token : undefined,
			actor,
			detail: `${item.kind} "${item.title}" · ${scopeLabel(item.scope, tokenStore.tokens)}`,
		});

		await saveKnowledge(store);
		await saveTokens(tokenStore);

		return item;
	});
}

/**
 * Whether a token id may touch an item. Console-wide items are readable by every
 * token but writable only from the console, so a bot cannot rewrite the shared
 * notes every other client reads.
 */
function visibleTo(item: KnowledgeItem, tokenId: string | undefined): boolean {
	if (tokenId === undefined) {
		return true;
	}

	return item.scope.kind === "token" && item.scope.token === tokenId;
}

export interface MemoryHit {
	item: KnowledgeItem;
	score: number;
}

function terms(text: string): string[] {
	return text
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.split(/[^\p{L}\p{N}]+/u)
		.filter((term) => term.length > 1);
}

/**
 * Rank a token's visible memories against a query. Keyword scoring over title,
 * tags and body (weighted in that order), diacritics folded so Vietnamese notes
 * match an unaccented query, plus a small bonus for pinned and recent items.
 */
export async function searchMemories(tokenId: string, query: string, limit = 8): Promise<MemoryHit[]> {
	const memories = await knowledgeFor(tokenId, "memory");
	const wanted = terms(query);

	if (wanted.length === 0) {
		return memories.slice(0, limit).map((item) => ({ item, score: 0 }));
	}

	const now = Date.now();
	const hits: MemoryHit[] = [];

	for (const item of memories) {
		const title = terms(item.title);
		const tags = item.tags.flatMap(terms);
		const body = terms(`${item.description} ${item.body}`);
		let score = 0;

		for (const term of wanted) {
			const inTitle = title.some((word) => word.startsWith(term));
			const inTags = tags.some((word) => word.startsWith(term));
			const inBody = body.filter((word) => word.startsWith(term)).length;

			score += (inTitle ? 3 : 0) + (inTags ? 2 : 0) + Math.min(inBody, 3);
		}

		if (score === 0) {
			continue;
		}

		const ageDays = (now - item.updatedAt) / 86_400_000;

		score += (item.pinned ? 1 : 0) + Math.max(0, 1 - ageDays / 90);

		hits.push({ item, score });
	}

	return hits.sort((left, right) => right.score - left.score).slice(0, limit);
}

/**
 * The `initialize` instructions for a token: pinned context documents in full,
 * then pinned memories, then a pointer to the knowledge tools it can use. Empty
 * when there is nothing pinned and no knowledge tool in scope.
 */
export async function mcpInstructions(principal: McpPrincipal): Promise<string> {
	const items = await knowledgeFor(principal.id);
	const pinnedContext = items.filter((item) => item.kind === "context" && item.pinned);
	const pinnedMemories = items.filter((item) => item.kind === "memory" && item.pinned);
	const skills = items.filter((item) => item.kind === "skill");
	const sections: string[] = [];

	for (const item of pinnedContext) {
		sections.push(`## ${item.title}\n\n${item.body.trim()}`);
	}

	if (pinnedMemories.length > 0) {
		const lines = pinnedMemories.map((item) => `- ${item.title}: ${item.body.trim().replace(/\s+/g, " ")}`);

		sections.push(`## Things to remember\n\n${lines.join("\n")}`);
	}

	const hints: string[] = [];

	if (principal.tools.includes("memory_search")) {
		hints.push("search saved memories with memory_search before answering questions about past events or conventions");
	}

	if (principal.tools.includes("skill_list") && skills.length > 0) {
		hints.push(`${skills.length} skill(s) are available; call skill_list and follow a matching skill with skill_get`);
	}

	if (principal.tools.includes("memory_save")) {
		hints.push("save durable lessons with memory_save");
	}

	if (hints.length > 0) {
		sections.push(`## Using luna's knowledge\n\n${hints.map((hint) => `- ${hint}`).join("\n")}`);
	}

	return sections.join("\n\n");
}

/** The build the endpoint reports as its `serverInfo.version`: the daemon's own. */
export function mcpServerVersion(): string {
	return buildVersion();
}
