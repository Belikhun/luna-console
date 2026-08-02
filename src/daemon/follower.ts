/**
 * Follower daemon runtime: connects to the primary's cluster listener over
 * WebSocket (reconnecting forever), mirrors the synced state files into its own
 * root, executes forwarded operations against its local instances, streams
 * their progress back, and pushes stats + events up (DESIGN.md §4.4).
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { freemem, loadavg, totalmem } from "node:os";
import { dirname, join } from "node:path";

import { installSaveHook, loadCluster, managedInstances, poolDir, root } from "../core/config";
import { effectiveTargets } from "../core/families";
import * as instances from "../core/instances";
import { ProgressReporter } from "../core/progress";
import { sha512File } from "../core/services/modrinth";
import type { ClusterConfig, PluginsLock } from "../core/types";

import type { DaemonConfig } from "./config";
import { installEventForwarder } from "./events";
import { ownsInstance } from "./identity";
import { log } from "./index";
import { runOp } from "./rpc";
import { PROTOCOL_VERSION } from "./server";

const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
const STATS_INTERVAL_MS = 10_000;

/** Progress frames are throttled like the job SSE stream is. */
const PROGRESS_FLUSH_MS = 150;

let dcfg: DaemonConfig | undefined;
let ws: WebSocket | undefined;
let backoffMs = RECONNECT_MIN_MS;
let statsTimer: ReturnType<typeof setInterval> | undefined;

function send(frame: Record<string, unknown>): void {
	if (ws && ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify(frame));
	}
}

/** Fetch one pool file from the primary when missing or hash-mismatched. */
async function ensurePoolFile(rel: string, sha512: string | undefined): Promise<void> {
	const path = join(poolDir(), rel);

	if (existsSync(path)) {
		if (!sha512) {
			return;
		}

		if ((await sha512File(path)) === sha512) {
			return;
		}
	}

	const url = `http://${dcfg!.primary!.address}/files/pool/${encodeURIComponent(rel)}`;
	const response = await fetch(url, {
		headers: { "x-mrds-token": dcfg!.token ?? "" },
	});

	if (!response.ok) {
		throw new Error(`pool fetch failed for ${rel}: HTTP ${response.status}`);
	}

	await mkdir(dirname(path), { recursive: true });
	await Bun.write(path, response);

	log(`pool mirror: fetched ${rel}`);
}

/**
 * Bring the local pool mirror up to the lockfile before a deploy: the primary
 * is the pool's source of truth, this daemon only caches what its own
 * instances need (resolved through effectiveTargets, same as deploy itself).
 * Hash-checked, so a changed jar is re-fetched and an unchanged one is never
 * transferred twice.
 */
async function ensurePoolMirror(cfg: ClusterConfig, lock: PluginsLock): Promise<void> {
	const insts = managedInstances(cfg);
	const owned = new Set(Object.keys(insts).filter((name) => ownsInstance(insts[name]!)));

	for (const [key, entry] of Object.entries(lock.plugins)) {
		const wanted = effectiveTargets(cfg, lock, key).some((name) => owned.has(name));

		if (!wanted) {
			continue;
		}

		await ensurePoolFile(entry.file, entry.installed?.sha512);

		for (const variant of Object.values(entry.variants ?? {})) {
			await ensurePoolFile(join("versions", variant.file), variant.sha512);
		}
	}
}

interface PrimaryFrame {
	t: string;
	id?: string;
	op?: string;
	args?: unknown[];
	withProgress?: boolean;
	files?: Record<string, string>;
	name?: string;
}

/** Execute one forwarded operation and stream its outcome (and progress) back. */
async function handleForwardedOp(frame: PrimaryFrame): Promise<void> {
	const { id, op } = frame;

	if (!id || !op) {
		return;
	}

	let reporter: ProgressReporter | undefined;
	let flusher: ReturnType<typeof setInterval> | undefined;

	if (frame.withProgress) {
		reporter = new ProgressReporter(op);

		let dirty = false;

		reporter.onUpdate(() => {
			dirty = true;
		});

		flusher = setInterval(() => {
			if (dirty) {
				dirty = false;
				send({ t: "progress", id, snapshot: reporter!.snapshot() });
			}
		}, PROGRESS_FLUSH_MS);
	}

	try {
		// a deploy copies out of the pool — mirror it from the primary first,
		// against the cfg travelling with the call (the local sync may lag it)
		if (op === "plugins.deploy" && Array.isArray(frame.args)) {
			await ensurePoolMirror(frame.args[0] as ClusterConfig, frame.args[1] as PluginsLock);
		}

		const outcome = await runOp(op, frame.args ?? [], reporter);

		if (reporter) {
			send({ t: "progress", id, snapshot: reporter.snapshot() });
		}

		send({ t: "result", id, ok: true, ...outcome });
	} catch (err) {
		send({ t: "result", id, ok: false, error: err instanceof Error ? err.message : String(err) });
	} finally {
		if (flusher) {
			clearInterval(flusher);
		}
	}
}

/** Write the primary's state files into this daemon's root, verbatim. */
async function applySync(files: Record<string, string>): Promise<void> {
	for (const [name, text] of Object.entries(files)) {
		const path = join(root(), name);

		await mkdir(dirname(path), { recursive: true });
		await Bun.write(path, text);
	}
}

/** One stats heartbeat: host load/memory plus this daemon's instance states. */
async function sendStats(): Promise<void> {
	try {
		const cfg = await loadCluster();
		const insts = managedInstances(cfg);
		const owned = Object.keys(insts).filter((name) => ownsInstance(insts[name]!));

		const states: Record<string, string> = {};

		await Promise.all(
			owned.map(async (name) => {
				const status = await instances.getStatus(cfg, name);

				states[name] = status.state;
			}),
		);

		send({
			t: "stats",
			stats: {
				load1: loadavg()[0],
				memUsedMb: Math.round((totalmem() - freemem()) / 1024 / 1024),
				memTotalMb: Math.round(totalmem() / 1024 / 1024),
				states,
			},
		});
	} catch {
		// no cluster.json yet — the first sync has not arrived
	}
}

function connect(): void {
	const address = dcfg!.primary!.address;
	const token = encodeURIComponent(dcfg!.token ?? "");

	ws = new WebSocket(`ws://${address}/cluster?token=${token}`);

	ws.onopen = () => {
		backoffMs = RECONNECT_MIN_MS;

		log(`connected to primary at ${address}`);

		send({
			t: "register",
			name: dcfg!.name,
			root: root(),
			host: dcfg!.host,
			protocol: PROTOCOL_VERSION,
			version: String(PROTOCOL_VERSION),
		});
	};

	ws.onmessage = (event) => {
		let frame: PrimaryFrame;

		try {
			frame = JSON.parse(String(event.data));
		} catch {
			return;
		}

		if (frame.t === "registered") {
			log(`registered with primary "${frame.name}"`);

			return;
		}

		if (frame.t === "sync" && frame.files) {
			void applySync(frame.files).then(() => {
				log(`state sync applied (${Object.keys(frame.files!).join(", ")})`);
			});

			return;
		}

		if (frame.t === "rpc") {
			void handleForwardedOp(frame);
		}
	};

	ws.onclose = (event) => {
		log(`primary link lost (${event.code}${event.reason ? ` ${event.reason}` : ""}) — retrying in ${Math.round(backoffMs / 1000)}s`);

		ws = undefined;

		setTimeout(connect, backoffMs);
		backoffMs = Math.min(RECONNECT_MAX_MS, backoffMs * 2);
	};

	ws.onerror = () => {
		// onclose follows with the retry; nothing useful to add here
	};
}

/** Start the follower runtime: save-through, event forwarding, link, stats. */
export function startFollower(config: DaemonConfig): void {
	dcfg = config;

	// a follower never writes state files on its own authority — every save
	// goes up to the primary, which persists it and broadcasts the new sync
	installSaveHook(async (file, data) => {
		send({ t: "save", file, data });
	});

	installEventForwarder((event) => {
		send({ t: "event", instance: event.instance, kind: event.kind, message: event.message });
	});

	connect();

	statsTimer ??= setInterval(() => void sendStats(), STATS_INTERVAL_MS);
}
