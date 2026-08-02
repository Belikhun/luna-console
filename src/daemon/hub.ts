/**
 * The primary daemon's cluster hub: accepts follower WebSocket connections,
 * keeps the live follower registry, forwards instance-scoped operations to
 * their owners, and pushes state-file syncs whenever cluster.json /
 * plugins.lock.json / environment.json change (DESIGN.md §4.4).
 */

import { watch, type FSWatcher } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { loadCluster, saveCluster, saveLock, root } from "../core/config";
import { ProgressReporter } from "../core/progress";
import type { ClusterConfig, DaemonRegistration } from "../core/types";
import { applySnapshot } from "../shared/progressMirror";

import type { DaemonConfig } from "./config";
import { pushEvent, type ClusterEvent } from "./events";
import { log } from "./index";
import { installRouting, setDaemonsProvider, type OpResult, type OpSpec } from "./rpc";
import { PROTOCOL_VERSION } from "./server";

/** State files a follower mirrors from the primary. The forwarding secret rides
 *  along so a follower can key paper-global.yml when materializing instances. */
const SYNC_FILES = [
	"cluster.json",
	"plugins.lock.json",
	"environment.json",
	"proxy/forwarding.secret",
] as const;

export interface FollowerStats {
	load1: number;
	memUsedMb: number;
	memTotalMb: number;
	/** instance name → UI state, for the daemons view */
	states: Record<string, string>;
}

interface FollowerLink {
	ws: Bun.ServerWebSocket<{ kind: string }>;
	name: string;
	host: string;
	root: string;
	version?: string;
	connectedAt: number;
	lastSeen: number;
	stats?: FollowerStats;
}

/** One row of the daemons management view. */
export interface DaemonRow {
	name: string;
	mode: "primary" | "follower";
	host: string | null;
	online: boolean;
	version: string | null;
	connectedAt: number | null;
	lastSeen: string | null;
	stats: FollowerStats | null;
	/** Instance names owned by this daemon */
	instances: string[];
}

interface Pending {
	resolve: (result: OpResult) => void;
	reject: (err: Error) => void;
	reporter?: ProgressReporter;
	follower: string;
}

const followers = new Map<string, FollowerLink>();
const pending = new Map<string, Pending>();

let hubConfig: DaemonConfig | undefined;
let requestCounter = 0;
let watcher: FSWatcher | undefined;
let syncTimer: ReturnType<typeof setTimeout> | undefined;

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
		version: link.version,
		addedAt: existing?.addedAt ?? new Date().toISOString(),
		lastSeen: new Date().toISOString(),
	};

	await saveCluster(cfg);
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

/** The daemons management view: the primary itself plus every known follower. */
async function listDaemons(): Promise<DaemonRow[]> {
	const cfg = await loadCluster();
	const rows: DaemonRow[] = [];

	rows.push({
		name: hubConfig?.name ?? "primary",
		mode: "primary",
		host: hubConfig?.listen ? `${hubConfig.listen.host}:${hubConfig.listen.port}` : null,
		online: true,
		version: String(PROTOCOL_VERSION),
		connectedAt: null,
		lastSeen: new Date().toISOString(),
		stats: null,
		instances: ownedInstances(cfg, undefined),
	});

	const known = new Set([...Object.keys(cfg.daemons ?? {}), ...followers.keys()]);

	for (const name of [...known].sort()) {
		const link = followers.get(name);
		const registered = cfg.daemons?.[name];

		rows.push({
			name,
			mode: "follower",
			host: link?.host ?? registered?.host ?? null,
			online: !!link,
			version: link?.version ?? registered?.version ?? null,
			connectedAt: link?.connectedAt ?? null,
			lastSeen: link ? new Date().toISOString() : (registered?.lastSeen ?? null),
			stats: link?.stats ?? null,
			instances: ownedInstances(cfg, name),
		});
	}

	return rows;
}

/** The live link for a follower, if connected. */
export function followerLink(name: string): FollowerLink | undefined {
	return followers.get(name);
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

/** Settle every pending request that was waiting on a lost follower. */
function rejectPendingFor(name: string, reason: string): void {
	for (const [id, entry] of pending) {
		if (entry.follower === name) {
			pending.delete(id);
			entry.reject(new Error(reason));
		}
	}
}

interface FollowerFrame {
	t: string;
	id?: string;
	name?: string;
	host?: string;
	root?: string;
	version?: string;
	protocol?: number;
	ok?: boolean;
	result?: unknown;
	cfg?: unknown;
	lock?: unknown;
	error?: string;
	snapshot?: Parameters<typeof applySnapshot>[1];
	stats?: FollowerStats;
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
			root: frame.root,
			version: frame.version,
			connectedAt: Date.now(),
			lastSeen: Date.now(),
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
		pushEvent("daemon", "state", `follower ${link.name} connected`);

		return;
	}

	const link = ws.data.name ? followers.get(ws.data.name) : undefined;

	if (!link) {
		ws.close(1008, "not registered");

		return;
	}

	link.lastSeen = Date.now();

	if (frame.t === "stats" && frame.stats) {
		link.stats = frame.stats;

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
			log(`follower "${name}" disconnected`);
			pushEvent("daemon", "state", `follower ${name} disconnected`);
		}
	},
};

/** Wire the hub into the daemon: routing hooks, sync watcher, management ops. */
export function installHub(dcfg: DaemonConfig): void {
	hubConfig = dcfg;

	installRouting(resolveRemote, forwardOp);
	setDaemonsProvider(listDaemons);

	void refreshClusterCache();

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

/** Stop the sync watcher (shutdown). */
export function stopHub(): void {
	watcher?.close();
	watcher = undefined;
}
