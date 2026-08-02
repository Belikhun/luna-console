/**
 * The daemon's metrics sampler — ported from the web console's server bridge,
 * because the daemon is the long-lived 24/7 process now. Holds per-instance
 * metric history, the UI's transient states (starting/stopping), and the latest
 * LunaCore telemetry; everything the instances table and detail pages render.
 */

import { readFile } from "node:fs/promises";

import { instanceDir, loadCluster, managedInstances } from "../core/config";
import * as instances from "../core/instances";
import * as luna from "../core/services/luna";
import type { BackendCard } from "../core/services/luna";
import type { ClusterConfig } from "../core/types";

import { pushEvent } from "./events";
import { ownsInstance } from "./identity";
import { getAllStatusesRouted } from "./rpc";

export type UiState = "running" | "starting" | "stopping" | "stopped" | "restarting" | "unknown";

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

const runtime = new Map<string, InstanceRuntime>();
const transitions = new Map<string, { state: "stopping" | "restarting"; since: number }>();
const lastStatuses = new Map<string, CoreStatus>();

/** Latest LunaCore telemetry per backend, empty when the plugin is unreachable */
let lunaCards = new Map<string, BackendCard>();
let lunaIssue: string | undefined;
let sampler: ReturnType<typeof setInterval> | undefined;

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
		// the comm field can contain spaces and parens — everything after the last
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

	const stopped = transition.state === "stopping" && coreState === "stopped";
	const restarted = transition.state === "restarting" && coreState === "running";
	const staleFor = Date.now() - transition.since;

	if (stopped || restarted || staleFor > TRANSITION_TIMEOUT_MS) {
		transitions.delete(name);
	}
}

/**
 * LunaCore's view of every backend, keyed by name. Returns an empty map whenever
 * the plugin or the proxy is unavailable — the sampler's own /proc and ping data is
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

/** Why Luna telemetry is missing, for the UI to surface. */
export function lunaProblem(): string | undefined {
	return lunaIssue;
}

/** Record one metrics sample per instance and emit state-change events. */
async function sampleOnce(): Promise<void> {
	try {
		const cfg = await loadCluster();

		// only this daemon's own instances are probed — a follower's screens live
		// on the follower, and its own sampler keeps their history
		const insts = managedInstances(cfg);
		const ownedNames = Object.keys(insts).filter((name) => ownsInstance(insts[name]!));

		const [statuses, backends] = await Promise.all([
			Promise.all(ownedNames.map((name) => instances.getStatus(cfg, name))),
			fetchLunaBackends(),
		]);

		lunaCards = backends;

		for (const status of statuses) {
			const rec = rt(status.name);

			lastStatuses.set(status.name, status);

			const uiState = effectiveState(status.name, status.state);

			if (rec.lastState && rec.lastState !== uiState) {
				pushEvent(status.name, "state", `${rec.lastState} → ${uiState}`);
			}

			rec.lastState = uiState;
			settleTransition(status.name, status.state);

			const sample: MetricSample = { t: Date.now() };

			if (status.javaPid) {
				const usage = await readCpuMem(status.javaPid);

				if (usage) {
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

			rec.history.push(sample);

			if (rec.history.length > MAX_SAMPLES) {
				rec.history.splice(0, rec.history.length - MAX_SAMPLES);
			}
		}
	} catch (err) {
		// a fresh follower has no cluster.json until its first sync lands
		if ((err as { code?: string }).code === "ENOENT") {
			return;
		}

		console.error("[sampler]", err);
	}
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
	const transition = transitions.get(name);

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
	transitions.set(name, { state, since: Date.now() });
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
 * publishing — a broken plugin config, a dead heartbeat thread, a wrong forwarding
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
			detail: `serving telemetry — ${reporting} backend(s) reporting`,
		};
	}

	const backend = lunaCards.get(st.name);

	if (!backend) {
		return { name, ok: undefined, detail: "not registered with LunaCore on the proxy" };
	}

	if (!backend.online) {
		// A booting server has not loaded its plugins yet, so a missing heartbeat is
		// expected rather than a fault — only a server that is up and quiet is failing.
		if (st.state !== "running") {
			return { name, ok: undefined, detail: "waiting for the first heartbeat" };
		}

		return {
			name,
			ok: false,
			detail: backend.lastHeartbeatEpochMillis
				? `no heartbeat since ${agoText(backend.lastHeartbeatEpochMillis)} — the plugin has stopped reporting`
				: "never reported to the proxy — check the LunaCore config",
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
			detail: st.javaPid
				? `java process ${st.javaPid} inside screen session`
				: "screen session present but no java process",
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
				? `responding — ${st.players.online}/${st.players.max} players`
				: "not answering server-list pings yet",
		},
		heartbeatCheck(st),
	];
}

/** Serialize an instance status for the API. */
export function statusJson(cfg: ClusterConfig, st: CoreStatus): Record<string, unknown> {
	const latest = rt(st.name).history.at(-1);
	const backend = lunaCards.get(st.name);

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
		memory: st.inst.memory,
		profile: st.inst.profile,
		javaPid: st.javaPid ?? null,
		uptimeMs: st.uptimeMs ?? null,
		players: st.players ?? null,
		pingVersion: st.pingVersion ?? null,
		cpu: latest?.cpu ?? null,
		rssMb: latest?.rssMb ?? null,
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

/** Serialized status of one instance, sampler-enriched. */
export async function instanceStatus(name: string): Promise<Record<string, unknown>> {
	const cfg = await loadCluster();
	const status = await instances.getStatus(cfg, name);

	return statusJson(cfg, status);
}

/** Everything the instances table needs: managed statuses, externals, host memory. */
export async function listStatuses(): Promise<Record<string, unknown>> {
	const cfg = await loadCluster();

	// ownership-aware: follower-owned instances are probed on their own daemon
	const statuses = await getAllStatusesRouted(cfg);

	// External servers run on another machine, so mrds can only TCP-probe them —
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
