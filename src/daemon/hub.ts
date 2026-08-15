// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The primary daemon's cluster hub: accepts follower WebSocket connections,
 * keeps the live follower registry, heartbeats them (which is also how latency
 * and their host health are measured), forwards instance-scoped operations to
 * their owners, and pushes state-file syncs whenever cluster.json /
 * plugins.lock.json / environment.json change (DESIGN.md §4.4).
 */

import { watch, type FSWatcher } from "node:fs";
import { t } from "../shared/i18n";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { saveAccounts, type AccountStore } from "../core/accounts";
import { dataDir, loadCluster, saveCluster, saveLock, root, syncFilePath } from "../core/config";
import { saveConfigFiles, type ConfigFileStore } from "../core/configfiles";
import { saveEnv, type EnvironmentStore } from "../core/environment";
import { portOpen } from "../core/ping";
import { ProgressReporter } from "../core/progress";
import type { ClusterConfig, DaemonRegistration } from "../core/types";
import { applySnapshot } from "../shared/progressMirror";

import { pushesRecoveryUpgrades, type DaemonConfig } from "./config";
import { daemonEventKey, getEvents, pushEvent, type ClusterEvent } from "./events";
import {
	currentHealth,
	healthHistory,
	hostAddresses,
	SAMPLE_INTERVAL_MS,
	type HealthSample,
} from "./health";
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
import { lunaCardsFor, lunaProblem, setRemoteSampleProvider } from "./sampler";
import { PROTOCOL_VERSION, setRemoteConsole } from "./server";
import { checkUpgrade, selfUpgrade } from "./upgrade";
import { buildVersion } from "../version";

/**
 * State files a follower mirrors from the primary.
 *
 * The forwarding secret rides along so a follower can key paper-global.yml when
 * materializing the instances it owns. It keeps the `proxy/` prefix because
 * `readForwardingSecret` resolves one root-relative path on every machine, so a
 * follower ends up with a `proxy/` directory holding nothing but that file -
 * which is not a proxy instance. The cluster has exactly one Velocity and it
 * runs on the primary.
 */
const SYNC_FILES = [
	"cluster.json",
	"plugins.lock.json",
	"packs.lock.json",
	"environment.json",
	"configfiles.json",
	"accounts.json",
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

/** The primary's own backends bind loopback, so that is where it probes itself. */
const LOOPBACK = "127.0.0.1";

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
	/** Why this link is refused for ordinary work; unset on a healthy one. The
	 *  socket is kept open anyway, so an upgrade can still be pushed down it. */
	quarantine?: string;
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
	/**
	 * Whether this daemon can be given work. False for a quarantined one: the
	 * socket is up, but the two ends do not agree on what an op looks like, so
	 * anything routed there would be answered by a build reading it differently.
	 */
	online: boolean;
	/** Connected and usable, connected but refused, or not connected at all */
	state: "online" | "quarantined" | "offline";
	/** Why the link is quarantined, one line; null when it is not */
	quarantine: string | null;
	/** Build identity, e.g. "1.0.0+6ee20ac"; what an upgrade changes */
	version: string | null;
	/** Local API revision; what refuses a mismatched client or follower */
	protocol: number | null;
	/** True when this daemon's build is behind the primary's */
	outdated: boolean;
	root: string | null;
	connectedAt: number | null;
	lastSeen: string | null;
	/** Age of the last heartbeat, ms; null when the daemon is not connected */
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

/** One live console tunnel to a follower, keyed by stream id. */
interface HubStream {
	follower: string;
	onLine: (line: string) => void;
	onEnd: (error?: string) => void;
	/** fires if the follower never answers; a build that predates tunnelling
	 *  silently ignores the frame, and silence must not read as an empty log */
	readyTimer?: ReturnType<typeof setTimeout>;
}

/** How long the follower gets to acknowledge a console request. */
const STREAM_READY_TIMEOUT_MS = 5_000;

const followers = new Map<string, FollowerLink>();
const pending = new Map<string, Pending>();
const streams = new Map<string, HubStream>();

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

/** Last reachability round against this machine's own instances. */
let selfReach: { at: number; results: ReachResult[] } | undefined;

/**
 * Read the current sync payload: raw file texts, missing files skipped.
 *
 * Keyed by logical name, never by path, so the follower resolves where each one
 * belongs on its own machine.
 */
async function syncPayload(): Promise<Record<string, string>> {
	const files: Record<string, string> = {};

	for (const name of SYNC_FILES) {
		const path = syncFilePath(name);

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

/** Debounced broadcast; a save burst becomes one sync frame. */
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
				// a quarantined follower is deliberately left on the state it had
				// when the link was last good: it is a build that reads these files
				// differently, and the machine is not being given work anyway
				if (link.quarantine) {
					continue;
				}

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
 * Stamp a follower's last-seen time into the registry as it goes away -
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
 * cluster-root filesystem are judged together; any one of them at the pressure
 * threshold is what will actually break a start, so the check names the one
 * that is full instead of averaging them into a meaningless number.
 */
function resourceCheck(health: HealthSample | undefined): DaemonCheck {
	const name = t("daemon.checks.headroom");

	if (!health) {
		return { name, ok: undefined, detail: t("daemon.checks.noSample") };
	}

	const memPct = pctOf(health.memUsedMb, health.memTotalMb);
	const diskPct = pctOf(health.diskUsedBytes, health.diskTotalBytes);
	const problems: string[] = [];

	if (health.cpuPct >= PRESSURE_PCT) {
		problems.push(t("daemon.checks.cpuAt", { pct: health.cpuPct }));
	}

	if (memPct >= PRESSURE_PCT) {
		problems.push(t("daemon.checks.memAt", { pct: memPct }));
	}

	if (diskPct >= PRESSURE_PCT) {
		problems.push(t("daemon.checks.diskAt", { pct: diskPct }));
	}

	if (problems.length > 0) {
		return { name, ok: false, detail: problems.join(" · ") };
	}

	return {
		name,
		ok: true,
		detail: t("daemon.checks.headroomOk", { cpu: health.cpuPct, mem: memPct, disk: diskPct, load: health.load1.toFixed(2) }),
	};
}

/**
 * Turn a reachability round into a check. Every probe runs from the primary, so
 * the address in a failure is the one the proxy would dial.
 *
 * A round that found nothing to probe is a **pass**, not an unknown: no instance
 * is unreachable, and a verdict that never resolves reads as a broken check
 * rather than an idle one. Unknown is reserved for a round that genuinely has
 * not happened; no link, or a primary still inside its first probe interval.
 */
function reachCheck(
	round: { at: number; results: ReachResult[] } | undefined,
	host: string,
): DaemonCheck {
	const name = t("daemon.checks.reachability");

	if (!round) {
		return { name, ok: undefined, detail: t("daemon.checks.notProbed") };
	}

	if (round.results.length === 0) {
		return { name, ok: true, detail: t("daemon.checks.nothingToProbe", { host }) };
	}

	const failed = round.results.filter((result) => !result.ok);

	if (failed.length > 0) {
		return {
			name,
			ok: false,
			detail: t("daemon.checks.unreachable", { names: failed.map((result) => `${result.instance} (${result.address})`).join(", ") }),
		};
	}

	return { name, ok: true, detail: t("daemon.checks.answering", { count: round.results.length, host }) };
}

/** The health checks for a connected (or missing) follower. */
function followerChecks(link: FollowerLink | undefined, registered: DaemonRegistration | undefined): DaemonCheck[] {
	if (!link) {
		return [
			{
				name: t("daemon.checks.link"),
				ok: false,
				detail: registered?.lastSeen
					? t("daemon.checks.lastSeen", { time: new Date(registered.lastSeen).toLocaleString() })
					: t("daemon.checks.neverConnected"),
			},
			{ name: t("daemon.checks.heartbeat"), ok: undefined, detail: t("daemon.checks.noLink") },
			{ name: t("daemon.checks.reachability"), ok: undefined, detail: t("daemon.checks.noLink") },
			{ name: t("daemon.checks.headroom"), ok: undefined, detail: t("daemon.checks.noLink") },
		];
	}

	// a quarantined follower still answers heartbeats and is still probed, so the
	// rest of the picture is real; only the link itself is broken, and naming the
	// mismatch is the whole point of showing the machine at all
	if (link.quarantine) {
		return [
			{ name: t("daemon.checks.link"), ok: false, detail: link.quarantine },
			{
				name: t("daemon.checks.heartbeat"),
				ok: link.missed === 0,
				detail: t("daemon.checks.quarantinedBeat", { ago: agoText(link.lastSeen) }),
			},
			reachCheck(link.reach, link.host),
			resourceCheck(link.health),
		];
	}

	const beats: DaemonCheck = {
		name: t("daemon.checks.heartbeat"),
		ok: link.missed === 0,
		detail:
			link.missed === 0
				? t("daemon.checks.beatOk", { latency: link.latencyMs ?? "?", ago: agoText(link.lastSeen) })
				: t("daemon.checks.beatMissed", { count: link.missed, ago: agoText(link.lastSeen) }),
	};

	return [
		{
			name: t("daemon.checks.link"),
			ok: true,
			detail: `WebSocket from ${link.host} · connected ${agoText(link.connectedAt)} ago`,
		},
		beats,
		reachCheck(link.reach, link.host),
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
function primaryChecks(): DaemonCheck[] {
	const listener = hubConfig?.listen;

	return [
		{
			name: t("daemon.checks.link"),
			ok: true,
			detail: t("daemon.checks.selfLink", { socket: hubConfig?.socket ?? "?" }),
		},
		{
			name: t("daemon.checks.listener"),
			ok: listener ? true : undefined,
			detail: listener
				? t("daemon.checks.listenerOn", { host: listener.host, port: listener.port, count: followers.size })
				: t("daemon.checks.noListener"),
		},
		{
			name: t("daemon.checks.token"),
			ok: hubConfig?.token ? true : false,
			detail: hubConfig?.token
				? t("daemon.checks.tokenConfigured")
				: t("daemon.checks.tokenMissing"),
		},
		reachCheck(selfReach, LOOPBACK),
		{
			name: t("daemon.checks.fleetBuild"),
			ok: outdatedFollowers().length === 0,
			detail:
				outdatedFollowers().length === 0
					? t("daemon.checks.fleetCurrent", { version: buildVersion() })
					: t("daemon.checks.fleetBehind", { names: outdatedFollowers().join(", ") }),
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

/** The registry, from the cache when it is warm; the fleet view polls often. */
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
		state: "online",
		quarantine: null,
		version: buildVersion(),
		protocol: PROTOCOL_VERSION,
		outdated: false,
		root: hubConfig?.root ?? root(),
		connectedAt: hubStartedAt,
		lastSeen: new Date().toISOString(),
		// there is no link to itself to measure; a zero here would read as a
		// suspiciously perfect round-trip rather than "not applicable"
		lastBeatMs: null,
		latencyMs: null,
		uptimeMs: Date.now() - hubStartedAt,
		health: health ?? null,
		checks: primaryChecks(),
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
		const state = !link ? "offline" : link.quarantine ? "quarantined" : "online";

		rows.push({
			name,
			mode: "follower",
			host: link?.host ?? registered?.host ?? null,
			addresses: link?.addresses ?? registered?.addresses ?? [],
			online: state === "online",
			state,
			quarantine: link?.quarantine ?? null,
			version: link?.version ?? registered?.version ?? null,
			protocol: link?.protocol ?? null,
			// a follower one build behind still works; the console flags it so
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
 * with the call is preferred over the cache; it is always current.
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

/**
 * The only ops a quarantined follower is still asked to run.
 *
 * Both have been on the wire unchanged since the first release, and both exist
 * to end the quarantine. Everything else is refused, because an op's shape is
 * exactly what the two ends have been found to disagree about.
 */
const QUARANTINE_OPS = new Set(["daemon.selfUpgrade", "daemon.checkUpgrade"]);

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

	if (link.quarantine && !QUARANTINE_OPS.has(op)) {
		return Promise.reject(
			new Error(t("daemon.quarantinedOp", { name: daemon, reason: link.quarantine })),
		);
	}

	const id = `${daemon}:${++requestCounter}`;

	return new Promise<OpResult>((resolve, reject) => {
		pending.set(id, { resolve, reject, reporter, follower: daemon });

		link.ws.send(
			JSON.stringify({ t: "rpc", id, op, args, withProgress: reporter !== undefined }),
		);
	});
}

/** When this hub last pushed a recovery upgrade at each quarantined follower. */
const recoveryPushes = new Map<string, number>();

/**
 * A quarantined follower reconnects every couple of seconds, and each attempt
 * would otherwise be another push; this is what keeps the rescue to one try per
 * problem rather than a download every reconnect.
 */
const RECOVERY_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Hand a quarantined follower the upgrade that would end its quarantine.
 *
 * This is the one thing a hub does to a follower unprompted, and it exists
 * because the alternative is a machine nobody can reach: the primary cannot
 * route work to it, and it has no operator sitting in front of it. The upgrade
 * op is the frame both builds still agree on, which is what makes it possible at
 * all.
 *
 * Two limits. It only runs when the follower is **behind**; one that is ahead
 * needs the primary upgraded instead, and handing it an older binary would take
 * the fleet backwards. And it is never forced, so a follower with nothing newer
 * to install stays put and stays visibly quarantined, rather than reinstalling
 * the build it is already running every time it reconnects.
 */
function pushRecoveryUpgrade(link: FollowerLink): void {
	if (!hubConfig || !pushesRecoveryUpgrades(hubConfig)) {
		return;
	}

	if (link.protocol !== undefined && link.protocol > PROTOCOL_VERSION) {
		log(t("daemon.quarantine.ahead", { name: link.name }));

		return;
	}

	const last = recoveryPushes.get(link.name) ?? 0;

	if (Date.now() - last < RECOVERY_COOLDOWN_MS) {
		return;
	}

	recoveryPushes.set(link.name, Date.now());

	log(t("daemon.quarantine.pushing", { name: link.name }));
	pushEvent(daemonEventKey(link.name), "action", t("daemon.quarantine.pushing", { name: link.name }));

	// a follower that applies this exits immediately, so the call is answered by
	// a dying socket as often as not; the outcome that matters is the reconnect
	forwardOp(link.name, "daemon.selfUpgrade", [false]).catch((err: unknown) => {
		log(
			t("daemon.quarantine.pushFailed", {
				name: link.name,
				error: err instanceof Error ? err.message : String(err),
			}),
		);
	});
}

/**
 * Upgrade one daemon in the fleet.
 *
 * A follower is told to pull the binary this primary is running; the fast path
 * for a development cluster. The primary has no such source, so it upgrades
 * itself from the GitHub release; either way the daemon resolves its own source
 * (DESIGN.md §4.7) and this only decides *where the request runs*.
 */
async function upgradeDaemon(
	name: string,
	force: boolean,
	reporter?: ProgressReporter,
): Promise<unknown> {
	if (name === hubConfig?.name) {
		pushEvent(daemonEventKey(name), "action", "self-upgrade requested from the console");

		return await selfUpgrade(force, reporter);
	}

	if (!followers.has(name)) {
		throw new Error(t("daemon.followerNotConnected", { name }));
	}

	pushEvent(daemonEventKey(name), "action", "upgrade requested by the primary");

	const outcome = await forwardOp(name, "daemon.selfUpgrade", [force], reporter);

	return outcome.result;
}

/** Ask one daemon what it could upgrade to, without applying anything. */
async function checkDaemonUpgrade(name: string, refresh: boolean): Promise<unknown> {
	if (name === hubConfig?.name) {
		return await checkUpgrade(refresh);
	}

	if (!followers.has(name)) {
		throw new Error(t("daemon.followerNotConnected", { name }));
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

	for (const [id, stream] of streams) {
		if (stream.follower === name) {
			clearTimeout(stream.readyTimer);
			streams.delete(id);
			stream.onEnd(reason);
		}
	}
}

/**
 * Open a live console tunnel to a follower-owned instance: the follower tails
 * the instance's log and streams the lines back over the cluster link. Returns
 * the closer; `onEnd` fires exactly once when the tunnel dies for any reason
 * other than that closer.
 */
function openConsoleStream(
	daemon: string,
	instance: string,
	lines: number,
	onLine: (line: string) => void,
	onEnd: (error?: string) => void,
): () => void {
	const link = followers.get(daemon);

	if (!link) {
		queueMicrotask(() => onEnd(`daemon "${daemon}" is not connected`));

		return () => {};
	}

	const id = `${daemon}:s${++requestCounter}`;
	const stream: HubStream = { follower: daemon, onLine, onEnd };

	stream.readyTimer = setTimeout(() => {
		streams.delete(id);
		onEnd(t("daemon.consoleTimeout", { name: daemon }));
	}, STREAM_READY_TIMEOUT_MS);

	streams.set(id, stream);
	link.ws.send(JSON.stringify({ t: "stream-open", id, kind: "console", instance, lines }));

	return () => {
		const open = streams.get(id);

		if (!open) {
			return;
		}

		clearTimeout(open.readyTimer);
		streams.delete(id);
		followers.get(daemon)?.ws.send(JSON.stringify({ t: "stream-close", id }));
	};
}

/**
 * One heartbeat round. A follower that has not answered the previous ping is
 * counted as missing one; after MISSED_PINGS_BEFORE_DROP the socket is closed
 * so the follower's own reconnect loop starts a fresh link.
 *
 * The ping also carries LunaCore's cards for the instances that follower owns:
 * the plugin only talks to the primary, and its sampler needs them at exactly
 * this cadence. The cluster view is best-effort; a failed read costs the round
 * its telemetry, never its heartbeat.
 */
async function pingRound(): Promise<void> {
	const cfg = await clusterView().catch(() => undefined);

	for (const link of followers.values()) {
		if (link.pending) {
			link.missed += 1;

			if (link.missed >= MISSED_PINGS_BEFORE_DROP) {
				log(t("daemon.log.droppingLink", { name: link.name, count: link.missed }));
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
		const luna = cfg ? lunaCardsFor(ownedInstances(cfg, link.name)) : [];

		link.pending = { seq: ++link.pingSeq, at };
		link.ws.send(
			JSON.stringify({
				t: "ping",
				seq: link.pingSeq,
				at,
				luna,
				lunaIssue: lunaProblem(),
			}),
		);
	}
}

/**
 * Running, non-external instances a daemon owns, paired with the port each one
 * listens on. Built from `ownedInstances` rather than `cfg.instances` directly
 * so the proxy; which lives outside that map; is included for the primary.
 */
function reachTargets(
	cfg: ClusterConfig,
	daemon: string | undefined,
	states: Record<string, string>,
): Array<{ name: string; port: number }> {
	const ports: Record<string, number> = { proxy: cfg.proxy.port };

	for (const [name, inst] of Object.entries(cfg.instances)) {
		ports[name] = inst.port;
	}

	return ownedInstances(cfg, daemon)
		.filter((name) => states[name] === "running" && ports[name] !== undefined)
		.map((name) => ({ name, port: ports[name]! }));
}

/**
 * Whether a daemon's instance states have arrived yet.
 *
 * The status sampler fills them a beat after a daemon comes up, and a
 * follower's ride in on its first heartbeat pong. Probing before then finds no
 * running instance and would report "nothing to probe" about a host that is in
 * fact running servers; a confident pass that is simply wrong. A daemon that
 * owns nothing has no states to wait for, so it is ready immediately.
 */
function statesReady(
	cfg: ClusterConfig,
	daemon: string | undefined,
	states: Record<string, string>,
): boolean {
	return Object.keys(states).length > 0 || ownedInstances(cfg, daemon).length === 0;
}

/** TCP-probe every target at one host, concurrently. */
async function probeInstances(
	host: string,
	targets: Array<{ name: string; port: number }>,
): Promise<ReachResult[]> {
	return await Promise.all(
		targets.map(async (target): Promise<ReachResult> => ({
			instance: target.name,
			address: `${host}:${target.port}`,
			ok: await portOpen(host, target.port),
		})),
	);
}

/**
 * Probe the primary's own running instances over loopback.
 *
 * This confirms more than it discovers, and deliberately so: core already
 * grades an instance "running" only once it answers a status ping on loopback
 * (`getStatus`), so a target here has essentially already proven the point -
 * what it catches is the gap between that sample and now. The reason to run it
 * anyway is that the primary is a daemon like any other, and a check that can
 * only ever report "unknown" about the busiest machine in the cluster is worse
 * than a cheap one that reports the truth. The probe that genuinely discovers
 * something is the follower's, where a LAN sits in the way.
 */
async function probeSelf(): Promise<void> {
	const cfg = await clusterView();
	const states = currentHealth()?.states ?? {};

	if (!statesReady(cfg, undefined, states)) {
		return;
	}

	const results = await probeInstances(LOOPBACK, reachTargets(cfg, undefined, states));

	selfReach = { at: Date.now(), results };
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

	if (!statesReady(cfg, link.name, states)) {
		return;
	}

	const results = await probeInstances(link.host, reachTargets(cfg, link.name, states));

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

/** Probe this machine and every connected follower. */
function reachRound(): void {
	void probeSelf();

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
	line?: string;
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

		// A mismatched protocol used to close the socket here, which was the wrong
		// half of the problem to solve: the follower is then unreachable by the one
		// machine able to fix it, and all the fleet view can say is "offline". The
		// link is kept instead and marked, so the daemon stays visible, keeps
		// answering heartbeats, and can still be handed the upgrade that ends it.
		const quarantine =
			frame.protocol === PROTOCOL_VERSION
				? undefined
				: t("daemon.quarantine.protocol", {
						hub: PROTOCOL_VERSION,
						follower: frame.protocol ?? "?",
					});

		const link: FollowerLink = {
			ws,
			name: frame.name,
			host: frame.host || ws.remoteAddress,
			addresses: frame.addresses ?? [],
			root: frame.root,
			version: frame.version,
			protocol: frame.protocol,
			quarantine,
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

		// same reason as the primary's own probe at startup: without this the
		// check reads "not probed yet" until the next 30s round comes around
		void probeReach(link);

		if (link.quarantine) {
			// an older build ignores a frame type it does not know, so this is only
			// read by one new enough to say something useful about it
			ws.send(
				JSON.stringify({
					t: "quarantined",
					name: hubConfig?.name,
					protocol: PROTOCOL_VERSION,
					reason: link.quarantine,
				}),
			);

			log(`follower "${link.name}" quarantined: ${link.quarantine}`);
			pushEvent(daemonEventKey(link.name), "error", link.quarantine);

			pushRecoveryUpgrade(link);

			return;
		}

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
		// only the outstanding ping's echo measures anything; a late pong from a
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

	if (frame.t === "stream-ready" && frame.id) {
		const stream = streams.get(frame.id);

		if (stream) {
			clearTimeout(stream.readyTimer);
			stream.readyTimer = undefined;
		}

		return;
	}

	if (frame.t === "stream-data" && frame.id && typeof frame.line === "string") {
		streams.get(frame.id)?.onLine(frame.line);

		return;
	}

	if (frame.t === "stream-end" && frame.id) {
		const stream = streams.get(frame.id);

		if (stream) {
			clearTimeout(stream.readyTimer);
			streams.delete(frame.id);
			stream.onEnd(frame.error);
		}

		return;
	}

	if (frame.t === "event" && frame.instance && frame.kind && frame.message) {
		pushEvent(frame.instance, frame.kind, frame.message);

		return;
	}

	if (frame.t === "save" && frame.file && frame.data !== undefined) {
		// the primary is the single writer: persist, and the root watcher turns the
		// write into a sync frame every follower (the sender included) picks up.
		// No recursion; only a follower installs the save-through hook.
		if (frame.file === "cluster") {
			await saveCluster(frame.data as ClusterConfig);
		} else if (frame.file === "lock") {
			await saveLock(frame.data as never);
		} else if (frame.file === "env") {
			await saveEnv(frame.data as EnvironmentStore);
		} else if (frame.file === "configfiles") {
			await saveConfigFiles(frame.data as ConfigFileStore);
		} else if (frame.file === "accounts") {
			await saveAccounts(frame.data as AccountStore);
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

		// only the *current* link's close should deregister; a replaced socket
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
	setRemoteConsole({
		connected: (daemon) => followers.has(daemon),
		open: openConsoleStream,
	});
	setRemoteSampleProvider((daemon, instance) => {
		const health = followers.get(daemon)?.health;

		if (!health) {
			return undefined;
		}

		return { cpu: health.instanceCpu?.[instance], rssMb: health.instanceRssMb?.[instance] };
	});

	void refreshClusterCache();

	pingTimer ??= setInterval(() => void pingRound(), PING_INTERVAL_MS);
	reachTimer ??= setInterval(reachRound, REACH_INTERVAL_MS);

	// setInterval only fires after the first interval, which would leave the
	// primary's own reachability unknown for 30s after every restart. The status
	// sampler needs a beat to fill in, so keep trying on its cadence until a
	// round actually lands, then leave it to the regular timer.
	const firstProbe = setInterval(() => {
		if (selfReach) {
			clearInterval(firstProbe);

			return;
		}

		void probeSelf();
	}, SAMPLE_INTERVAL_MS);

	void probeSelf();

	// Bun.write replaces files, so watch the directory and filter by name. The
	// state files live in `.data/` and are watched there; `watch` is not recursive,
	// so watching the root alone would see none of them.
	watcher = watch(dataDir(), (_kind, filename) => {
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
