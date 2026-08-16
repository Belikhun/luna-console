// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Follower daemon runtime: connects to the primary's cluster listener over
 * WebSocket (reconnecting forever), mirrors the synced state files into its own
 * root, executes forwarded operations against its local instances, streams
 * their progress back, and pushes stats + events up (DESIGN.md §4.4).
 */

import { existsSync } from "node:fs";
import { t } from "../shared/i18n";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
	installSaveHook,
	instanceDir,
	loadCluster,
	managedInstances,
	poolDir,
	root,
	syncFilePath,
} from "../core/config";
import { datapacksDir, datapackTargets, type AddonGroups } from "../core/datapacks";
import { setProxyHost } from "../core/environment";
import { effectiveTargets } from "../core/families";
import type { PacksLock } from "../core/packslock";
import { ProgressReporter } from "../core/progress";
import type { BackendCard } from "../core/services/luna";
import { sha512File } from "../core/services/download";
import { ensureStagingDir, stagePath } from "../core/staging";
import type { ClusterConfig, PluginsLock } from "../core/types";

import { selfUpgradesAutomatically, type DaemonConfig } from "./config";
import { installEventForwarder } from "./events";
import { currentHealth, hostAddresses } from "./health";
import { ownsInstance } from "./identity";
import { log } from "./index";
import { installStageFetcher, runOp, setLinkQuarantine } from "./rpc";
import { setLunaTelemetry } from "./sampler";
import { PROTOCOL_VERSION } from "./server";
import { tailFollow, type TailHandle } from "./tail";
import { selfUpgrade, setUpgradeSource } from "./upgrade";
import { buildVersion } from "../version";

const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

/** Progress frames are throttled like the job SSE stream is. */
const PROGRESS_FLUSH_MS = 150;

let dcfg: DaemonConfig | undefined;
let ws: WebSocket | undefined;
let backoffMs = RECONNECT_MIN_MS;
let startedAt = Date.now();

function send(frame: Record<string, unknown>): void {
	if (ws && ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify(frame));
	}
}

/** Fetch one primary-hosted file when missing or hash-mismatched. */
async function ensureMirroredFile(
	endpoint: "pool" | "datapacks",
	dir: string,
	rel: string,
	sha512: string | undefined,
): Promise<void> {
	const path = join(dir, rel);

	if (existsSync(path)) {
		if (!sha512) {
			return;
		}

		if ((await sha512File(path)) === sha512) {
			return;
		}
	}

	const url = `http://${dcfg!.primary!.address}/files/${endpoint}/${encodeURIComponent(rel)}`;
	const response = await fetch(url, {
		headers: { "x-luna-token": dcfg!.token ?? "" },
	});

	if (!response.ok) {
		throw new Error(`${endpoint} fetch failed for ${rel}: HTTP ${response.status}`);
	}

	await mkdir(dirname(path), { recursive: true });
	await Bun.write(path, response);

	log(`${endpoint} mirror: fetched ${rel}`);
}

/** Fetch one pool file from the primary when missing or hash-mismatched. */
async function ensurePoolFile(rel: string, sha512: string | undefined): Promise<void> {
	await ensureMirroredFile("pool", poolDir(), rel, sha512);
}

/**
 * Pull a staged world zip down from the primary.
 *
 * An upload always lands on the primary, because that is where the console
 * runs, but the instance it is destined for may be owned by this daemon. The
 * bytes therefore have to cross the cluster link, and they do it the same way
 * every other large file does: this side fetches, streaming the response
 * straight to disk rather than through memory.
 *
 * Idempotent. A token already here is left alone, which is what makes a retried
 * provision cheap.
 */
export async function ensureStagedWorld(token: string): Promise<string> {
	const path = stagePath(token);

	if (existsSync(path)) {
		return path;
	}

	if (!dcfg?.primary?.address) {
		throw new Error(t("daemon.noPrimaryForStage"));
	}

	await ensureStagingDir();

	const url = `http://${dcfg.primary.address}/files/stage/${encodeURIComponent(token)}`;
	const response = await fetch(url, {
		headers: { "x-luna-token": dcfg.token ?? "" },
	});

	if (!response.ok) {
		throw new Error(t("daemon.stageFetchFailed", { token, status: String(response.status) }));
	}

	await Bun.write(path, response);

	log(`stage: fetched ${token}`);

	return path;
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

/**
 * Bring the local data pack pool up to the lock before a forwarded deploy -
 * the primary's pool is the source, this daemon caches only the zips its own
 * instances are targeted with.
 */
async function ensureDatapackMirror(
	cfg: ClusterConfig,
	lock: PacksLock,
	groups?: AddonGroups,
): Promise<void> {
	const insts = managedInstances(cfg);
	const owned = new Set(Object.keys(insts).filter((name) => ownsInstance(insts[name]!)));

	for (const [pack, entry] of Object.entries(lock.datapacks)) {
		const wanted = datapackTargets(cfg, pack, entry, groups).some((name) => owned.has(name));

		if (!wanted) {
			continue;
		}

		await ensureMirroredFile("datapacks", datapacksDir(), entry.file, entry.installed?.sha512);
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
	seq?: number;
	at?: number;
	instance?: string;
	lines?: number;
	/** LunaCore cards for this machine's instances, riding the ping */
	luna?: BackendCard[];
	lunaIssue?: string;
	/** Why the primary refused this build, on a "quarantined" frame */
	reason?: string;
}

/** Live console tails feeding the primary's tunnel, keyed by stream id. */
const tails = new Map<string, TailHandle>();

/** Open one console tunnel: tail the owned instance's log, stream lines up. */
async function openConsoleTail(frame: PrimaryFrame): Promise<void> {
	const { id, instance } = frame;

	if (!id || !instance) {
		return;
	}

	const cfg = await loadCluster();
	const inst = managedInstances(cfg)[instance];

	if (!inst || !ownsInstance(inst)) {
		send({ t: "stream-end", id, error: t("daemon.notOwned", { name: instance }) });

		return;
	}

	// the ack is what tells the primary this build understands the tunnel; an
	// empty log legitimately produces no lines, so silence cannot mean support
	send({ t: "stream-ready", id });

	const handle = tailFollow(
		join(instanceDir(inst), "logs", "latest.log"),
		frame.lines ?? 100,
		(line) => send({ t: "stream-data", id, line }),
		() => {
			tails.delete(id);
			send({ t: "stream-end", id });
		},
	);

	tails.set(id, handle);
}

/** Stop every live tail; the link died, nobody is listening anymore. */
function stopAllTails(): void {
	for (const handle of tails.values()) {
		handle.stop();
	}

	tails.clear();
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
		// a deploy copies out of the pool; mirror it from the primary first,
		// against the cfg travelling with the call (the local sync may lag it)
		if (op === "plugins.deploy" && Array.isArray(frame.args)) {
			await ensurePoolMirror(frame.args[0] as ClusterConfig, frame.args[1] as PluginsLock);
		}

		if (op === "datapacks.deploy" && Array.isArray(frame.args)) {
			// the deploy options carry the addon groups, so a pack a group grants
			// (with no target of its own) is mirrored as well
			const opts = frame.args[2] as { groups?: AddonGroups } | undefined;

			await ensureDatapackMirror(
				frame.args[0] as ClusterConfig,
				frame.args[1] as PacksLock,
				opts?.groups,
			);
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

/**
 * Write the primary's state files into this daemon's root, verbatim.
 *
 * The primary sends logical names, so where each one lands is decided here; a
 * state file goes to `.data/`, anything else stays root-relative.
 */
async function applySync(files: Record<string, string>): Promise<void> {
	for (const [name, text] of Object.entries(files)) {
		const path = syncFilePath(name);

		await mkdir(dirname(path), { recursive: true });
		await Bun.write(path, text);
	}
}

/**
 * How long before another go at recovering from a protocol mismatch.
 *
 * The reconnect loop retries every couple of seconds and each refusal would
 * otherwise be another attempt, so without this a fleet-wide protocol bump turns
 * every stranded follower into a machine hammering GitHub twice a second.
 */
const RECOVERY_COOLDOWN_MS = 10 * 60 * 1000;

/** When this process last tried to upgrade its way out of a mismatch. */
let recoveryAt = 0;

/**
 * Pull a newer build after the primary refused this one's protocol.
 *
 * **Never forced.** It used to be, and forcing takes whatever the preferred
 * channel is serving even when that is the build already running: a follower
 * whose fix had not been released yet would install its own version again, exit,
 * reconnect, be refused, and do it all again about every eleven seconds - for as
 * long as nobody looked. Unforced, a follower with nothing newer to install
 * stays up and stays quarantined, which is a state the fleet view can show and
 * an operator can act on.
 */
async function recoverFromProtocolMismatch(): Promise<void> {
	if (Date.now() - recoveryAt < RECOVERY_COOLDOWN_MS) {
		return;
	}

	if (!selfUpgradesAutomatically(dcfg!)) {
		log(t("daemon.log.protocolMismatchNoAuto"));

		recoveryAt = Date.now();

		return;
	}

	recoveryAt = Date.now();

	log(t("daemon.log.protocolMismatch"));

	try {
		const result = await selfUpgrade(false);

		log(`upgrading ${result.from} → ${result.to}`);
	} catch (err) {
		log(`self-upgrade failed: ${err instanceof Error ? err.message : String(err)}`);
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
			// with no advertised host the primary falls back to the address it sees
			// on the socket, which is by definition a route that works
			host: dcfg!.host,
			addresses: hostAddresses(),
			// the port this daemon's own HTTP API answers on, so the primary can
			// reach back for a file rather than only being reached. Optional on
			// purpose: an older follower simply omits it, and the primary then
			// reports a follower-held backup as unreachable instead of guessing a
			// port and serving whatever answers there.
			listenPort: dcfg!.listen?.port,
			startedAt,
			protocol: PROTOCOL_VERSION,
			version: buildVersion(),
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
			setLinkQuarantine(undefined);

			return;
		}

		// the primary kept the socket but will not give this build work; it may
		// push an upgrade down it, and this end tries for one as well, because
		// which of the two can reach a new binary depends on the platform
		if (frame.t === "quarantined") {
			log(t("daemon.log.quarantined", { reason: frame.reason ?? "?" }));
			setLinkQuarantine(frame.reason ?? t("daemon.log.quarantined", { reason: "?" }));

			void recoverFromProtocolMismatch();

			return;
		}

		if (frame.t === "sync" && frame.files) {
			void applySync(frame.files).then(() => {
				log(`state sync applied (${Object.keys(frame.files!).join(", ")})`);
			});

			return;
		}

		if (frame.t === "ping") {
			// the ping brings LunaCore's telemetry down (only the primary can ask
			// the proxy for it) and the pong takes this machine's health back up -
			// one round trip measures latency and moves both halves of the picture
			if (frame.luna) {
				setLunaTelemetry(frame.luna, frame.lunaIssue);
			}

			send({ t: "pong", seq: frame.seq, at: frame.at, health: currentHealth() });

			return;
		}

		if (frame.t === "rpc") {
			void handleForwardedOp(frame);

			return;
		}

		if (frame.t === "stream-open") {
			void openConsoleTail(frame);

			return;
		}

		if (frame.t === "stream-close" && frame.id) {
			tails.get(frame.id)?.stop();
			tails.delete(frame.id);
		}
	};

	ws.onclose = (event) => {
		log(t("daemon.log.linkLost", { code: `${event.code}${event.reason ? ` ${event.reason}` : ""}`, seconds: Math.round(backoffMs / 1000) }));

		stopAllTails();

		// the one automatic upgrade: a protocol mismatch means this build can no
		// longer talk to the primary at all, and reconnecting cannot fix that.
		// A primary new enough to quarantine instead of closing says so on an open
		// socket; this is the same fact arriving from one that is not
		if (event.reason?.includes("protocol mismatch")) {
			setLinkQuarantine(event.reason);

			void recoverFromProtocolMismatch();
		}

		ws = undefined;

		setTimeout(connect, backoffMs);
		backoffMs = Math.min(RECONNECT_MAX_MS, backoffMs * 2);
	};

	ws.onerror = () => {
		// onclose follows with the retry; nothing useful to add here
	};
}

/** Start the follower runtime: save-through, event forwarding, link, heartbeats. */
export function startFollower(config: DaemonConfig, processStartedAt: number): void {
	dcfg = config;
	startedAt = processStartedAt;

	// a follower never writes state files on its own authority; every save
	// goes up to the primary, which persists it and broadcasts the new sync
	installSaveHook(async (file, data) => {
		send({ t: "save", file, data });
	});

	installEventForwarder((event) => {
		send({ t: "event", instance: event.instance, kind: event.kind, message: event.message });
	});

	// an upload lands on the primary, because that is where the console runs; a
	// world destined for an instance this daemon owns has to be pulled across
	installStageFetcher(ensureStagedWorld);

	// where a self-upgrade fetches its new binary from
	setUpgradeSource(config.primary!.address, config.token ?? "");

	// the proxy runs on the primary's host, so that is where THIS machine's
	// instances must send their LunaCore heartbeats; not at loopback
	setProxyHost(config.primary!.address.split(":")[0]!);

	connect();
}
