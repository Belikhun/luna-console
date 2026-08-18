// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Client for the LunaCore HTTP API on the Velocity proxy.
 *
 * LunaCore serves network-wide telemetry, the player list and administrative
 * actions at `http://<proxy>:<http.port><http.pathPrefix>`, authenticated with the
 * Velocity forwarding secret; the credential backends already hold, so the console
 * needs no separate one. Both the port and the secret are read from the proxy's own
 * files rather than hardcoded, so moving either is a config change, not a code
 * change.
 *
 * Every read here is best-effort: the proxy may be stopped, LunaCore may be an
 * older build without a route, and neither is an error the console should die on.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { root } from "../config";

/** Where LunaCore keeps its Velocity-side config, relative to the proxy directory. */
const CORE_CONFIG = join("plugins", "lunacore", "config.yml");

const DEFAULT_PORT = 32452;
const DEFAULT_PREFIX = "/api";
const DEFAULT_HOST = "127.0.0.1";

/** Requests are local; a slow proxy should not stall a console page for long. */
const TIMEOUT_MS = 4000;

export interface LunaEndpoint {
	baseUrl: string;
	secret: string;
	/** Why the endpoint is unusable, when it is */
	problem?: string;
}

let cached: LunaEndpoint | undefined;

/** Read `key: value` out of a flat YAML block without pulling in a parser. */
function readScalar(yaml: string, section: string, key: string): string | undefined {
	const block = new RegExp(`^${section}:\\s*$([\\s\\S]*?)(?=^\\S|\\Z)`, "m").exec(yaml);

	if (!block) {
		return undefined;
	}

	const line = new RegExp(`^\\s+${key}:\\s*(.+)$`, "m").exec(block[1]!);

	if (!line) {
		return undefined;
	}

	return line[1]!.trim().replace(/^["']|["']$/g, "");
}

/**
 * Resolve the proxy's Luna API base URL and token. A working answer is cached for
 * the process; both come from files that only change when the proxy is
 * reconfigured, which requires a restart anyway.
 *
 * A *failed* one is not cached. Installing LunaCore on a proxy that was running
 * without it is an ordinary thing to do, and caching "not installed" would make
 * the daemon keep saying so until someone restarted it - long after the file it
 * looked for appeared.
 */
export async function endpoint(proxyDir = "proxy"): Promise<LunaEndpoint> {
	if (cached) {
		return cached;
	}

	const dir = join(root(), proxyDir);
	const secretPath = join(dir, "forwarding.secret");
	const configPath = join(dir, CORE_CONFIG);

	let port = DEFAULT_PORT;
	let prefix = DEFAULT_PREFIX;
	let enabled = true;

	if (existsSync(configPath)) {
		const yaml = await Bun.file(configPath).text();

		port = Number(readScalar(yaml, "http", "port") ?? DEFAULT_PORT);
		prefix = readScalar(yaml, "http", "pathPrefix") ?? DEFAULT_PREFIX;
		enabled = (readScalar(yaml, "http", "enabled") ?? "true") === "true";
	}

	const secret = existsSync(secretPath) ? (await Bun.file(secretPath).text()).trim() : "";

	const problem = !existsSync(configPath)
		? "LunaCore is not installed on the proxy"
		: !enabled
			? "LunaCore http.enabled is false in the proxy config"
			: !secret
				? "proxy/forwarding.secret is missing or empty"
				: undefined;

	const resolved: LunaEndpoint = {
		baseUrl: `http://${DEFAULT_HOST}:${port}${prefix.startsWith("/") ? prefix : `/${prefix}`}`,
		secret,
		problem,
	};

	if (!problem) {
		cached = resolved;
	}

	return resolved;
}

/** Forget the cached endpoint, so the next call re-reads the proxy's config. */
export function resetEndpoint(): void {
	cached = undefined;
}

export interface LunaResult<T> {
	ok: boolean;
	status: number;
	data?: T;
	error?: string;
	/** Server-reported handling time, milliseconds */
	runtimeMillis?: number;
}

/** The envelope every Luna endpoint wraps its payload in. */
interface Envelope {
	success?: boolean;
	runtimeMillis?: number;
	data?: unknown;
	error?: string;
}

/**
 * Call a Luna endpoint and unwrap its envelope. Network failures, timeouts and
 * non-JSON bodies all come back as a failed result rather than a thrown error, so
 * callers can render "unavailable" instead of handling exceptions.
 */
export async function call<T>(
	path: string,
	opts: { method?: "GET" | "POST"; form?: Record<string, string>; timeoutMs?: number } = {},
): Promise<LunaResult<T>> {
	const target = await endpoint();

	if (target.problem) {
		return { ok: false, status: 0, error: target.problem };
	}

	const headers: Record<string, string> = { "X-Luna-Forwarding-Secret": target.secret };
	let body: string | undefined;

	if (opts.form) {
		headers["Content-Type"] = "application/x-www-form-urlencoded; charset=utf-8";
		body = new URLSearchParams(opts.form).toString();
	}

	try {
		const response = await fetch(`${target.baseUrl}${path}`, {
			method: opts.method ?? (opts.form ? "POST" : "GET"),
			headers,
			body,
			signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
		});

		const text = await response.text();
		let envelope: Envelope | undefined;

		try {
			envelope = JSON.parse(text) as Envelope;
		} catch {
			// an older LunaCore, or a plain-text error from the JDK server
			return {
				ok: false,
				status: response.status,
				error: text.slice(0, 200) || `HTTP ${response.status}`,
			};
		}

		if (!response.ok || envelope.success === false) {
			return {
				ok: false,
				status: response.status,
				error: envelope.error ?? `HTTP ${response.status}`,
				runtimeMillis: envelope.runtimeMillis,
			};
		}

		return {
			ok: true,
			status: response.status,
			data: envelope.data as T,
			runtimeMillis: envelope.runtimeMillis,
		};
	} catch (err) {
		const message = (err as Error)?.name === "TimeoutError"
			? `no response within ${opts.timeoutMs ?? TIMEOUT_MS}ms`
			: ((err as Error)?.message ?? String(err));

		return { ok: false, status: 0, error: message };
	}
}

/**
 * Open a server-sent-events stream. Returns the raw response so the caller can pipe
 * the body straight through; the web console re-serves these to the browser, and
 * re-framing the events on the way would only add a place for them to be lost.
 *
 * Pass the incoming request's signal as `signal`: aborting it tears down this
 * upstream connection, which is what makes LunaCore drop the subscriber. The body
 * cannot be cancelled by hand once it has been handed to a `Response`; that locks
 * the stream; so the signal is the only way to close it early.
 */
export async function openStream(path: string, signal?: AbortSignal): Promise<Response> {
	const target = await endpoint();

	if (target.problem) {
		throw new Error(target.problem);
	}

	return await fetch(`${target.baseUrl}${path}`, {
		headers: {
			"X-Luna-Forwarding-Secret": target.secret,
			Accept: "text/event-stream",
		},
		signal,
	});
}

/**
 * What one world is holding, as the backend counted it.
 *
 * Every counter is nullable because a platform that cannot measure one reports
 * it absent rather than zero: Pumpkin's sandbox can list a world's entities but
 * has no way to ask how many chunks are resident, and a zero there would draw an
 * empty world.
 */
export interface BackendWorldStats {
	name: string;
	loadedChunks: number | null;
	tickingEntities: number | null;
	nonTickingEntities: number | null;
}

export interface BackendMetrics {
	onlinePlayers: number;
	maxPlayers: number;
	playerUsagePercent: number;
	tps: number;
	systemCpuUsagePercent: number;
	processCpuUsagePercent: number;
	heartbeatLatencyMillis: number;
	ramUsedBytes: number;
	ramFreeBytes: number;
	ramMaxBytes: number;
	ramUsagePercent: number;
	uptimeMillis: number;
	whitelistEnabled: boolean;

	// Everything below arrives only from a backend running a plugin new enough to
	// report it, so all of it is optional as well as nullable: `undefined` means
	// the proxy never sent the field, `null` means it did and the backend had not
	// measured it. Both render as absent; neither is zero.

	/** Chunks loaded across every world. */
	loadedChunks?: number | null;
	tickingEntities?: number | null;
	nonTickingEntities?: number | null;
	/** Mean and worst tick over the backend's own window. */
	tickMeanMillis?: number | null;
	tickMaxMillis?: number | null;
	/** 0-1; satisfied plus half the tolerating, over every tick in the window. */
	apdex?: number | null;
	/** 0-1; the share of player-time that elapsed during ticks slow enough to feel. */
	misery?: number | null;
	worlds?: BackendWorldStats[];
}

export interface BackendCard {
	id: string;
	name: string;
	displayName: string;
	accentColor: string;
	hostName: string;
	/** ONLINE | MAINT | OFFLINE */
	status: string;
	online: boolean;
	lastHeartbeatEpochMillis: number;
	description: string[];
	metrics: BackendMetrics;
}

export interface NetworkSummary {
	onlinePlayers: number;
	onlineServerCount: number;
	averageTps: number;
	averageCpu: number;
	averageLatencyMillis: number;
	totalRamUsedBytes: number;
	totalRamMaxBytes: number;
	longestUptimeMillis: number;
}

export interface DashboardSnapshot {
	generatedAtEpochMillis: number;
	/** healthy | degraded | critical */
	overallHealth: string;
	counts: { total: number; online: number; maint: number; offline: number };
	summary: NetworkSummary;
	backends: BackendCard[];
}

/** Network-wide telemetry for every backend the proxy knows, externals included. */
export async function dashboard(): Promise<LunaResult<DashboardSnapshot>> {
	return await call<DashboardSnapshot>("/dashboard/backends");
}

export interface BackendDetail extends BackendCard {
	stats: {
		software: string;
		version: string;
		serverPort: number;
		motd: string;
		[key: string]: unknown;
	};
}

/** Telemetry plus server identity for one backend. */
export async function backend(name: string): Promise<LunaResult<BackendDetail>> {
	return await call<BackendDetail>(`/dashboard/backends/${encodeURIComponent(name)}`);
}

export interface LunaPlayer {
	uuid: string;
	username: string;
	server: string;
	pingMillis: number;
	sessionMillis: number;
	connectedAtEpochMillis: number;
	remoteAddress: string;
	virtualHost: string;
	protocolVersion: number;
	clientVersion: string;
	onlineMode: boolean;
}

export interface PlayerList {
	generatedAtEpochMillis: number;
	onlineCount: number;
	byServer: Record<string, number>;
	players: LunaPlayer[];
}

/** Everyone connected to the network, optionally filtered to one backend. */
export async function players(server?: string): Promise<LunaResult<PlayerList>> {
	const query = server ? `?server=${encodeURIComponent(server)}` : "";

	return await call<PlayerList>(`/players${query}`);
}

export interface PlayerActivity {
	/** join | leave | switch */
	type: string;
	uuid: string;
	username: string;
	server: string;
	previousServer: string;
	atEpochMillis: number;
	sessionMillis: number;
}

/** Recent join/leave/switch activity, newest first. */
export async function playerHistory(limit = 50): Promise<LunaResult<{ activity: PlayerActivity[] }>> {
	return await call<{ activity: PlayerActivity[] }>(`/players/history?limit=${limit}`);
}

/** One player's resource-pack state, as LunaPackLoader tracks it. */
export interface PackSession {
	uuid: string;
	username: string;
	server: string;
	/** Pack names the client has applied */
	loaded: string[];
	/** Pack names sent and not yet accepted or declined */
	pending: string[];
	lastFailure: string;
}

export interface PackSessionList {
	generatedAtEpochMillis: number;
	onlineCount: number;
	players: PackSession[];
}

/**
 * Who is holding which resource pack right now. Served by LunaPackLoader rather
 * than LunaCore, so an older pack plugin answers 404; the caller renders that
 * as "unavailable", never as "nobody has it".
 */
export async function packSessions(): Promise<LunaResult<PackSessionList>> {
	return await call<PackSessionList>("/packs/sessions");
}

/**
 * The format range the proxy filters a pack by: what the zip's pack.mcmeta
 * declares, normalized. `clamped` marks a legacy declaration whose ceiling the
 * proxy pulled down to 64, since 1.21.9+ clients reject the file past that.
 */
export interface PackFormatInfo {
	min: string;
	max: string;
	source: string;
	clamped: boolean;
}

/** One pack as the proxy resolved it: the URL and hash clients are actually given. */
export interface ResolvedPackInfo {
	name: string;
	normalizedName: string;
	filename: string;
	priority: number;
	required: boolean;
	enabled: boolean;
	servers: string[];
	url: string;
	sha1: string;
	sizeBytes: number;
	available: boolean;
	unavailableReason: string;
	/** Absent on packs with no declared range, and on older luna-pack builds */
	formats?: PackFormatInfo;
}

export interface PackCatalog {
	generatedAtEpochMillis: number;
	report: {
		discoveredFiles: number;
		validDefinitions: number;
		invalidDefinitions: number;
		resolvedAvailable: number;
		resolvedMissingFiles: number;
		resolvedInvalidUrls: number;
	};
	packs: ResolvedPackInfo[];
}

/** The pack catalog the running proxy holds; its view, not the directory's. */
export async function packCatalog(): Promise<LunaResult<PackCatalog>> {
	return await call<PackCatalog>("/packs/catalog");
}

export interface CommandResult {
	command: string;
	handled: boolean;
	output: string[];
}

/**
 * Run a command on the proxy console and return what it printed. Unlike the
 * screen-based path, this reports the command's actual reply.
 */
export async function runCommand(command: string): Promise<LunaResult<CommandResult>> {
	return await call<CommandResult>("/admin/command", { form: { command } });
}

/** Send a MiniMessage-formatted message to the network, or to one backend. */
export async function broadcast(
	message: string,
	server?: string,
): Promise<LunaResult<{ reached: number; server: string }>> {
	const form: Record<string, string> = { message };

	if (server) {
		form.server = server;
	}

	return await call<{ reached: number; server: string }>("/admin/broadcast", { form });
}

/** Disconnect a player, by name or UUID. */
export async function kick(player: string, reason = ""): Promise<LunaResult<{ username: string }>> {
	return await call<{ username: string }>(
		`/admin/players/${encodeURIComponent(player)}/kick`,
		{ form: { reason } },
	);
}

/** Send one player a message. */
export async function message(
	player: string,
	text: string,
): Promise<LunaResult<{ username: string }>> {
	return await call<{ username: string }>(
		`/admin/players/${encodeURIComponent(player)}/message`,
		{ form: { message: text } },
	);
}

export interface TransferResult {
	username: string;
	server: string;
	status: string;
	successful: boolean;
	reason: string;
}

/** Move a player to another backend, reporting what the target decided. */
export async function transfer(player: string, server: string): Promise<LunaResult<TransferResult>> {
	return await call<TransferResult>(
		`/admin/players/${encodeURIComponent(player)}/transfer`,
		{ form: { server }, timeoutMs: 8000 },
	);
}

// ---------------------------------------------------------------------------
// Player directory; profiles LunaCore persists in the shared database
// ---------------------------------------------------------------------------

/** One persisted player profile, merged with live session state when online. */
export interface RegisteredPlayer {
	uuid: string;
	username: string;
	firstSeenAtEpochMillis: number;
	lastSeenAtEpochMillis: number;
	lastServer: string;
	lastAddress: string;
	lastClientVersion: string;
	onlineMode: boolean;
	sessionCount: number;
	hasSkin: boolean;
	online: boolean;
	/** Current backend when online, empty otherwise */
	server: string;
	pingMillis: number;
	sessionMillis: number;
	/** Closed playtime plus the open session when online */
	totalPlayMillis: number;
}

export interface RegisteredPlayerList {
	generatedAtEpochMillis: number;
	total: number;
	offset: number;
	limit: number;
	players: RegisteredPlayer[];
}

export interface RegisteredPlayerQuery {
	search?: string;
	/** username | firstSeen | lastSeen | playtime | sessions */
	sort?: string;
	dir?: "asc" | "desc";
	limit?: number;
	offset?: number;
}

/** Every player the proxy has ever recorded, paged and searchable. */
export async function registeredPlayers(
	query: RegisteredPlayerQuery = {},
): Promise<LunaResult<RegisteredPlayerList>> {
	const params = new URLSearchParams();

	if (query.search) {
		params.set("search", query.search);
	}

	if (query.sort) {
		params.set("sort", query.sort);
	}

	if (query.dir) {
		params.set("dir", query.dir);
	}

	if (query.limit !== undefined) {
		params.set("limit", String(query.limit));
	}

	if (query.offset !== undefined) {
		params.set("offset", String(query.offset));
	}

	const suffix = params.size > 0 ? `?${params.toString()}` : "";

	return await call<RegisteredPlayerList>(`/players/registered${suffix}`);
}

export interface PlayerPermissionsSummary {
	available: boolean;
	primaryGroup?: string;
	primaryGroupDisplay?: string;
	prefix?: string;
	suffix?: string;
}

export interface PlayerServerPlaytime {
	server: string;
	playMillis: number;
	stints: number;
}

/** Full detail for one registered player. */
export interface RegisteredPlayerDetail extends RegisteredPlayer {
	/** Base64 game-profile texture payload, when a skin was captured */
	skinTexture: string | null;
	skinSignature: string | null;
	playtimeByServer: PlayerServerPlaytime[];
	sessionTotal: number;
	chatTotal: number;
	commandTotal: number;
	moderationTotal: number;
	permissions: PlayerPermissionsSummary;
}

/** One registered player by name or UUID, with aggregates and permissions. */
export async function registeredPlayer(player: string): Promise<LunaResult<RegisteredPlayerDetail>> {
	return await call<RegisteredPlayerDetail>(`/players/registered/${encodeURIComponent(player)}`);
}

export interface PlaySession {
	id: number;
	server: string;
	connectedAtEpochMillis: number;
	disconnectedAtEpochMillis: number;
	durationMillis: number;
	open: boolean;
}

export interface PlaySessionPage {
	total: number;
	offset: number;
	limit: number;
	sessions: PlaySession[];
}

/** A page of one player's per-backend play sessions, newest first. */
export async function playerSessions(
	player: string,
	opts: { limit?: number; offset?: number } = {},
): Promise<LunaResult<PlaySessionPage>> {
	const params = new URLSearchParams();

	if (opts.limit !== undefined) {
		params.set("limit", String(opts.limit));
	}

	if (opts.offset !== undefined) {
		params.set("offset", String(opts.offset));
	}

	const suffix = params.size > 0 ? `?${params.toString()}` : "";

	return await call<PlaySessionPage>(
		`/players/registered/${encodeURIComponent(player)}/sessions${suffix}`,
	);
}

export interface PlayerChatEntry {
	id: number;
	server: string;
	/** chat | command */
	type: string;
	content: string;
	atEpochMillis: number;
}

export interface PlayerChatPage {
	total: number;
	offset: number;
	limit: number;
	entries: PlayerChatEntry[];
}

/** A page of one player's chat and command log, newest first. */
export async function playerChat(
	player: string,
	opts: { type?: "chat" | "command"; limit?: number; offset?: number } = {},
): Promise<LunaResult<PlayerChatPage>> {
	const params = new URLSearchParams();

	if (opts.type) {
		params.set("type", opts.type);
	}

	if (opts.limit !== undefined) {
		params.set("limit", String(opts.limit));
	}

	if (opts.offset !== undefined) {
		params.set("offset", String(opts.offset));
	}

	const suffix = params.size > 0 ? `?${params.toString()}` : "";

	return await call<PlayerChatPage>(
		`/players/registered/${encodeURIComponent(player)}/chat${suffix}`,
	);
}

export interface ModerationEntry {
	id: number;
	action: string;
	actor: string;
	reason: string;
	server: string;
	details: string;
	atEpochMillis: number;
}

export interface ModerationPage {
	total: number;
	offset: number;
	limit: number;
	entries: ModerationEntry[];
}

/** A page of one player's moderation history, newest first. */
export async function playerModeration(
	player: string,
	opts: { limit?: number; offset?: number } = {},
): Promise<LunaResult<ModerationPage>> {
	const params = new URLSearchParams();

	if (opts.limit !== undefined) {
		params.set("limit", String(opts.limit));
	}

	if (opts.offset !== undefined) {
		params.set("offset", String(opts.offset));
	}

	const suffix = params.size > 0 ? `?${params.toString()}` : "";

	return await call<ModerationPage>(
		`/players/registered/${encodeURIComponent(player)}/moderation${suffix}`,
	);
}

export interface ModerationLogEntry extends ModerationEntry {
	targetUuid: string;
	targetName: string;
}

export interface ModerationLogPage {
	total: number;
	offset: number;
	limit: number;
	/** Distinct actions present in the whole log, for filter menus */
	actions: string[];
	entries: ModerationLogEntry[];
}

/**
 * A page of the whole network's moderation history, newest first, across every
 * target. `search` matches the target's name or id and the actor; `action`
 * narrows to one verb. Needs a LunaCore build serving GET /moderation/log.
 */
export async function moderationLog(
	opts: { search?: string; action?: string; limit?: number; offset?: number } = {},
): Promise<LunaResult<ModerationLogPage>> {
	const params = new URLSearchParams();

	if (opts.search) {
		params.set("search", opts.search);
	}

	if (opts.action) {
		params.set("action", opts.action);
	}

	if (opts.limit !== undefined) {
		params.set("limit", String(opts.limit));
	}

	if (opts.offset !== undefined) {
		params.set("offset", String(opts.offset));
	}

	const suffix = params.size > 0 ? `?${params.toString()}` : "";

	return await call<ModerationLogPage>(`/moderation/log${suffix}`);
}

export interface ModerationRecord {
	action: string;
	targetName?: string;
	targetUuid?: string;
	actor?: string;
	reason?: string;
	server?: string;
	details?: string;
}

/**
 * Append an entry to a player's moderation log. The daemon calls this for every
 * moderation action it performs itself (bans, whitelist changes, op grants), so
 * the history LunaCore serves stays complete.
 */
export async function recordModeration(
	record: ModerationRecord,
): Promise<LunaResult<{ action: string; targetUuid: string; targetName: string }>> {
	const form: Record<string, string> = { action: record.action };

	if (record.targetName) {
		form.targetName = record.targetName;
	}

	if (record.targetUuid) {
		form.targetUuid = record.targetUuid;
	}

	if (record.actor) {
		form.actor = record.actor;
	}

	if (record.reason) {
		form.reason = record.reason;
	}

	if (record.server) {
		form.server = record.server;
	}

	if (record.details) {
		form.details = record.details;
	}

	return await call<{ action: string; targetUuid: string; targetName: string }>(
		"/moderation/log",
		{ form },
	);
}

// ---------------------------------------------------------------------------
// Network-level IP bans, enforced by the proxy at pre-login
// ---------------------------------------------------------------------------

export interface NetworkIpBan {
	ip: string;
	reason: string;
	actor: string;
	createdAtEpochMillis: number;
	/** 0 = permanent */
	expiresAtEpochMillis: number;
	/** Refused connection attempts since the ban was placed */
	hits: number;
	lastHitAtEpochMillis: number;
}

/** Every address the proxy refuses at connection time, newest first. */
export async function networkIpBans(): Promise<LunaResult<{ total: number; bans: NetworkIpBan[] }>> {
	return await call<{ total: number; bans: NetworkIpBan[] }>("/network/ip-bans");
}

/**
 * Ban an address at the network level: the proxy denies it at pre-login, so it
 * never reaches a backend, the player directory or the chat relay. Recorded in
 * the moderation log by LunaCore itself.
 */
export async function addNetworkIpBan(
	ip: string,
	opts: { reason?: string; actor?: string; expiresAt?: number } = {},
): Promise<LunaResult<NetworkIpBan>> {
	const form: Record<string, string> = { action: "add", ip };

	if (opts.reason) {
		form.reason = opts.reason;
	}

	if (opts.actor) {
		form.actor = opts.actor;
	}

	if (opts.expiresAt) {
		form.expiresAt = String(opts.expiresAt);
	}

	return await call<NetworkIpBan>("/network/ip-bans", { form });
}

/** Lift a network-level IP ban. */
export async function removeNetworkIpBan(
	ip: string,
	opts: { actor?: string } = {},
): Promise<LunaResult<{ ip: string; removed: boolean }>> {
	const form: Record<string, string> = { action: "remove", ip };

	if (opts.actor) {
		form.actor = opts.actor;
	}

	return await call<{ ip: string; removed: boolean }>("/network/ip-bans", { form });
}

// ---------------------------------------------------------------------------
// Skins; SkinsRestorer administration through the proxy
// ---------------------------------------------------------------------------

export interface SkinInfo {
	uuid: string;
	hasStoredSkin: boolean;
	/** SkinsRestorer's identifier for the stored skin, when one is set */
	skinIdentifier?: string;
	/** player | url | custom | legacy */
	skinType?: string;
}

/** What SkinsRestorer has stored for a player. */
export async function skinInfo(player: string): Promise<LunaResult<SkinInfo>> {
	return await call<SkinInfo>(`/skins/${encodeURIComponent(player)}`);
}

export interface SkinChange {
	/** name = mirror a Mojang account · url = generate via MineSkin ·
	 *  texture = raw signed data · reset = drop the stored skin */
	mode: "name" | "url" | "texture" | "reset";
	/** Mojang account name (mode name) */
	skin?: string;
	/** Public image URL (mode url) */
	url?: string;
	/** classic | slim (mode url; auto-detected when omitted) */
	variant?: string;
	/** Signed texture payload (mode texture) */
	value?: string;
	signature?: string;
	/** Who performed the change; lands in the moderation log */
	actor?: string;
}

export interface SkinChangeResult {
	uuid: string;
	mode: string;
	applied: boolean;
	skinTexture?: string;
	skinSignature?: string;
}

/**
 * Change (or reset) a player's skin through SkinsRestorer on the proxy.
 * MineSkin generation can take a while, hence the generous timeout.
 */
export async function setSkin(player: string, change: SkinChange): Promise<LunaResult<SkinChangeResult>> {
	const form: Record<string, string> = { mode: change.mode };

	if (change.skin) {
		form.skin = change.skin;
	}

	if (change.url) {
		form.url = change.url;
	}

	if (change.variant) {
		form.variant = change.variant;
	}

	if (change.value) {
		form.value = change.value;
	}

	if (change.signature) {
		form.signature = change.signature;
	}

	if (change.actor) {
		form.actor = change.actor;
	}

	return await call<SkinChangeResult>(
		`/skins/${encodeURIComponent(player)}`,
		{ form, timeoutMs: 45000 },
	);
}

// ---------------------------------------------------------------------------
// LuckPerms; groups, nodes and user memberships, managed through the proxy
// ---------------------------------------------------------------------------

export interface PermissionNode {
	key: string;
	value: boolean;
	/** permission | inheritance | prefix | suffix | meta | weight | display_name | regex_permission */
	type: string;
	/** 0 when the node never expires */
	expiryEpochMillis: number;
	contexts: Array<{ key: string; value: string }>;
}

export interface PermissionGroupSummary {
	name: string;
	displayName: string;
	weight: number;
	prefix: string;
	suffix: string;
	parents: string[];
	nodeCount: number;
	memberCount: number;
}

export interface PermissionGroupDetail extends PermissionGroupSummary {
	nodes: PermissionNode[];
	members: Array<{ uuid: string; username: string }>;
}

/** All LuckPerms groups, heaviest weight first. */
export async function permissionGroups(): Promise<LunaResult<{ groups: PermissionGroupSummary[] }>> {
	return await call<{ groups: PermissionGroupSummary[] }>("/permissions/groups", { timeoutMs: 10000 });
}

/** One group with its full node list and direct members. */
export async function permissionGroup(name: string): Promise<LunaResult<PermissionGroupDetail>> {
	return await call<PermissionGroupDetail>(
		`/permissions/groups/${encodeURIComponent(name)}`,
		{ timeoutMs: 10000 },
	);
}

/** Create a LuckPerms group. */
export async function createPermissionGroup(
	name: string,
	opts: { weight?: number; displayName?: string } = {},
): Promise<LunaResult<{ name: string }>> {
	const form: Record<string, string> = { name };

	if (opts.weight !== undefined) {
		form.weight = String(opts.weight);
	}

	if (opts.displayName) {
		form.displayName = opts.displayName;
	}

	return await call<{ name: string }>("/permissions/groups", { form, timeoutMs: 10000 });
}

/** Delete a LuckPerms group (the default group is refused server-side). */
export async function deletePermissionGroup(name: string): Promise<LunaResult<{ name: string }>> {
	const target = await endpoint();

	if (target.problem) {
		return { ok: false, status: 0, error: target.problem };
	}

	try {
		const response = await fetch(`${target.baseUrl}/permissions/groups/${encodeURIComponent(name)}`, {
			method: "DELETE",
			headers: { "X-Luna-Forwarding-Secret": target.secret },
			signal: AbortSignal.timeout(10000),
		});

		const envelope = (await response.json()) as Envelope;

		if (!response.ok || envelope.success === false) {
			return { ok: false, status: response.status, error: envelope.error ?? `HTTP ${response.status}` };
		}

		return { ok: true, status: response.status, data: envelope.data as { name: string } };
	} catch (err) {
		return { ok: false, status: 0, error: (err as Error)?.message ?? String(err) };
	}
}

export interface NodeChange {
	action: "add" | "remove";
	key: string;
	/** For add: grant (true) or negate (false); defaults to true */
	value?: boolean;
	/** For add: seconds until the node expires */
	expirySeconds?: number;
	/** Context pairs, e.g. { server: "survival" } */
	contexts?: Record<string, string>;
}

function nodeChangeForm(change: NodeChange): Record<string, string> {
	const form: Record<string, string> = {
		action: change.action,
		key: change.key,
	};

	if (change.value !== undefined) {
		form.value = String(change.value);
	}

	if (change.expirySeconds !== undefined && change.expirySeconds > 0) {
		form.expirySeconds = String(change.expirySeconds);
	}

	for (const [key, value] of Object.entries(change.contexts ?? {})) {
		form[`context.${key}`] = value;
	}

	return form;
}

/** Add or remove one node on a group; returns the group's updated node list. */
export async function editGroupNode(
	group: string,
	change: NodeChange,
): Promise<LunaResult<{ nodes: PermissionNode[] }>> {
	return await call<{ nodes: PermissionNode[] }>(
		`/permissions/groups/${encodeURIComponent(group)}/nodes`,
		{ form: nodeChangeForm(change), timeoutMs: 10000 },
	);
}

/** Set a group's weight, prefix, suffix or display name (empty value clears). */
export async function editGroupMeta(
	group: string,
	field: "weight" | "prefix" | "suffix" | "displayname",
	value: string,
	priority?: number,
): Promise<LunaResult<PermissionGroupSummary>> {
	const form: Record<string, string> = { field, value };

	if (priority !== undefined) {
		form.priority = String(priority);
	}

	return await call<PermissionGroupSummary>(
		`/permissions/groups/${encodeURIComponent(group)}/meta`,
		{ form, timeoutMs: 10000 },
	);
}

export interface PermissionUserDetail {
	uuid: string;
	username: string;
	primaryGroup: string;
	groups: string[];
	nodes: PermissionNode[];
}

/** One player's LuckPerms data: primary group, memberships and nodes. */
export async function permissionUser(player: string): Promise<LunaResult<PermissionUserDetail>> {
	return await call<PermissionUserDetail>(
		`/permissions/users/${encodeURIComponent(player)}`,
		{ timeoutMs: 10000 },
	);
}

/** Add or remove one node on a user; returns the user's updated node list. */
export async function editUserNode(
	player: string,
	change: NodeChange,
): Promise<LunaResult<{ nodes: PermissionNode[] }>> {
	return await call<{ nodes: PermissionNode[] }>(
		`/permissions/users/${encodeURIComponent(player)}/nodes`,
		{ form: nodeChangeForm(change), timeoutMs: 10000 },
	);
}

/** Change a user's group memberships: add, remove, or set (sole group). */
export async function editUserGroups(
	player: string,
	action: "add" | "remove" | "set",
	group: string,
): Promise<LunaResult<{ primaryGroup: string; groups: string[] }>> {
	return await call<{ primaryGroup: string; groups: string[] }>(
		`/permissions/users/${encodeURIComponent(player)}/groups`,
		{ form: { action, group }, timeoutMs: 10000 },
	);
}

export interface AuthSession {
	hasSession: boolean;
	connected: boolean;
	createdAtEpochMillis: number;
	expiresAtEpochMillis: number;
	ip: string;
}

export interface AuthAccountInfo {
	uuid: string;
	username: string;
	online: boolean;
	/** Passed the password check in the current connection */
	authenticated: boolean;
	/** Has a password on file; a player who never registered has none */
	registered: boolean;
	locked: boolean;
	lockedUntilEpochMillis: number;
	failedAttempts: number;
	lastIp: string;
	lastLoginAtEpochMillis: number;
	createdAtEpochMillis: number;
	updatedAtEpochMillis: number;
	/** The password on file was issued by an admin and expires on its own */
	temporaryPassword: boolean;
	temporaryPasswordUntilEpochMillis: number;
	temporaryPasswordExpired: boolean;
	session: AuthSession;
}

/** A player's authentication state, as luna-auth on the proxy holds it. */
export async function authAccount(player: string): Promise<LunaResult<AuthAccountInfo>> {
	return await call<AuthAccountInfo>(`/auth/accounts/${encodeURIComponent(player)}`);
}

export interface AuthChange {
	/** reset = clear the password · temporary = issue an expiring one ·
	 *  password = set a permanent one · unlock = clear the lockout ·
	 *  logout = drop the current session */
	action: "reset" | "temporary" | "password" | "unlock" | "logout";
	/** The password to set; generated by the proxy when omitted (temporary only) */
	password?: string;
	/** Lifetime of a temporary password, 5 minutes to 30 days */
	expiresInMinutes?: number;
	/** Name to create the account under, when the player never registered */
	username?: string;
	/** Who performed the change; lands in the auth audit log */
	actor?: string;
}

export interface AuthChangeResult extends AuthAccountInfo {
	action: string;
	success: boolean;
	message: string;
	/**
	 * The plaintext of a temporary password; returned by the request that
	 * created it and never again, since only its hash is stored.
	 */
	password?: string;
	generated?: boolean;
	expiresInMinutes?: number;
}

/**
 * Administer a player's password: reset it, issue a temporary one, set a
 * permanent one, unlock the account or force a logout.
 *
 * A connected player is disconnected by the proxy whenever their credential
 * changes, so the new state is the one they come back to.
 */
export async function setAuth(player: string, change: AuthChange): Promise<LunaResult<AuthChangeResult>> {
	const form: Record<string, string> = { action: change.action };

	if (change.password) {
		form.password = change.password;
	}

	if (change.expiresInMinutes) {
		form.expiresInMinutes = String(change.expiresInMinutes);
	}

	if (change.username) {
		form.username = change.username;
	}

	if (change.actor) {
		form.actor = change.actor;
	}

	return await call<AuthChangeResult>(
		`/auth/accounts/${encodeURIComponent(player)}`,
		{ form, timeoutMs: 10000 },
	);
}

export interface VaultCurrency {
	/** The plain symbol, with the money template's MiniMessage tags stripped */
	symbol: string;
	grouping: boolean;
	/** Decimal places a minor amount carries; 100 minor units to the coin */
	scale: number;
}

export interface VaultSummary {
	transactionCount: number;
	receivedMinor: number;
	receivedFormatted: string;
	sentMinor: number;
	sentFormatted: string;
	netMinor: number;
	netFormatted: string;
	firstAtEpochMillis: number;
	lastAtEpochMillis: number;
}

export interface VaultAccountInfo {
	uuid: string;
	username: string;
	online: boolean;
	/** False for a player who has never held money; the balance is then a zero, not a record */
	hasAccount: boolean;
	balanceMinor: number;
	balance: number;
	/** The amount as the server itself prints it, symbol included */
	balanceFormatted: string;
	/** Position on the balance leaderboard, 1-based; 0 when there is no account */
	rank: number;
	accountCount: number;
	currency: VaultCurrency;
	summary: VaultSummary;
}

/** A player's economy state, as LunaVault on the proxy holds it. */
export async function vaultAccount(player: string): Promise<LunaResult<VaultAccountInfo>> {
	return await call<VaultAccountInfo>(`/vault/accounts/${encodeURIComponent(player)}`);
}

export interface VaultTransaction {
	id: string;
	/**
	 * in = the player received · out = the player paid · self = the same player on
	 * both sides, which `/eco` writes when an admin adjusts their own balance and
	 * which carries no recoverable direction
	 */
	direction: "in" | "out" | "self";
	counterpartyUuid: string;
	counterpartyName: string;
	/** The other side is the server itself: an admin grant, a shop, a reward */
	system: boolean;
	amountMinor: number;
	amountFormatted: string;
	/** Which plugin moved the money */
	source: string;
	details: string;
	atEpochMillis: number;
}

export interface VaultTransactionPage {
	uuid: string;
	username: string;
	/** Zero-based */
	page: number;
	pageSize: number;
	/** Index of the last page, so a page equal to it is the end */
	maxPage: number;
	totalCount: number;
	currency: VaultCurrency;
	entries: VaultTransaction[];
}

/** A page of one player's transactions, newest first. */
export async function vaultTransactions(
	player: string,
	page = 0,
	pageSize = 25,
): Promise<LunaResult<VaultTransactionPage>> {
	const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });

	return await call<VaultTransactionPage>(
		`/vault/accounts/${encodeURIComponent(player)}/transactions?${params.toString()}`,
	);
}
