/**
 * The primary daemon's cluster hub: accepts follower WebSocket connections,
 * keeps the live follower registry, heartbeats them (which is also how latency
 * and their host health are measured), forwards instance-scoped operations to
 * their owners, and pushes state-file syncs whenever cluster.json /
 * plugins.lock.json / environment.json change (DESIGN.md §4.4).
 */

import { watch, type FSWatcher } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { loadCluster, saveCluster, saveLock, root } from "../core/config";
import { portOpen } from "../core/ping";
import { ProgressReporter } from "../core/progress";
import type { ClusterConfig, DaemonRegistration } from "../core/types";
import { applySnapshot } from "../shared/progressMirror";

import type { DaemonConfig } from "./config";
import { daemonEventKey, getEvents, pushEvent, type ClusterEvent } from "./events";
import { currentHealth, healthHistory, hostAddresses, type HealthSample } from "./health";
import { log } from "./index";
import {
	installRouting,
	setCheckSender,
	setDaemonDetailProvider,
	setDaemonsProvider,
	setUpgradeSender,
	type OpResult,
	type OpSpec,
} from "./rpc";
import { PROTOCOL_VERSION } from "./server";
import { checkUpgrade, selfUpgrade } from "./upgrade";
import { buildVersion } from "../version";

/**
 * State files a follower mirrors from the primary.
 *
 * The forwarding secret rides along so a follower can key paper-global.yml when
 * materializing the instances it owns. It keeps the `proxy/` prefix because
 * `readForwardingSecret` resolves one root-relative path on every machine, so a
 * follower ends up with a `proxy/` directory holding nothing but that file —
 * which is not a proxy instance. The cluster has exactly one Velocity and it
 * runs on the primary.
 */
const SYNC_FILES = [
	"cluster.json",
	"plugins.lock.json",
	"environment.json",
	"proxy/forwarding.secret",
] as const;

/** Heartbeat cadence. Every ping carries a sequence number the pong echoes,
 *  which is what makes the round-trip time a real measurement. */
const PING_INTERVAL_MS = 5_000;

/** Unanswered pings before the link is considered dead and closed. A wedged
 *  follower keeps its TCP socket open, so silence is the only symptom. */
const MISSED_PINGS_BEFORE_DROP = 3;

/** How often the primary TCP-probes a follower's advertised address. */
const REACH_INTERVAL_MS = 30_000;

/** One hour of fleet health at the heartbeat cadence. */
const MAX_HEALTH_SAMPLES = 720;

/** Utilization above this reads as "no headroom left" in the health checks. */
const PRESSURE_PCT = 90;

/** One TCP probe of a follower-owned instance from the primary's machine. */
export interface ReachResult {
	instance: string;
	address: string;
	ok: boolean;
}

/** A single health verdict about a daemon, rendered like the instance checks. */
export interface DaemonCheck {
	name: string;
	/** undefined = not applicable rather than failing */
	ok: boolean | undefined;
	detail: string;
}

interface FollowerLink {
	ws: Bun.ServerWebSocket<{ kind: string }>;
	name: string;
	host: string;
	addresses: string[];
	root: string;
	version?: string;
	protocol?: number;
	connectedAt: number;
	/** Daemon process start on the follower's own clock */
	startedAt?: number;
	/** Last frame of any kind from this follower */
	lastSeen: number;
	health?: HealthSample;
	latencyMs?: number;
	pingSeq: number;
	pending?: { seq: number; at: number };
	missed: number;
	reach?: { at: number; results: ReachResult[] };
}

/** One row of the daemons management view. */
export interface DaemonRow {
	name: string;
	mode: "primary" | "follower";
	/** Address the primary reaches this daemon's instances on */
	host: string | null;
	/** Every non-loopback IPv4 the daemon reported for itself */
	addresses: string[];
	online: boolean;
	/** Build identity, e.g. "1.0.0+6ee20ac" — what an upgrade changes */
	version: string | null;
	/** Local API revision — what refuses a mismatched client or follower */
	protocol: number | null;
	/** True when this daemon's build is behind the primary's */
	outdated: boolean;
	root: string | null;
	connectedAt: number | null;
	lastSeen: string | null;
	/** Age of the last heartbeat, ms — null when the daemon is not connected */
	lastBeatMs: number | null;
	/** Heartbeat round-trip, ms */
	latencyMs: number | null;
	/** Daemon process uptime, ms */
	uptimeMs: number | null;
	health: HealthSample | null;
	checks: DaemonCheck[];
	reach: ReachResult[] | null;
	/** Instance names owned by this daemon */
	instances: string[];
}

/** A daemon's row plus everything its detail view charts. */
export interface DaemonDetail {
	row: DaemonRow;
	history: HealthSample[];
	events: ClusterEvent[];
}

interface Pending {
	resolve: (result: OpResult) => void;
	reject: (err: Error) => void;
	reporter?: ProgressReporter;
	follower: string;
}

const followers = new Map<string, FollowerLink>();
const pending = new Map<string, Pending>();

/** Health history per daemon, kept across reconnects so a chart is not reset
 *  by a follower restart. Keyed by daemon name, the primary's included. */
const histories = new Map<string, HealthSample[]>();

let hubConfig: DaemonConfig | undefined;
let hubStartedAt = Date.now();
let requestCounter = 0;
let watcher: FSWatcher | undefined;
let syncTimer: ReturnType<typeof setTimeout> | undefined;
let pingTimer: ReturnType<typeof setInterval> | undefined;
let reachTimer: ReturnType<typeof setInterval> | undefined;

/** Read the current sync payload: raw file texts, missing files skipped. */
async function syncPayload(): Promise<Record<string, string>> {
	const files: Record<string, string> = {};

	for (const name of SYNC_FILES) {
		const path = join(root(), name);

		if (existsSync(path)) {
			files[name] = await Bun.file(path).text();
		}
	}

	return files;
}

/** Push the current state files to one follower. */
async function sendSync(link: FollowerLink): Promise<void> {
	link.ws.send(JSON.stringify({ t: "sync", files: await syncPayload() }));
}

/** Debounced broadcast — a save burst becomes one sync frame. */
function scheduleBroadcast(): void {
	if (syncTimer) {
		clearTimeout(syncTimer);
	}

	syncTimer = setTimeout(() => {
		syncTimer = undefined;

		void (async () => {
			const files = await syncPayload();
			const frame = JSON.stringify({ t: "sync", files });

			for (const link of followers.values()) {
				link.ws.send(frame);
			}
		})();
	}, 300);
}

/** Update the persisted daemons registry for one follower. */
async function persistRegistration(link: FollowerLink): Promise<void> {
	const cfg = await loadCluster();

	cfg.daemons ??= {};

	const existing: DaemonRegistration | undefined = cfg.daemons[link.name];

	cfg.daemons[link.name] = {
		host: link.host,
		addresses: link.addresses,
		root: link.root,
		version: link.version,
		addedAt: existing?.addedAt ?? new Date().toISOString(),
		lastSeen: new Date().toISOString(),
	};

	await saveCluster(cfg);
}

/**
 * Stamp a follower's last-seen time into the registry as it goes away —
 * otherwise an offline daemon reports the moment it *registered* as the last
 * time anyone heard from it, which is the one number that view exists for.
 */
async function persistLastSeen(name: string, at: number): Promise<void> {
	const cfg = await loadCluster();
	const entry = cfg.daemons?.[name];

	if (!entry) {
		return;
	}

	entry.lastSeen = new Date(at).toISOString();

	await saveCluster(cfg);
}

/** Append a health sample to a daemon's history, ignoring a repeated sample. */
function recordHealth(name: string, sample: HealthSample): void {
	const list = histories.get(name) ?? [];

	if (list.at(-1)?.t === sample.t) {
		return;
	}

	list.push(sample);

	if (list.length > MAX_HEALTH_SAMPLES) {
		list.splice(0, list.length - MAX_HEALTH_SAMPLES);
	}

	histories.set(name, list);
}

/** Instance names owned by a daemon, per the registry. */
function ownedInstances(cfg: ClusterConfig, daemon: string | undefined): string[] {
	const names: string[] = [];

	for (const [name, inst] of Object.entries({ proxy: cfg.proxy, ...cfg.instances })) {
		if (inst.external) {
			continue;
		}

		const owner = name === "proxy" ? undefined : inst.daemon;

		if (owner === daemon) {
			names.push(name);
		}
	}

	return names;
}

/** Coarse "12s" / "3m 4s" age of a timestamp. */
function agoText(epochMs: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - epochMs) / 1000));

	if (seconds < 60) {
		return `${seconds}s`;
	}

	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Percentage of a total, guarded against a missing denominator. */
function pctOf(used: number, total: number): number {
	if (total <= 0) {
		return 0;
	}

	return Math.round((used / total) * 100);
}

/**
 * Whether the machine still has room to run instances. CPU, memory and the
 * cluster-root filesystem are judged together — any one of them at the pressure
 * threshold is what will actually break a start, so the check names the one
 * that is full instead of averaging them into a meaningless number.
 */
function resourceCheck(health: HealthSample | undefined): DaemonCheck {
	const name = "Resource headroom";

	if (!health) {
		return { name, ok: undefined, detail: "no health sample yet" };
	}

	const memPct = pctOf(health.memUsedMb, health.memTotalMb);
	const diskPct = pctOf(health.diskUsedBytes, health.diskTotalBytes);
	const problems: string[] = [];

	if (health.cpuPct >= PRESSURE_PCT) {
		problems.push(`CPU at ${health.cpuPct}%`);
	}

	if (memPct >= PRESSURE_PCT) {
		problems.push(`memory at ${memPct}%`);
	}

	if (diskPct >= PRESSURE_PCT) {
		problems.push(`disk at ${diskPct}%`);
	}

	if (problems.length > 0) {
		return { name, ok: false, detail: problems.join(" · ") };
	}

	return {
		name,
		ok: true,
		detail: `CPU ${health.cpuPct}% · memory ${memPct}% · disk ${diskPct}% · load ${health.load1.toFixed(2)}`,
	};
}

/** The health checks for a connected (or missing) follower. */
function followerChecks(link: FollowerLink | undefined, registered: DaemonRegistration | undefined): DaemonCheck[] {
	if (!link) {
		return [
			{
				name: "Daemon link",
				ok: false,
				detail: registered?.lastSeen
					? `not connected — last seen ${new Date(registered.lastSeen).toLocaleString()}`
					: "never connected",
			},
			{ name: "Heartbeat", ok: undefined, detail: "no link" },
			{ name: "Instance reachability", ok: undefined, detail: "no link" },
			{ name: "Resource headroom", ok: undefined, detail: "no link" },
		];
	}

	const beats: DaemonCheck = {
		name: "Heartbeat",
		ok: link.missed === 0,
		detail:
			link.missed === 0
				? `${link.latencyMs ?? "?"}ms round-trip · last beat ${agoText(link.lastSeen)} ago`
				: `${link.missed} missed ping(s) — last beat ${agoText(link.lastSeen)} ago`,
	};

	const reach: DaemonCheck = (() => {
		const name = "Instance reachability";

		if (!link.reach || link.reach.results.length === 0) {
			return { name, ok: undefined, detail: `no running instance to probe on ${link.host}` };
		}

		const failed = link.reach.results.filter((result) => !result.ok);

		if (failed.length > 0) {
			return {
				name,
				ok: false,
				detail: `unreachable from the primary: ${failed.map((result) => `${result.instance} (${result.address})`).join(", ")}`,
			};
		}

		return {
			name,
			ok: true,
			detail: `${link.reach.results.length} port(s) answering on ${link.host}`,
		};
	})();

	return [
		{
			name: "Daemon link",
			ok: true,
			detail: `WebSocket from ${link.host} · connected ${agoText(link.connectedAt)} ago`,
		},
		beats,
		reach,
		resourceCheck(link.health),
	];
}

/** Connected followers whose build differs from this primary's. */
function outdatedFollowers(): string[] {
	return [...followers.values()]
		.filter((link) => link.version && link.version !== buildVersion())
		.map((link) => link.name);
}

/** The health checks for this primary daemon itself. */
function primaryChecks(cfg: ClusterConfig): DaemonCheck[] {
	const listener = hubConfig?.listen;

	return [
		{
			name: "Daemon link",
			ok: true,
			detail: `this daemon — local socket ${hubConfig?.socket ?? "?"}`,
		},
		{
			name: "Cluster listener",
			ok: listener ? true : undefined,
			detail: listener
				? `accepting followers on ${listener.host}:${listener.port} — ${followers.size} connected`
				: "no TCP listener configured — this host cannot accept followers",
		},
		{
			name: "Cluster token",
			ok: hubConfig?.token ? true : false,
			detail: hubConfig?.token
				? "configured — followers must present it"
				: "not configured — followers cannot authenticate",
		},
		{
			name: "Instance reachability",
			ok: undefined,
			detail: `${ownedInstances(cfg, undefined).length} instance(s) on this host, reached on loopback`,
		},
		{
			name: "Fleet build",
			ok: outdatedFollowers().length === 0,
			detail:
				outdatedFollowers().length === 0
					? `every connected daemon runs ${buildVersion()}`
					: `behind this primary: ${outdatedFollowers().join(", ")} — upgrade them`,
		},
		resourceCheck(currentHealth()),
	];
}

/** Cached cluster config for sync routing decisions (refreshed on file change). */
let cachedCluster: ClusterConfig | undefined;

async function refreshClusterCache(): Promise<void> {
	try {
		cachedCluster = await loadCluster();
	} catch {
		cachedCluster = undefined;
	}
}

/** The registry, from the cache when it is warm — the fleet view polls often. */
async function clusterView(): Promise<ClusterConfig> {
	return cachedCluster ?? (await loadCluster());
}

/** This primary's own row. */
function primaryRow(cfg: ClusterConfig): DaemonRow {
	const health = currentHealth();

	if (health) {
		recordHealth(hubConfig?.name ?? "primary", health);
	}

	return {
		name: hubConfig?.name ?? "primary",
		mode: "primary",
		host: hubConfig?.listen ? `${hubConfig.listen.host}:${hubConfig.listen.port}` : null,
		addresses: hostAddresses(),
		online: true,
		version: buildVersion(),
		protocol: PROTOCOL_VERSION,
		outdated: false,
		root: hubConfig?.root ?? root(),
		connectedAt: hubStartedAt,
		lastSeen: new Date().toISOString(),
		// there is no link to itself to measure — a zero here would read as a
		// suspiciously perfect round-trip rather than "not applicable"
		lastBeatMs: null,
		latencyMs: null,
		uptimeMs: Date.now() - hubStartedAt,
		health: health ?? null,
		checks: primaryChecks(cfg),
		reach: null,
		instances: ownedInstances(cfg, undefined),
	};
}

/** The daemons management view: the primary itself plus every known follower. */
async function listDaemons(): Promise<DaemonRow[]> {
	const cfg = await clusterView();
	const rows: DaemonRow[] = [primaryRow(cfg)];

	const known = new Set([...Object.keys(cfg.daemons ?? {}), ...followers.keys()]);

	for (const name of [...known].sort()) {
		const link = followers.get(name);
		const registered = cfg.daemons?.[name];

		rows.push({
			name,
			mode: "follower",
			host: link?.host ?? registered?.host ?? null,
			addresses: link?.addresses ?? registered?.addresses ?? [],
			online: !!link,
			version: link?.version ?? registered?.version ?? null,
			protocol: link?.protocol ?? null,
			// a follower one build behind still works — the console flags it so
			// somebody decides, rather than upgrading on its own
			outdated: !!link?.version && link.version !== buildVersion(),
			root: link?.root ?? registered?.root ?? null,
			connectedAt: link?.connectedAt ?? null,
			lastSeen: link
				? new Date(link.lastSeen).toISOString()
				: (registered?.lastSeen ?? null),
			lastBeatMs: link ? Date.now() - link.lastSeen : null,
			latencyMs: link?.latencyMs ?? null,
			uptimeMs: link?.startedAt ? Date.now() - link.startedAt : null,
			health: link?.health ?? null,
			checks: followerChecks(link, registered),
			reach: link?.reach?.results ?? null,
			instances: ownedInstances(cfg, name),
		});
	}

	return rows;
}

/** One daemon's row with the history and events its detail view renders. */
async function daemonDetail(name: string): Promise<DaemonDetail | null> {
	const rows = await listDaemons();
	const row = rows.find((entry) => entry.name === name);

	if (!row) {
		return null;
	}

	// the primary's own history lives in its health module; a follower's is what
	// the hub accumulated from its heartbeats
	const history = row.mode === "primary" ? healthHistory() : (histories.get(name) ?? []);

	return {
		row,
		history: history.slice(),
		events: getEvents(daemonEventKey(name)),
	};
}

/** The live link for a follower, if connected. */
export function followerLink(name: string): FollowerLink | undefined {
	return followers.get(name);
}

/**
 * Routing predicate installed into the RPC dispatcher: an op whose target
 * instance is owned by a connected follower runs there. The cfg travelling
 * with the call is preferred over the cache — it is always current.
 */
function resolveRemote(op: string, spec: OpSpec, args: unknown[]): string | undefined {
	if (spec.instance === undefined) {
		return undefined;
	}

	const instance = args[spec.instance];

	if (typeof instance !== "string" || instance === "proxy") {
		return undefined;
	}

	const cfg =
		spec.cfg !== undefined ? (args[spec.cfg] as ClusterConfig | undefined) : cachedCluster;

	const owner = cfg?.instances?.[instance]?.daemon;

	if (!owner || owner === hubConfig?.name) {
		return undefined;
	}

	return owner;
}

/** Forward one operation to a follower and await its result. */
function forwardOp(
	daemon: string,
	op: string,
	args: unknown[],
	reporter?: ProgressReporter,
): Promise<OpResult> {
	const link = followers.get(daemon);

	if (!link) {
		return Promise.reject(new Error(`follower "${daemon}" is not connected`));
	}

	const id = `${daemon}:${++requestCounter}`;

	return new Promise<OpResult>((resolve, reject) => {
		pending.set(id, { resolve, reject, reporter, follower: daemon });

		link.ws.send(
			JSON.stringify({ t: "rpc", id, op, args, withProgress: reporter !== undefined }),
		);
	});
}

/**
 * Upgrade one daemon in the fleet.
 *
 * A follower is told to pull the binary this primary is running — the fast path
 * for a development cluster. The primary has no such source, so it upgrades
 * itself from the GitHub release; either way the daemon resolves its own source
 * (DESIGN.md §4.7) and this only decides *where the request runs*.
 */
async function upgradeDaemon(name: string, force: boolean): Promise<unknown> {
	if (name === hubConfig?.name) {
		pushEvent(daemonEventKey(name), "action", "self-upgrade requested from the console");

		return await selfUpgrade(force);
	}

	if (!followers.has(name)) {
		throw new Error(`follower "${name}" is not connected`);
	}

	pushEvent(daemonEventKey(name), "action", "upgrade requested by the primary");

	const outcome = await forwardOp(name, "daemon.selfUpgrade", [force]);

	return outcome.result;
}

/** Ask one daemon what it could upgrade to, without applying anything. */
async function checkDaemonUpgrade(name: string, refresh: boolean): Promise<unknown> {
	if (name === hubConfig?.name) {
		return await checkUpgrade(refresh);
	}

	if (!followers.has(name)) {
		throw new Error(`follower "${name}" is not connected`);
	}

	const outcome = await forwardOp(name, "daemon.checkUpgrade", [refresh]);

	return outcome.result;
}

/** Settle every pending request that was waiting on a lost follower. */
function rejectPendingFor(name: string, reason: string): void {
	for (const [id, entry] of pending) {
		if (entry.follower === name) {
			pending.delete(id);
			entry.reject(new Error(reason));
		}
	}
}

/**
 * One heartbeat round. A follower that has not answered the previous ping is
 * counted as missing one; after MISSED_PINGS_BEFORE_DROP the socket is closed
 * so the follower's own reconnect loop starts a fresh link.
 */
function pingRound(): void {
	for (const link of followers.values()) {
		if (link.pending) {
			link.missed += 1;

			if (link.missed >= MISSED_PINGS_BEFORE_DROP) {
				log(`follower "${link.name}" missed ${link.missed} heartbeats — dropping the link`);
				pushEvent(
					daemonEventKey(link.name),
					"error",
					`heartbeat timeout after ${link.missed} missed pings`,
				);

				link.ws.close(1001, "heartbeat timeout");

				continue;
			}
		}

		const at = Date.now();

		link.pending = { seq: ++link.pingSeq, at };
		link.ws.send(JSON.stringify({ t: "ping", seq: link.pingSeq, at }));
	}
}

/**
 * TCP-probe a follower's running instances from the primary's machine. This is
 * the check nothing else makes: the WebSocket link can be perfectly healthy
 * while the velocity proxy cannot reach the backends behind it (a firewall, a
 * server bound to loopback, a stale advertised address).
 */
async function probeReach(link: FollowerLink): Promise<void> {
	const cfg = await clusterView();
	const states = link.health?.states ?? {};

	const targets = Object.entries(cfg.instances)
		.filter(([name, inst]) => inst.daemon === link.name && !inst.external && states[name] === "running")
		.map(([name, inst]) => ({ name, port: inst.port }));

	const results = await Promise.all(
		targets.map(async (target): Promise<ReachResult> => ({
			instance: target.name,
			address: `${link.host}:${target.port}`,
			ok: await portOpen(link.host, target.port),
		})),
	);

	const wasBad = link.reach?.results.some((result) => !result.ok) ?? false;
	const isBad = results.some((result) => !result.ok);

	if (isBad && !wasBad) {
		pushEvent(
			daemonEventKey(link.name),
			"error",
			`instances unreachable at ${link.host}: ${results
				.filter((result) => !result.ok)
				.map((result) => result.instance)
				.join(", ")}`,
		);
	}

	if (!isBad && wasBad) {
		pushEvent(daemonEventKey(link.name), "state", `instances reachable again at ${link.host}`);
	}

	link.reach = { at: Date.now(), results };
}

/** Probe every connected follower. */
function reachRound(): void {
	for (const link of followers.values()) {
		void probeReach(link);
	}
}

interface FollowerFrame {
	t: string;
	id?: string;
	name?: string;
	host?: string;
	addresses?: string[];
	root?: string;
	version?: string;
	protocol?: number;
	startedAt?: number;
	seq?: number;
	at?: number;
	health?: HealthSample;
	ok?: boolean;
	result?: unknown;
	cfg?: unknown;
	lock?: unknown;
	error?: string;
	snapshot?: Parameters<typeof applySnapshot>[1];
	instance?: string;
	kind?: ClusterEvent["kind"];
	message?: string;
	file?: "cluster" | "lock";
	data?: unknown;
}

async function onFrame(ws: Bun.ServerWebSocket<{ kind: string; name?: string }>, raw: string): Promise<void> {
	let frame: FollowerFrame;

	try {
		frame = JSON.parse(raw);
	} catch {
		return;
	}

	if (frame.t === "register") {
		if (!frame.name || !frame.root) {
			ws.close(1008, "register requires name and root");

			return;
		}

		if (frame.protocol !== PROTOCOL_VERSION) {
			ws.close(1008, `protocol mismatch: hub ${PROTOCOL_VERSION}, follower ${frame.protocol}`);

			return;
		}

		const link: FollowerLink = {
			ws,
			name: frame.name,
			host: frame.host || ws.remoteAddress,
			addresses: frame.addresses ?? [],
			root: frame.root,
			version: frame.version,
			protocol: frame.protocol,
			startedAt: frame.startedAt,
			connectedAt: Date.now(),
			lastSeen: Date.now(),
			pingSeq: 0,
			missed: 0,
		};

		// a reconnect replaces the old link; its pending calls can never settle
		if (followers.has(link.name)) {
			rejectPendingFor(link.name, `follower "${link.name}" reconnected`);
		}

		followers.set(link.name, link);
		ws.data.name = link.name;

		await persistRegistration(link);

		ws.send(JSON.stringify({ t: "registered", name: hubConfig?.name }));
		await sendSync(link);

		log(`follower "${link.name}" connected from ${link.host} (root ${link.root})`);
		pushEvent(daemonEventKey(link.name), "state", `connected from ${link.host}`);

		return;
	}

	const link = ws.data.name ? followers.get(ws.data.name) : undefined;

	if (!link) {
		ws.close(1008, "not registered");

		return;
	}

	link.lastSeen = Date.now();

	if (frame.t === "pong") {
		// only the outstanding ping's echo measures anything — a late pong from a
		// previous round would time a round-trip that already ended
		if (link.pending && frame.seq === link.pending.seq) {
			link.latencyMs = Date.now() - link.pending.at;
			link.pending = undefined;
			link.missed = 0;
		}

		if (frame.health) {
			const sample: HealthSample = { ...frame.health, latencyMs: link.latencyMs };

			link.health = sample;
			recordHealth(link.name, sample);
		}

		return;
	}

	if (frame.t === "result" && frame.id) {
		const entry = pending.get(frame.id);

		if (!entry) {
			return;
		}

		pending.delete(frame.id);

		if (frame.ok) {
			entry.resolve({ result: frame.result, cfg: frame.cfg, lock: frame.lock });
		} else {
			entry.reject(new Error(frame.error ?? "follower call failed"));
		}

		return;
	}

	if (frame.t === "progress" && frame.id && frame.snapshot) {
		const entry = pending.get(frame.id);

		if (entry?.reporter) {
			applySnapshot(entry.reporter, frame.snapshot);
		}

		return;
	}

	if (frame.t === "event" && frame.instance && frame.kind && frame.message) {
		pushEvent(frame.instance, frame.kind, frame.message);

		return;
	}

	if (frame.t === "save" && frame.file && frame.data !== undefined) {
		// the primary is the single writer: persist, then the watcher broadcasts
		if (frame.file === "cluster") {
			await saveCluster(frame.data as ClusterConfig);
		} else {
			await saveLock(frame.data as never);
		}

		return;
	}
}

/** Bun WebSocket handlers for the cluster listener. */
export const hubWebSocket: Bun.WebSocketHandler<{ kind: string; name?: string }> = {
	message(ws, message) {
		void onFrame(ws, typeof message === "string" ? message : new TextDecoder().decode(message));
	},

	close(ws) {
		const name = ws.data.name;

		if (!name) {
			return;
		}

		const link = followers.get(name);

		// only the *current* link's close should deregister — a replaced socket
		// closing later must not tear down its successor
		if (link && link.ws === ws) {
			followers.delete(name);
			rejectPendingFor(name, `follower "${name}" disconnected`);
			void persistLastSeen(name, link.lastSeen);
			log(`follower "${name}" disconnected`);
			pushEvent(daemonEventKey(name), "state", "disconnected");
		}
	},
};

/** Wire the hub into the daemon: routing hooks, sync watcher, management ops. */
export function installHub(dcfg: DaemonConfig, startedAt: number): void {
	hubConfig = dcfg;
	hubStartedAt = startedAt;

	installRouting(resolveRemote, forwardOp);
	setDaemonsProvider(listDaemons);
	setDaemonDetailProvider(daemonDetail);
	setUpgradeSender(upgradeDaemon);
	setCheckSender(checkDaemonUpgrade);

	void refreshClusterCache();

	pingTimer ??= setInterval(pingRound, PING_INTERVAL_MS);
	reachTimer ??= setInterval(reachRound, REACH_INTERVAL_MS);

	// Bun.write replaces files, so watch the directory and filter by name
	watcher = watch(root(), (_kind, filename) => {
		if (!filename || !SYNC_FILES.includes(filename as (typeof SYNC_FILES)[number])) {
			return;
		}

		if (filename === "cluster.json") {
			void refreshClusterCache();
		}

		scheduleBroadcast();
	});
}

/** Stop the sync watcher and the heartbeat timers (shutdown). */
export function stopHub(): void {
	watcher?.close();
	watcher = undefined;

	if (pingTimer) {
		clearInterval(pingTimer);
		pingTimer = undefined;
	}

	if (reachTimer) {
		clearInterval(reachTimer);
		reachTimer = undefined;
	}
}
