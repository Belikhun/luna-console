// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Per-thread CPU of one instance's process, read from
 * `/proc/<pid>/task/<tid>/{stat,schedstat,status}`.
 *
 * This is the breakdown the whole-process figure cannot give. An instance's CPU
 * is percent of one core and a Paper server routinely runs several cores' worth,
 * but the total says nothing about *what* is spending it: a 400% reading is a
 * healthy server with two map renderers beside it just as easily as it is a
 * pathological tick loop, and only the per-thread split tells those apart.
 *
 * Why not per-core: the kernel does not attribute a task's time per CPU
 * anywhere readable. `/proc/<pid>/stat` field 39 is the core a thread happened
 * to sit on when it was read, and with hundreds of unpinned threads migrating
 * freely that is a coin toss, not a measurement; cgroup v1's
 * `cpuacct.usage_percpu` was the one real source and unified v2 dropped it.
 * Threads are the axis the data actually supports.
 *
 * Sampled on demand rather than on the timer: a report costs a few hundred
 * small reads per snapshot and nobody is watching most of the time. It runs on
 * the machine that owns the instance, because a process on a follower has no
 * `/proc` entry here.
 */

import { readdir } from "node:fs/promises";
import { cpus } from "node:os";

import { loadCluster } from "../core/config";
import { getStatus } from "../core/instances";

import { hostCpuCores } from "./sampler";

/** Jiffies per second in `/proc`; `USER_HZ` is 100 on every platform luna runs on. */
const USER_HZ = 100;

/** Long enough for a tick to land inside the window, short enough to stay a request. */
export const DEFAULT_WINDOW_MS = 1_000;

/** Below this a thread is reported as idle rather than as a fraction of a jiffy. */
const IDLE_CPU_PCT = 0.05;

export interface ThreadSample {
	tid: number;
	/**
	 * The thread's name as the kernel holds it. `TASK_COMM_LEN` is 16, so this is
	 * capped at 15 characters and a JVM's longer names arrive truncated
	 * ("BlueMap-RenderT"); the full name only exists inside the JVM.
	 */
	name: string;
	/** Percent of one core over the window, and its user/system split */
	cpu: number;
	userCpu: number;
	systemCpu: number;
	/** Raw `/proc` state letter: R, S, D, Z, T, t, I */
	state: string;
	/** The core it last ran on, or null when it was not on one at the time */
	lastCore: number | null;
	priority: number;
	nice: number;
	/** Context switches during the window; a high involuntary count is contention */
	voluntaryCtx: number | null;
	involuntaryCtx: number | null;
	/** Nanoseconds on-CPU and nanoseconds waiting for a core, during the window */
	runNs: number | null;
	waitNs: number | null;
	/** Page faults during the window */
	minorFaults: number;
	majorFaults: number;
	/** How long the thread has existed, ms */
	lifetimeMs: number;
}

export interface ThreadReport {
	pid: number;
	/** When the second snapshot was taken */
	sampledAt: number;
	/** Measured window, which is the requested one plus scheduling slop */
	windowMs: number;
	/** Cores of this machine, so a reader can scale the total */
	cores: number;
	/** Threads alive at the end of the window */
	threadCount: number;
	/** Sum of every thread's CPU, percent of one core */
	totalCpu: number;
	threads: ThreadSample[];
}

interface Snapshot {
	name: string;
	ticks: number;
	userTicks: number;
	systemTicks: number;
	state: string;
	lastCore: number | null;
	priority: number;
	nice: number;
	startTicks: number;
	minorFaults: number;
	majorFaults: number;
	runNs: number | null;
	waitNs: number | null;
	voluntaryCtx: number | null;
	involuntaryCtx: number | null;
}

async function readText(path: string): Promise<string | null> {
	try {
		return await Bun.file(path).text();
	} catch {
		// a thread that exited between the directory listing and the read
		return null;
	}
}

/**
 * Parse one `/proc/<pid>/task/<tid>/stat` line.
 *
 * The comm field is parenthesised and may itself contain spaces and parens, so
 * the fields after it are found from the *last* closing paren rather than by
 * splitting the whole line. Indices below are into that tail, where `[0]` is
 * field 3 (state).
 */
function parseStat(line: string): Omit<Snapshot, "runNs" | "waitNs" | "voluntaryCtx" | "involuntaryCtx"> | null {
	const open = line.indexOf("(");
	const close = line.lastIndexOf(")");

	if (open < 0 || close < open) {
		return null;
	}

	const name = line.slice(open + 1, close);
	const tail = line.slice(close + 2).trim().split(/\s+/);
	const num = (index: number): number => Number(tail[index] ?? 0);

	const userTicks = num(11);
	const systemTicks = num(12);
	const lastCore = num(36);

	return {
		name,
		ticks: userTicks + systemTicks,
		userTicks,
		systemTicks,
		state: tail[0] ?? "?",
		// -1 shows up for a thread that is not on a CPU at all; that is an absence
		// of a reading rather than core minus one
		lastCore: lastCore >= 0 ? lastCore : null,
		priority: num(15),
		nice: num(16),
		startTicks: num(19),
		minorFaults: num(7),
		majorFaults: num(9),
	};
}

/** `runtime waittime timeslices`, all cumulative, the first two in nanoseconds. */
function parseSchedstat(text: string | null): { runNs: number | null; waitNs: number | null } {
	if (!text) {
		return { runNs: null, waitNs: null };
	}

	const fields = text.trim().split(/\s+/);
	const runNs = Number(fields[0]);
	const waitNs = Number(fields[1]);

	return {
		runNs: Number.isFinite(runNs) ? runNs : null,
		waitNs: Number.isFinite(waitNs) ? waitNs : null,
	};
}

function parseCtxSwitches(text: string | null): {
	voluntaryCtx: number | null;
	involuntaryCtx: number | null;
} {
	if (!text) {
		return { voluntaryCtx: null, involuntaryCtx: null };
	}

	const voluntary = /voluntary_ctxt_switches:\s+(\d+)/.exec(text);
	const involuntary = /nonvoluntary_ctxt_switches:\s+(\d+)/.exec(text);

	return {
		voluntaryCtx: voluntary ? Number(voluntary[1]) : null,
		involuntaryCtx: involuntary ? Number(involuntary[1]) : null,
	};
}

/** Every thread of a process, keyed by tid. */
async function snapshot(pid: number): Promise<Map<number, Snapshot>> {
	const out = new Map<number, Snapshot>();
	let tids: string[];

	try {
		tids = await readdir(`/proc/${pid}/task`);
	} catch {
		return out;
	}

	for (const tid of tids) {
		const base = `/proc/${pid}/task/${tid}`;
		const statText = await readText(`${base}/stat`);

		if (!statText) {
			continue;
		}

		const stat = parseStat(statText);

		if (!stat) {
			continue;
		}

		const sched = parseSchedstat(await readText(`${base}/schedstat`));
		const ctx = parseCtxSwitches(await readText(`${base}/status`));

		out.set(Number(tid), { ...stat, ...sched, ...ctx });
	}

	return out;
}

/** System boot time in epoch ms, so a thread's start tick becomes a real date. */
async function bootTimeMs(): Promise<number> {
	const text = await readText("/proc/uptime");
	const seconds = Number(text?.trim().split(/\s+/)[0] ?? 0);

	return Date.now() - seconds * 1000;
}

/**
 * Difference of two cumulative counters, floored at zero.
 *
 * A counter that went backwards means the tid was reused by a new thread
 * between the snapshots, and reporting the negative jump as work would show up
 * as a wildly busy thread that never existed.
 */
function delta(after: number | null, before: number | null): number | null {
	if (after === null || before === null) {
		return null;
	}

	return Math.max(0, after - before);
}

/**
 * Sample every thread of a process over a window.
 *
 * @param pid the process to walk; nothing is reported when it has no `/proc` entry
 * @param windowMs how long to measure over, before scheduling slop
 * @returns the report, or null when the process is gone
 */
export async function sampleThreads(
	pid: number,
	windowMs: number = DEFAULT_WINDOW_MS,
): Promise<ThreadReport | null> {
	const before = await snapshot(pid);

	if (before.size === 0) {
		return null;
	}

	const startedAt = Date.now();

	await Bun.sleep(windowMs);

	const after = await snapshot(pid);

	if (after.size === 0) {
		return null;
	}

	// the real elapsed time, not the requested one: the sleep and two /proc walks
	// overshoot, and dividing by the request would inflate every percentage
	const elapsed = Math.max(1, Date.now() - startedAt);
	const boot = await bootTimeMs();
	const sampledAt = Date.now();

	const threads: ThreadSample[] = [];
	let totalCpu = 0;

	for (const [tid, now] of after) {
		const prev = before.get(tid);

		if (!prev) {
			// born inside the window, so it has no baseline to subtract yet
			continue;
		}

		const pct = (ticks: number): number =>
			Math.round((((ticks * 1000) / USER_HZ) / elapsed) * 1000) / 10;

		const cpu = pct(Math.max(0, now.ticks - prev.ticks));
		const startedMs = boot + (now.startTicks / USER_HZ) * 1000;

		totalCpu += cpu;

		threads.push({
			tid,
			name: now.name,
			cpu,
			userCpu: pct(Math.max(0, now.userTicks - prev.userTicks)),
			systemCpu: pct(Math.max(0, now.systemTicks - prev.systemTicks)),
			state: now.state,
			lastCore: now.lastCore,
			priority: now.priority,
			nice: now.nice,
			voluntaryCtx: delta(now.voluntaryCtx, prev.voluntaryCtx),
			involuntaryCtx: delta(now.involuntaryCtx, prev.involuntaryCtx),
			runNs: delta(now.runNs, prev.runNs),
			waitNs: delta(now.waitNs, prev.waitNs),
			minorFaults: Math.max(0, now.minorFaults - prev.minorFaults),
			majorFaults: Math.max(0, now.majorFaults - prev.majorFaults),
			lifetimeMs: Math.max(0, sampledAt - startedMs),
		});
	}

	// busiest first: the whole point of the panel is what is spending the CPU, and
	// a thread below the idle floor is ordered by name so the grid stops churning
	threads.sort((a, b) => {
		if (a.cpu >= IDLE_CPU_PCT || b.cpu >= IDLE_CPU_PCT) {
			return b.cpu - a.cpu;
		}

		return a.name.localeCompare(b.name) || a.tid - b.tid;
	});

	return {
		pid,
		sampledAt,
		windowMs: elapsed,
		cores: hostCpuCores() || cpus().length,
		threadCount: threads.length,
		totalCpu: Math.round(totalCpu * 10) / 10,
		threads,
	};
}

/**
 * Thread report for a managed instance, resolved from its running java process.
 *
 * The instance name comes first so the RPC registry can route the call to the
 * daemon that owns it; a process on another machine has no `/proc` entry here.
 *
 * @param name the instance to sample
 * @param windowMs measuring window
 * @returns the report, or null when the instance is not running on this machine
 */
export async function instanceThreads(
	name: string,
	windowMs: number = DEFAULT_WINDOW_MS,
): Promise<ThreadReport | null> {
	const cfg = await loadCluster();
	const inst = cfg.instances[name];

	if (!inst || inst.external) {
		return null;
	}

	const status = await getStatus(cfg, name);

	if (!status.javaPid) {
		return null;
	}

	return await sampleThreads(status.javaPid, windowMs);
}
