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
}

// survive vite HMR without duplicating the sampler
const g: SamplerGlobals = ((globalThis as any).__mrds ??= {
	runtime: new Map(),
	transitions: new Map(),
	events: [],
	lastStatuses: new Map()
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

/** Record one metrics sample per instance and emit state-change events. */
async function sampleOnce(): Promise<void> {
	try {
		const cfg = await loadCluster();
		const statuses = await instances.getAllStatuses(cfg);

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

			runtime.history.push(sample);

			if (runtime.history.length > MAX_SAMPLES) {
				runtime.history.splice(0, runtime.history.length - MAX_SAMPLES);
			}
		}
	} catch (err) {
		console.error('[mrds sampler]', err);
	}
}

/** Start the metrics sampler once per server process. */
export function ensureSampler(): void {
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
export function statusChecks(st: CoreStatus): StatusCheck[] {
	if (st.state === 'stopped') {
		return [
			{ name: 'Process check', ok: undefined, detail: 'Instance is stopped' },
			{ name: 'Port reachability', ok: undefined, detail: 'Instance is stopped' },
			{ name: 'Server ping', ok: undefined, detail: 'Instance is stopped' }
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
		}
	];
}

/** Serialize an instance status for the API. */
export function statusJson(cfg: ClusterConfig, st: CoreStatus) {
	const latest = rt(st.name).history.at(-1);

	return {
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

	const externals = Object.entries(cfg.instances)
		.filter(([, inst]) => inst.external)
		.map(([name, inst]) => ({ name, external: inst.external!, proxy: inst.proxy ?? null }));

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
		hostMemMb: await readHostMemMb()
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
