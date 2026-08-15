// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The daemon's metrics sampler; ported from the web console's server bridge,
 * because the daemon is the long-lived 24/7 process now. Holds per-instance
 * metric history, the UI's transient states (starting/stopping), and the latest
 * LunaCore telemetry; everything the instances table and detail pages render.
 */

import { readFile } from "node:fs/promises";
import { t } from "../shared/i18n";

import { instanceDir, loadCluster, managedInstances } from "../core/config";
import { instanceAddress } from "../core/ports";
import * as instances from "../core/instances";
import * as luna from "../core/services/luna";
import type { BackendCard } from "../core/services/luna";
import type { ClusterConfig } from "../core/types";

import { pushEvent } from "./events";
import { currentHealth } from "./health";
import { isPrimary, ownsInstance } from "./identity";
import { getAllStatusesRouted, getStatusRouted } from "./rpc";

/**
 * `restarting` is the console's own transient, set when an operator asks for a
 * restart; `auto-restarting` comes from core and means the wrapper loop is
 * waiting out its delay after a crash. They read alike and mean different
 * things: one was asked for, the other was not.
 */
export type UiState =
	| "running"
	| "starting"
	| "stopping"
	| "stopped"
	| "restarting"
	| "auto-restarting"
	| "unknown";

/** Status as core reports it, before the UI's transient states are layered on. */
type CoreStatus = Awaited<ReturnType<typeof instances.getStatus>>;

export interface MetricSample {
	t: number;
	cpu?: number; // percent of one core
	rssMb?: number;
	players?: number;
	pingMs?: number;
	/** From LunaCore's heartbeat, when the plugin is installed and reporting */
	tps?: number;
	heapUsedMb?: number;
	heapMaxMb?: number;
}

interface InstanceRuntime {
	history: MetricSample[];
	lastState?: string;
	prevCpu?: { total: number; at: number };
}

const MAX_SAMPLES = 720; // 1h at 5s
const SAMPLE_INTERVAL_MS = 5000;

/** How long a transient state may linger before the sampler gives up on it. */
const TRANSITION_TIMEOUT_MS = 180_000;

interface Transition {
	state: "stopping" | "restarting";
	since: number;
	/** set once the process has actually gone down, so a restart is not settled by the state it started from */
	sawDown: boolean;
}

const runtime = new Map<string, InstanceRuntime>();
const transitions = new Map<string, Transition>();
const lastStatuses = new Map<string, CoreStatus>();

/** What the owner's heartbeat knows about one of its instances. */
export interface RemoteSample {
	cpu?: number;
	rssMb?: number;
}

/**
 * Process metrics of an instance owned by another daemon, from that daemon's
 * latest heartbeat; installed by the hub, because only it holds the links.
 * Without this a follower instance's CPU and memory columns are permanently
 * blank: this daemon never walks /proc for a process on another machine.
 */
let remoteSample: (daemon: string, instance: string) => RemoteSample | undefined = () => undefined;

/** Install the hub's per-instance process-metrics lookup (primary only). */
export function setRemoteSampleProvider(
	provider: (daemon: string, instance: string) => RemoteSample | undefined,
): void {
	remoteSample = provider;
}

/** Latest LunaCore telemetry per backend, empty when the plugin is unreachable */
let lunaCards = new Map<string, BackendCard>();
let lunaIssue: string | undefined;
let sampler: ReturnType<typeof setInterval> | undefined;

/** Whether a pass has finished, so this module's per-instance figures mean something. */
let sampled = false;

/** Per-instance sampler state, created on first use. */
function rt(name: string): InstanceRuntime {
	if (!runtime.has(name)) {
		runtime.set(name, { history: [] });
	}

	return runtime.get(name)!;
}

/**
 * Cumulative CPU ticks and resident size of a process, from /proc. CPU is only
 * meaningful as a delta between two samples, so the raw total is what we keep.
 */
async function readCpuMem(pid: number): Promise<{ total: number; rssMb: number } | undefined> {
	try {
		// the comm field can contain spaces and parens; everything after the last
		// ')' is the fixed-layout part, where utime/stime are fields 12 and 13
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		const parts = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const utime = parseInt(parts[11]!);
		const stime = parseInt(parts[12]!);

		const status = await readFile(`/proc/${pid}/status`, "utf8");
		const rss = parseInt(status.match(/VmRSS:\s+(\d+)/)?.[1] ?? "0");

		return { total: utime + stime, rssMb: Math.round(rss / 1024) };
	} catch {
		return undefined;
	}
}

/** Drop a transient state once the real state has caught up with it, or it aged out. */
function settleTransition(name: string, coreState: CoreStatus["state"]): void {
	const transition = transitions.get(name);

	if (!transition) {
		return;
	}

	if (coreState !== "running") {
		transition.sawDown = true;
	}

	// an instance that crashed into its own relaunch has gone down, whether or not
	// anybody asked it to; a requested stop is settled by that just as well
	const stopped =
		transition.state === "stopping" && (coreState === "stopped" || coreState === "auto-restarting");

	// a restart is marked while the server is still up, so "running" only means
	// it is over once the process has been seen down in between
	const restarted = transition.state === "restarting" && coreState === "running" && transition.sawDown;
	const staleFor = Date.now() - transition.since;

	if (stopped || restarted || staleFor > TRANSITION_TIMEOUT_MS) {
		transitions.delete(name);
	}
}

/**
 * LunaCore's view of every backend, keyed by name. Returns an empty map whenever
 * the plugin or the proxy is unavailable; the sampler's own /proc and ping data is
 * the baseline, and Luna telemetry only enriches it.
 */
async function fetchLunaBackends(): Promise<Map<string, BackendCard>> {
	const result = await luna.dashboard();

	if (!result.ok || !result.data) {
		lunaIssue = result.error;

		return new Map();
	}

	lunaIssue = undefined;

	return new Map(result.data.backends.map((backend) => [backend.id, backend]));
}

/** Adopt a freshly fetched set of cards as the current telemetry. */
function installCards(cards: Map<string, BackendCard>): void {
	lunaCards = cards;
}

/** Why Luna telemetry is missing, for the UI to surface. */
export function lunaProblem(): string | undefined {
	return lunaIssue;
}

/** LunaCore's cards for a set of instances, for the hub to push to their owner. */
export function lunaCardsFor(names: string[]): BackendCard[] {
	const cards: BackendCard[] = [];

	for (const name of names) {
		const card = lunaCards.get(name);

		if (card) {
			cards.push(card);
		}
	}

	return cards;
}

/**
 * Install LunaCore telemetry pushed down by the primary (follower side).
 *
 * Only the primary can ask LunaCore anything; the plugin runs on the proxy, on
 * the primary's host, and answers on a secret this machine has no copy of. A
 * follower left to `fetchLunaBackends` therefore samples TPS and heap as
 * permanently absent, which is exactly the two series its instances' monitoring
 * charts are drawn from. The primary sends them on the heartbeat ping instead,
 * which already runs at the sampling cadence.
 */
export function setLunaTelemetry(cards: BackendCard[], issue?: string): void {
	lunaCards = new Map(cards.map((card) => [card.id, card]));
	lunaIssue = issue;
}

/** Record one metrics sample per instance and emit state-change events. */
async function sampleOnce(): Promise<void> {
	try {
		const cfg = await loadCluster();

		// only this daemon's own instances are probed; a follower's screens live
		// on the follower, and its own sampler keeps their history
		const insts = managedInstances(cfg);
		const ownedNames = Object.keys(insts).filter((name) => ownsInstance(insts[name]!));

		const [statuses] = await Promise.all([
			Promise.all(ownedNames.map((name) => instances.getStatus(cfg, name))),
			// a follower has no proxy to ask; its cards arrive on the ping instead,
			// and must be read *after* this await rather than snapshotted before
			// it; a ping landing mid-sample would otherwise have its telemetry
			// written straight back out, permanently once the two 5 s timers phase-lock
			isPrimary() ? fetchLunaBackends().then(installCards) : Promise.resolve(),
		]);

		const backends = lunaCards;

		for (const status of statuses) {
			const rec = rt(status.name);

			lastStatuses.set(status.name, status);

			const uiState = effectiveState(status.name, status.state);

			if (rec.lastState && rec.lastState !== uiState) {
				pushEvent(status.name, "state", `${rec.lastState} → ${uiState}`);
			}

			rec.lastState = uiState;

			const sample: MetricSample = { t: Date.now() };

			// the read that establishes a process's tick baseline has nothing to
			// diff against, so the sample it would produce carries no CPU figure
			let priming = false;

			if (status.javaPid) {
				const usage = await readCpuMem(status.javaPid);

				if (usage) {
					priming = rec.prevCpu === undefined;

					if (rec.prevCpu) {
						const ticks = usage.total - rec.prevCpu.total;
						const elapsed = sample.t - rec.prevCpu.at;

						// the kernel counts 100 ticks per second per core
						if (elapsed > 0 && ticks >= 0) {
							sample.cpu = Math.round(((ticks * 10) / elapsed) * 1000) / 10;
						}
					}

					rec.prevCpu = { total: usage.total, at: sample.t };
					sample.rssMb = usage.rssMb;
				}
			} else {
				rec.prevCpu = undefined;
			}

			if (status.players) {
				sample.players = status.players.online;
			}

			// Heartbeat metrics come from inside the JVM, so they say things /proc cannot:
			// tick rate, and heap as the server itself sees it.
			const backend = backends.get(status.name);

			if (backend?.online) {
				sample.tps = backend.metrics.tps;
				sample.heapUsedMb = Math.round(backend.metrics.ramUsedBytes / 1024 / 1024);
				sample.heapMaxMb = Math.round(backend.metrics.ramMaxBytes / 1024 / 1024);

				sample.players ??= backend.metrics.onlinePlayers;
			}

			// Publishing a priming pass opens the series with a hazard band, which
			// reads as lost data rather than as a run that had not started yet;
			// the same band reappears mid-chart after every restart, since a
			// stopped process drops its baseline. One interval later the sample
			// is complete, so the honest move is to wait for it.
			if (priming) {
				continue;
			}

			rec.history.push(sample);

			if (rec.history.length > MAX_SAMPLES) {
				rec.history.splice(0, rec.history.length - MAX_SAMPLES);
			}

			// A server that cannot measure itself gets this cycle's figures left
			// in its own directory; for everything else this returns at once.
			await instances.writeHostMetrics(cfg, status.name, {
				systemCpuPercent: currentHealth()?.cpuPct,
				cpuPercentOfOneCore: sample.cpu,
				rssMb: sample.rssMb,
			});
		}
	} catch (err) {
		// a fresh follower has no cluster.json until its first sync lands
		if ((err as { code?: string }).code === "ENOENT") {
			return;
		}

		console.error("[sampler]", err);
	} finally {
		// whatever a pass found, it has now looked; the health sampler waits on
		// this before it will publish a machine's total instance memory. A pass
		// that found nothing is still an answer (a follower with no cluster.json
		// owns no instances), so this is not gated on the pass succeeding.
		sampled = true;
	}
}

/**
 * Whether the sampler has completed a pass. Until it has, every per-instance
 * figure this module reports is absent rather than zero.
 */
export function samplerReady(): boolean {
	return sampled;
}

/** Start the metrics sampler once per daemon process. */
export function ensureSampler(): void {
	if (sampler) {
		return;
	}

	sampler = setInterval(() => void sampleOnce(), SAMPLE_INTERVAL_MS);
	void sampleOnce();
}

/**
 * Core state widened with the UI-only transient states, so a stop or restart the
 * console requested reads as in-progress until the process actually settles.
 */
export function effectiveState(name: string, coreState: CoreStatus["state"]): UiState {
	// settle here, not only in the sampler: the sampler walks this daemon's *own*
	// instances, so a transition marked for a follower-owned one would otherwise
	// never meet a fresh core state and would pin the row to "stopping" forever
	settleTransition(name, coreState);

	const transition = transitions.get(name);

	// a stop landing mid-wait has already told the wrapper not to relaunch, so the
	// row reads as stopping rather than as a relaunch that is no longer coming
	if (transition?.state === "stopping") {
		return coreState === "stopped" ? "stopped" : "stopping";
	}

	if (transition?.state === "restarting") {
		return coreState === "running" ? "running" : "restarting";
	}

	return coreState;
}

/** Metrics history for one instance, oldest first. */
export function getHistory(name: string): MetricSample[] {
	return rt(name).history;
}

/**
 * Latest resident size of every instance this daemon has sampled, in MB. The
 * health sampler reads it from here rather than walking /proc a second time.
 */
export function instanceRssMb(): Record<string, number> {
	const out: Record<string, number> = {};

	for (const [name, rec] of runtime) {
		const rssMb = rec.history.at(-1)?.rssMb;

		if (rssMb !== undefined) {
			out[name] = rssMb;
		}
	}

	return out;
}

/**
 * Latest CPU utilization of every instance this daemon has sampled, percent of
 * one core. Rides the heartbeat for the same reason the resident sizes do: the
 * primary cannot read /proc on another machine, and the instances table has a
 * CPU column for every row regardless of where it runs.
 */
export function instanceCpuPct(): Record<string, number> {
	const out: Record<string, number> = {};

	for (const [name, rec] of runtime) {
		const cpu = rec.history.at(-1)?.cpu;

		if (cpu !== undefined) {
			out[name] = cpu;
		}
	}

	return out;
}

/** Latest UI state of every instance this daemon owns. */
export function instanceStates(): Record<string, UiState> {
	const out: Record<string, UiState> = {};

	for (const [name, status] of lastStatuses) {
		out[name] = effectiveState(name, status.state);
	}

	return out;
}

/** Mark an instance as mid-transition, so the UI can show it before core catches up. */
export function markTransition(name: string, state: "stopping" | "restarting"): void {
	transitions.set(name, { state, since: Date.now(), sawDown: false });
}

/** Drop an instance's transient state immediately. */
export function clearTransition(name: string): void {
	transitions.delete(name);
}

export interface StatusCheck {
	name: string;
	ok: boolean | undefined; // undefined = not applicable (stopped)
	detail: string;
}

/** Coarse "N seconds/minutes ago" for a heartbeat timestamp. */
function agoText(epochMs: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - epochMs) / 1000));

	if (seconds < 60) {
		return `${seconds}s ago`;
	}

	return `${Math.floor(seconds / 60)}m ${seconds % 60}s ago`;
}

/**
 * Whether LunaCore is reporting for this instance.
 *
 * This is the check the other three cannot make: a backend can hold its screen
 * session, own its port and answer server-list pings while LunaCore has stopped
 * publishing; a broken plugin config, a dead heartbeat thread, a wrong forwarding
 * secret. In all of those the server looks healthy from the outside and is invisible
 * to the network.
 *
 * The proxy is the heartbeat *receiver*, so it is judged on serving the API instead.
 */
function heartbeatCheck(st: CoreStatus): StatusCheck {
	const name = "LunaCore heartbeat";

	if (lunaIssue) {
		return { name, ok: undefined, detail: lunaIssue };
	}

	if (st.name === "proxy") {
		const reporting = [...lunaCards.values()].filter((backend) => backend.online).length;

		return {
			name: "LunaCore API",
			ok: true,
			detail: t("daemon.sampler.servingTelemetry", { count: reporting }),
		};
	}

	const backend = lunaCards.get(st.name);

	if (!backend) {
		return { name, ok: undefined, detail: "not registered with LunaCore on the proxy" };
	}

	if (!backend.online) {
		// A booting server has not loaded its plugins yet, so a missing heartbeat is
		// expected rather than a fault; only a server that is up and quiet is failing.
		if (st.state !== "running") {
			return { name, ok: undefined, detail: "waiting for the first heartbeat" };
		}

		return {
			name,
			ok: false,
			detail: backend.lastHeartbeatEpochMillis
				? t("daemon.sampler.noHeartbeatSince", { ago: agoText(backend.lastHeartbeatEpochMillis) })
				: t("daemon.sampler.neverReported"),
		};
	}

	const heapMb = Math.round(backend.metrics.ramUsedBytes / 1024 / 1024);
	const heapMaxMb = Math.round(backend.metrics.ramMaxBytes / 1024 / 1024);

	return {
		name,
		ok: true,
		detail:
			`${backend.metrics.tps.toFixed(2)} TPS · heap ${heapMb}/${heapMaxMb} MB · ` +
			`beat ${agoText(backend.lastHeartbeatEpochMillis)} (${backend.metrics.heartbeatLatencyMillis}ms)`,
	};
}

/** The four health checks the instance detail page renders. */
export function statusChecks(st: CoreStatus): StatusCheck[] {
	if (st.state === "unknown") {
		const owner = st.inst.daemon ?? "?";

		return [
			{
				name: "Daemon link",
				ok: false,
				detail: `owner daemon "${owner}" is not connected`,
			},
		];
	}

	if (st.state === "stopped") {
		return [
			{ name: "Process check", ok: undefined, detail: "Instance is stopped" },
			{ name: "Port reachability", ok: undefined, detail: "Instance is stopped" },
			{ name: "Server ping", ok: undefined, detail: "Instance is stopped" },
			{ name: "LunaCore heartbeat", ok: undefined, detail: "Instance is stopped" },
		];
	}

	return [
		{
			name: "Process check",
			ok: st.javaPid !== undefined,
			// worded for the software rather than for java: a native server has no
			// JVM, and "no java process" would read as a fault on a healthy one
			detail: st.javaPid
				? `${instances.serverProcessName(st.inst)} process ${st.javaPid} inside screen session`
				: `screen session present but no ${instances.serverProcessName(st.inst)} process`,
		},
		{
			name: "Port reachability",
			ok: st.players !== undefined || st.state === "running",
			detail: `TCP 127.0.0.1:${st.inst.port}`,
		},
		{
			name: "Server ping",
			ok: st.players !== undefined,
			detail: st.players
				? t("daemon.sampler.responding", { online: st.players.online, max: st.players.max })
				: "not answering server-list pings yet",
		},
		heartbeatCheck(st),
	];
}

/** Serialize an instance status for the API. */
export function statusJson(cfg: ClusterConfig, st: CoreStatus): Record<string, unknown> {
	const latest = rt(st.name).history.at(-1);
	const backend = lunaCards.get(st.name);

	// an instance on another machine has no local /proc sample; its owner's
	// heartbeat is where its CPU and resident size come from
	const own = ownsInstance(st.inst);
	const remote = own ? undefined : remoteSample(st.inst.daemon ?? "", st.name);

	const cpu = own ? (latest?.cpu ?? null) : (remote?.cpu ?? null);
	const rssMb = own ? (latest?.rssMb ?? null) : (remote?.rssMb ?? null);

	return {
		tps: backend?.online ? backend.metrics.tps : null,
		heapUsedMb: backend?.online ? Math.round(backend.metrics.ramUsedBytes / 1024 / 1024) : null,
		heapMaxMb: backend?.online ? Math.round(backend.metrics.ramMaxBytes / 1024 / 1024) : null,
		lunaStatus: backend?.status ?? null,
		lunaDisplayName: backend?.displayName ?? null,
		lastHeartbeatMs: backend?.lastHeartbeatEpochMillis ?? null,
		name: st.name,
		state: effectiveState(st.name, st.state),
		software: st.inst.software,
		mcVersion: st.inst.mcVersion ?? null,
		port: st.inst.port,
		// where this instance actually answers: loopback on the primary's own
		// machine, the owning follower's LAN host otherwise; never a bare
		// 127.0.0.1 the console then shows for another machine's server
		address: instanceAddress(cfg, st.inst),
		memory: st.inst.memory,
		profile: st.inst.profile,
		javaPid: st.javaPid ?? null,
		uptimeMs: st.uptimeMs ?? null,
		players: st.players ?? null,
		pingVersion: st.pingVersion ?? null,
		cpu,
		rssMb,
		ports: st.inst.ports ?? {},
		proxy: st.inst.proxy ?? null,
		external: st.inst.external ?? null,
		daemon: st.inst.daemon ?? null,
		dir: instanceDir(st.inst),
		checks: statusChecks(st),
	};
}

let hostMemMb = 0;

/** Total physical memory of the host, in MB (read once from /proc/meminfo). */
export async function readHostMemMb(): Promise<number> {
	if (hostMemMb) {
		return hostMemMb;
	}

	try {
		const text = await Bun.file("/proc/meminfo").text();
		const kb = Number(/MemTotal:\s+(\d+) kB/.exec(text)?.[1] ?? 0);

		hostMemMb = Math.round(kb / 1024);
	} catch {
		hostMemMb = 0;
	}

	return hostMemMb;
}

/**
 * Serialized status of one instance, sampler-enriched. The probe is routed to
 * the instance's owner; the serialization runs here, on the daemon that holds
 * the proxy's LunaCore telemetry.
 */
export async function instanceStatus(name: string): Promise<Record<string, unknown>> {
	const cfg = await loadCluster();
	const status = await getStatusRouted(cfg, name);

	return statusJson(cfg, status);
}

/** Everything the instances table needs: managed statuses, externals, host memory. */
export async function listStatuses(): Promise<Record<string, unknown>> {
	const cfg = await loadCluster();

	// ownership-aware: follower-owned instances are probed on their own daemon
	const statuses = await getAllStatusesRouted(cfg);

	// External servers run on another machine, so luna can only TCP-probe them -
	// LunaCore's heartbeat is the only real telemetry the console has for these.
	const externals = Object.entries(cfg.instances)
		.filter(([, inst]) => inst.external)
		.map(([name, inst]) => {
			const backend = lunaCards.get(name);

			return {
				name,
				external: inst.external!,
				proxy: inst.proxy ?? null,
				lunaStatus: backend?.status ?? null,
				online: backend?.online ?? null,
				players: backend?.online
					? { online: backend.metrics.onlinePlayers, max: backend.metrics.maxPlayers }
					: null,
				tps: backend?.online ? backend.metrics.tps : null,
				heapUsedMb: backend?.online
					? Math.round(backend.metrics.ramUsedBytes / 1024 / 1024)
					: null,
				heapMaxMb: backend?.online
					? Math.round(backend.metrics.ramMaxBytes / 1024 / 1024)
					: null,
				uptimeMs: backend?.online ? backend.metrics.uptimeMillis : null,
			};
		});

	// the proxy always heads the list, backends follow alphabetically
	const ordered = statuses
		.map((st) => statusJson(cfg, st))
		.sort((a, b) => {
			if (a.name === "proxy") {
				return -1;
			}

			if (b.name === "proxy") {
				return 1;
			}

			return String(a.name).localeCompare(String(b.name));
		});

	return {
		instances: ordered,
		externals,
		hostMemMb: await readHostMemMb(),
		lunaProblem: lunaIssue ?? null,
	};
}
