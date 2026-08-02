/**
 * Per-daemon host health: CPU, memory, disk, load average, the network
 * addresses this machine can be reached on, and the resident size of every
 * instance this daemon owns — sampled on a timer and kept as a rolling history.
 *
 * Both roles run it. The primary samples its own machine; a follower samples
 * its own and its samples ride the heartbeat pong up to the primary, so the
 * console charts the whole fleet from one place (DESIGN.md §4.4).
 */

import { readFile } from "node:fs/promises";
import { loadavg, networkInterfaces, uptime } from "node:os";

import { diskUsage } from "../core/cleanup";
import { root } from "../core/config";

import { instanceRssMb, instanceStates } from "./sampler";

export interface HealthSample {
	t: number;
	/** Whole-host CPU utilization since the previous sample, percent */
	cpuPct: number;
	memUsedMb: number;
	memTotalMb: number;
	/** Usage of the filesystem holding the cluster root */
	diskUsedBytes: number;
	diskTotalBytes: number;
	load1: number;
	load5: number;
	load15: number;
	/** Host uptime, seconds */
	uptimeSec: number;
	/** Resident size of each instance this daemon owns, MB */
	instanceRssMb: Record<string, number>;
	/** Their total, MB */
	instancesRssMb: number;
	/** Instance name → UI state, so the fleet view needs no extra round trip */
	states: Record<string, string>;
	/** Round-trip to the primary, ms — stamped by the primary when the pong lands */
	latencyMs?: number;
}

/** One hour of history at the sampling interval below. */
const MAX_SAMPLES = 720;
export const SAMPLE_INTERVAL_MS = 5_000;

/** `df` is a process spawn, and a filesystem does not fill up in five seconds. */
const DISK_INTERVAL_MS = 60_000;

const history: HealthSample[] = [];

let sampler: ReturnType<typeof setInterval> | undefined;
let prevCpu: { idle: number; total: number } | undefined;
let disk: { usedBytes: number; totalBytes: number; at: number } | undefined;

/**
 * Whole-host CPU utilization between this call and the previous one. The first
 * call has no baseline to subtract, so it reports zero.
 */
async function readCpuPct(): Promise<number> {
	try {
		const text = await readFile("/proc/stat", "utf8");
		const line = text.slice(0, text.indexOf("\n"));

		// cpu user nice system idle iowait irq softirq steal guest guest_nice
		const fields = line.trim().split(/\s+/).slice(1).map(Number);
		const total = fields.reduce((sum, value) => sum + value, 0);
		const idle = (fields[3] ?? 0) + (fields[4] ?? 0);

		const prev = prevCpu;

		prevCpu = { idle, total };

		if (!prev) {
			return 0;
		}

		const deltaTotal = total - prev.total;
		const deltaIdle = idle - prev.idle;

		if (deltaTotal <= 0) {
			return 0;
		}

		return Math.round((1 - deltaIdle / deltaTotal) * 1000) / 10;
	} catch {
		return 0;
	}
}

/**
 * Host memory. MemAvailable rather than MemFree: the kernel counts the page
 * cache as used, so free alone reads permanently near-full on a file server.
 */
async function readMem(): Promise<{ usedMb: number; totalMb: number }> {
	try {
		const text = await readFile("/proc/meminfo", "utf8");
		const totalKb = Number(/MemTotal:\s+(\d+)/.exec(text)?.[1] ?? 0);
		const availableKb = Number(/MemAvailable:\s+(\d+)/.exec(text)?.[1] ?? 0);

		return {
			usedMb: Math.round((totalKb - availableKb) / 1024),
			totalMb: Math.round(totalKb / 1024),
		};
	} catch {
		return { usedMb: 0, totalMb: 0 };
	}
}

/** Cluster-root filesystem usage, refreshed at most once a minute. */
async function readDisk(): Promise<{ usedBytes: number; totalBytes: number }> {
	if (disk && Date.now() - disk.at < DISK_INTERVAL_MS) {
		return disk;
	}

	const usage = await diskUsage(root());

	disk = {
		usedBytes: usage?.usedBytes ?? 0,
		totalBytes: usage?.totalBytes ?? 0,
		at: Date.now(),
	};

	return disk;
}

/**
 * Every non-loopback IPv4 address of this host, in interface order. This is
 * what the daemon advertises to the primary: the address its instances are
 * reachable on, and what the console shows for the machine.
 */
export function hostAddresses(): string[] {
	const out: string[] = [];

	for (const list of Object.values(networkInterfaces())) {
		for (const iface of list ?? []) {
			if (iface.internal || iface.family !== "IPv4") {
				continue;
			}

			out.push(iface.address);
		}
	}

	return out;
}

/** Take one health sample and append it to the history. */
async function sampleOnce(): Promise<void> {
	const [cpuPct, mem, usage] = await Promise.all([readCpuPct(), readMem(), readDisk()]);
	const load = loadavg();
	const rss = instanceRssMb();

	const sample: HealthSample = {
		t: Date.now(),
		cpuPct,
		memUsedMb: mem.usedMb,
		memTotalMb: mem.totalMb,
		diskUsedBytes: usage.usedBytes,
		diskTotalBytes: usage.totalBytes,
		load1: load[0] ?? 0,
		load5: load[1] ?? 0,
		load15: load[2] ?? 0,
		uptimeSec: Math.round(uptime()),
		instanceRssMb: rss,
		instancesRssMb: Object.values(rss).reduce((sum, value) => sum + value, 0),
		states: instanceStates(),
	};

	history.push(sample);

	if (history.length > MAX_SAMPLES) {
		history.splice(0, history.length - MAX_SAMPLES);
	}
}

/** Start the host health sampler once per daemon process. */
export function ensureHealthSampler(): void {
	if (sampler) {
		return;
	}

	sampler = setInterval(() => void sampleOnce(), SAMPLE_INTERVAL_MS);
	void sampleOnce();
}

/** The most recent health sample, or undefined before the first one lands. */
export function currentHealth(): HealthSample | undefined {
	return history.at(-1);
}

/** This daemon's health history, oldest first. */
export function healthHistory(): HealthSample[] {
	return history;
}
