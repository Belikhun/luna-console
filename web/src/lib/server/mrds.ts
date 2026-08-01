/**
 * Server-side bridge between the SvelteKit console and the mrds core layer.
 * Holds the metrics sampler, transient state (starting/stopping), and event log.
 */

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import {
	loadCluster,
	loadLock,
	managedInstances,
	instanceDir,
	root,
	expandTargets
} from '$core/config';
import * as instances from '$core/instances';
import * as luna from '$core/services/luna';
import type { BackendCard } from '$core/services/luna';
import type { ClusterConfig } from '$core/types';

export { loadCluster, loadLock, managedInstances, instanceDir, root, expandTargets };

export type UiState = 'running' | 'starting' | 'stopping' | 'stopped' | 'restarting';

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

export interface ClusterEvent {
	t: number;
	instance: string;
	kind: 'state' | 'action' | 'error';
	message: string;
}

interface InstanceRuntime {
	history: MetricSample[];
	lastState?: string;
	prevCpu?: { total: number; at: number };
}

const MAX_SAMPLES = 720; // 1h at 5s
const MAX_EVENTS = 200;

/** How long a transient state may linger before the sampler gives up on it. */
const TRANSITION_TIMEOUT_MS = 180_000;

const SAMPLE_INTERVAL_MS = 5000;

interface SamplerGlobals {
	runtime: Map<string, InstanceRuntime>;
	transitions: Map<string, { state: 'stopping' | 'restarting'; since: number }>;
	events: ClusterEvent[];
	sampler?: ReturnType<typeof setInterval>;
	lastStatuses: Map<string, CoreStatus>;
	/** Latest LunaCore telemetry per backend, empty when the plugin is unreachable */
	lunaBackends: Map<string, BackendCard>;
	lunaProblem?: string;
}

// survive vite HMR without duplicating the sampler
const g: SamplerGlobals = ((globalThis as any).__mrds ??= {
	runtime: new Map(),
	transitions: new Map(),
	events: [],
	lastStatuses: new Map(),
	lunaBackends: new Map()
});

/** Per-instance sampler state, created on first use. */
function rt(name: string): InstanceRuntime {
	if (!g.runtime.has(name)) {
		g.runtime.set(name, { history: [] });
	}

	return g.runtime.get(name)!;
}

/** Append to the cluster event log, trimming it to MAX_EVENTS. */
export function pushEvent(instance: string, kind: ClusterEvent['kind'], message: string): void {
	g.events.push({ t: Date.now(), instance, kind, message });

	if (g.events.length > MAX_EVENTS) {
		g.events.splice(0, g.events.length - MAX_EVENTS);
	}
}

/** Event log, newest first, optionally filtered to one instance. */
export function getEvents(instance?: string): ClusterEvent[] {
	return g.events
		.filter((event) => !instance || event.instance === instance)
		.slice()
		.reverse();
}

/**
 * Cumulative CPU ticks and resident size of a process, from /proc. CPU is only
 * meaningful as a delta between two samples, so the raw total is what we keep.
 */
async function readCpuMem(pid: number): Promise<{ total: number; rssMb: number } | undefined> {
	try {
		// the comm field can contain spaces and parens — everything after the last
		// ')' is the fixed-layout part, where utime/stime are fields 12 and 13
		const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
		const parts = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
		const utime = parseInt(parts[11]!);
		const stime = parseInt(parts[12]!);

		const status = await readFile(`/proc/${pid}/status`, 'utf8');
		const rss = parseInt(status.match(/VmRSS:\s+(\d+)/)?.[1] ?? '0');

		return { total: utime + stime, rssMb: Math.round(rss / 1024) };
	} catch {
		return undefined;
	}
}

/** Drop a transient state once the real state has caught up with it, or it aged out. */
function settleTransition(name: string, coreState: CoreStatus['state']): void {
	const transition = g.transitions.get(name);

	if (!transition) {
		return;
	}

	const stopped = transition.state === 'stopping' && coreState === 'stopped';
	const restarted = transition.state === 'restarting' && coreState === 'running';
	const staleFor = Date.now() - transition.since;

	if (stopped || restarted || staleFor > TRANSITION_TIMEOUT_MS) {
		g.transitions.delete(name);
	}
}

/**
 * LunaCore's view of every backend, keyed by name. Returns an empty map whenever
 * the plugin or the proxy is unavailable — the sampler's own /proc and ping data is
 * the baseline, and Luna telemetry only enriches it.
 */
async function lunaBackends(): Promise<Map<string, BackendCard>> {
	const result = await luna.dashboard();

	if (!result.ok || !result.data) {
		g.lunaProblem = result.error;

		return new Map();
	}

	g.lunaProblem = undefined;

	return new Map(result.data.backends.map((backend) => [backend.id, backend]));
}

/** Why Luna telemetry is missing, for the UI to surface. */
export function lunaProblem(): string | undefined {
	return g.lunaProblem;
}

/** Record one metrics sample per instance and emit state-change events. */
async function sampleOnce(): Promise<void> {
	try {
		const cfg = await loadCluster();
		const [statuses, backends] = await Promise.all([
			instances.getAllStatuses(cfg),
			lunaBackends()
		]);

		g.lunaBackends = backends;

		for (const status of statuses) {
			const runtime = rt(status.name);

			g.lastStatuses.set(status.name, status);

			const uiState = effectiveState(status.name, status.state);

			if (runtime.lastState && runtime.lastState !== uiState) {
				pushEvent(status.name, 'state', `${runtime.lastState} → ${uiState}`);
			}

			runtime.lastState = uiState;
			settleTransition(status.name, status.state);

			const sample: MetricSample = { t: Date.now() };

			if (status.javaPid) {
				const usage = await readCpuMem(status.javaPid);

				if (usage) {
					if (runtime.prevCpu) {
						const ticks = usage.total - runtime.prevCpu.total;
						const elapsed = sample.t - runtime.prevCpu.at;

						// the kernel counts 100 ticks per second per core
						if (elapsed > 0 && ticks >= 0) {
							sample.cpu = Math.round(((ticks * 10) / elapsed) * 1000) / 10;
						}
					}

					runtime.prevCpu = { total: usage.total, at: sample.t };
					sample.rssMb = usage.rssMb;
				}
			} else {
				runtime.prevCpu = undefined;
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

			runtime.history.push(sample);

			if (runtime.history.length > MAX_SAMPLES) {
				runtime.history.splice(0, runtime.history.length - MAX_SAMPLES);
			}
		}
	} catch (err) {
		console.error('[mrds sampler]', err);
	}
}

/** Start the metrics sampler (and the schedule runner) once per server process. */
export function ensureSampler(): void {
	// the scheduler rides along so any page load arms both long-lived loops
	void import('./scheduler').then((module) => module.ensureScheduler());

	if (g.sampler) {
		return;
	}

	g.sampler = setInterval(sampleOnce, SAMPLE_INTERVAL_MS);
	void sampleOnce();
}

/**
 * Core state widened with the UI-only transient states, so a stop or restart the
 * console requested reads as in-progress until the process actually settles.
 */
export function effectiveState(name: string, coreState: CoreStatus['state']): UiState {
	const transition = g.transitions.get(name);

	if (transition?.state === 'stopping') {
		return coreState === 'stopped' ? 'stopped' : 'stopping';
	}

	if (transition?.state === 'restarting') {
		return coreState === 'running' ? 'running' : 'restarting';
	}

	return coreState;
}

/** Metrics history for one instance, oldest first. */
export function getHistory(name: string): MetricSample[] {
	return rt(name).history;
}

export interface StatusCheck {
	name: string;
	ok: boolean | undefined; // undefined = not applicable (stopped)
	detail: string;
}

/** The three health checks the instance detail page renders. */
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
	const name = 'LunaCore heartbeat';

	if (g.lunaProblem) {
		return { name, ok: undefined, detail: g.lunaProblem };
	}

	if (st.name === 'proxy') {
		const reporting = [...g.lunaBackends.values()].filter((backend) => backend.online).length;

		return {
			name: 'LunaCore API',
			ok: true,
			detail: `serving telemetry — ${reporting} backend(s) reporting`
		};
	}

	const backend = g.lunaBackends.get(st.name);

	if (!backend) {
		return { name, ok: undefined, detail: 'not registered with LunaCore on the proxy' };
	}

	if (!backend.online) {
		// A booting server has not loaded its plugins yet, so a missing heartbeat is
		// expected rather than a fault — only a server that is up and quiet is failing.
		if (st.state !== 'running') {
			return { name, ok: undefined, detail: 'waiting for the first heartbeat' };
		}

		return {
			name,
			ok: false,
			detail: backend.lastHeartbeatEpochMillis
				? `no heartbeat since ${agoText(backend.lastHeartbeatEpochMillis)} — the plugin has stopped reporting`
				: 'never reported to the proxy — check the LunaCore config'
		};
	}

	const heapMb = Math.round(backend.metrics.ramUsedBytes / 1024 / 1024);
	const heapMaxMb = Math.round(backend.metrics.ramMaxBytes / 1024 / 1024);

	return {
		name,
		ok: true,
		detail:
			`${backend.metrics.tps.toFixed(2)} TPS · heap ${heapMb}/${heapMaxMb} MB · ` +
			`beat ${agoText(backend.lastHeartbeatEpochMillis)} (${backend.metrics.heartbeatLatencyMillis}ms)`
	};
}

export function statusChecks(st: CoreStatus): StatusCheck[] {
	if (st.state === 'stopped') {
		return [
			{ name: 'Process check', ok: undefined, detail: 'Instance is stopped' },
			{ name: 'Port reachability', ok: undefined, detail: 'Instance is stopped' },
			{ name: 'Server ping', ok: undefined, detail: 'Instance is stopped' },
			{ name: 'LunaCore heartbeat', ok: undefined, detail: 'Instance is stopped' }
		];
	}

	return [
		{
			name: 'Process check',
			ok: st.javaPid !== undefined,
			detail: st.javaPid
				? `java process ${st.javaPid} inside screen session`
				: 'screen session present but no java process'
		},
		{
			name: 'Port reachability',
			ok: st.players !== undefined || st.state === 'running',
			detail: `TCP 127.0.0.1:${st.inst.port}`
		},
		{
			name: 'Server ping',
			ok: st.players !== undefined,
			detail: st.players
				? `responding — ${st.players.online}/${st.players.max} players`
				: 'not answering server-list pings yet'
		},
		heartbeatCheck(st)
	];
}

/** Serialize an instance status for the API. */
export function statusJson(cfg: ClusterConfig, st: CoreStatus) {
	const latest = rt(st.name).history.at(-1);
	const backend = g.lunaBackends.get(st.name);

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
		dir: instanceDir(st.inst),
		checks: statusChecks(st)
	};
}

let hostMemMb = 0;

/** Total physical memory of the host, in MB (read once from /proc/meminfo). */
export async function readHostMemMb(): Promise<number> {
	if (hostMemMb) {
		return hostMemMb;
	}

	try {
		const text = await Bun.file('/proc/meminfo').text();
		const kb = Number(/MemTotal:\s+(\d+) kB/.exec(text)?.[1] ?? 0);

		hostMemMb = Math.round(kb / 1024);
	} catch {
		hostMemMb = 0;
	}

	return hostMemMb;
}

/** Everything the instances table needs: managed statuses, externals, host memory. */
export async function listStatuses() {
	ensureSampler();

	const cfg = await loadCluster();
	const statuses = await instances.getAllStatuses(cfg);

	// External servers run on another machine, so mrds can only TCP-probe them —
	// LunaCore's heartbeat is the only real telemetry the console has for these.
	const externals = Object.entries(cfg.instances)
		.filter(([, inst]) => inst.external)
		.map(([name, inst]) => {
			const backend = g.lunaBackends.get(name);

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
				heapUsedMb: backend?.online ? Math.round(backend.metrics.ramUsedBytes / 1024 / 1024) : null,
				heapMaxMb: backend?.online ? Math.round(backend.metrics.ramMaxBytes / 1024 / 1024) : null,
				uptimeMs: backend?.online ? backend.metrics.uptimeMillis : null
			};
		});

	// the proxy always heads the list, backends follow alphabetically
	const ordered = statuses
		.map((st) => statusJson(cfg, st))
		.sort((a, b) => {
			if (a.name === 'proxy') {
				return -1;
			}

			if (b.name === 'proxy') {
				return 1;
			}

			return a.name.localeCompare(b.name);
		});

	return {
		instances: ordered,
		externals,
		hostMemMb: await readHostMemMb(),
		lunaProblem: g.lunaProblem ?? null
	};
}

/** Mark an instance as mid-transition, so the UI can show it before core catches up. */
export function markTransition(name: string, state: 'stopping' | 'restarting'): void {
	g.transitions.set(name, { state, since: Date.now() });
}

/** Drop an instance's transient state immediately. */
export function clearTransition(name: string): void {
	g.transitions.delete(name);
}

/** Path to the compiled CLI binary (for the terminal's exec route). */
export function cliBinary(): string {
	const bin = join(root(), 'control', 'dist', 'mrds');

	return existsSync(bin) ? bin : 'mrds';
}

export const INTERACTIVE_COMMANDS = new Set(['console']);
