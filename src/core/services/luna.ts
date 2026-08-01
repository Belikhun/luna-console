/**
 * Client for the LunaCore HTTP API on the Velocity proxy.
 *
 * LunaCore serves network-wide telemetry, the player list and administrative
 * actions at `http://<proxy>:<http.port><http.pathPrefix>`, authenticated with the
 * Velocity forwarding secret — the credential backends already hold, so the console
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
 * Resolve the proxy's Luna API base URL and token. Cached for the process — both
 * come from files that only change when the proxy is reconfigured, which requires a
 * restart anyway.
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

	cached = {
		baseUrl: `http://${DEFAULT_HOST}:${port}${prefix.startsWith("/") ? prefix : `/${prefix}`}`,
		secret,
		problem,
	};

	return cached;
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
 * the body straight through — the web console re-serves these to the browser, and
 * re-framing the events on the way would only add a place for them to be lost.
 *
 * Pass the incoming request's signal as `signal`: aborting it tears down this
 * upstream connection, which is what makes LunaCore drop the subscriber. The body
 * cannot be cancelled by hand once it has been handed to a `Response` — that locks
 * the stream — so the signal is the only way to close it early.
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
