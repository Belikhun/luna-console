// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The long record of what every instance measured and what happened to it.
 *
 * The daemon's sampler keeps one hour of five-second samples in memory, which
 * is right for a live chart and useless for "how was survival doing last
 * Tuesday": it dies with the daemon. This module is the record that does not.
 *
 * Metrics are kept at two resolutions, as rollups that merge exactly:
 * - one-minute buckets, appended to `minute/<UTC day>/<group>.ndjson` as each
 *   minute closes, read 48 hours back;
 * - one-hour buckets, built from the minute files as each hour closes (and at
 *   start, for any hour a stopped daemon missed), kept `METRICS_KEEP_DAYS`.
 *
 * A bucket holds `[avg, max, n]` per metric. A group is one instance, or
 * `_host` for the machine, so reading one never parses another. Each line is
 * one `appendFile` of a whole line, and a reader skips a torn last line. A
 * metric nobody measured in a bucket is absent from it, and a reader turns
 * that into a gap: a measurement nobody took is never zero.
 *
 * Events (state changes, actions and errors) are appended one line each to
 * `events/<group>.ndjson`, kept as long as the hourly metrics, so a crash a
 * month ago is still on the record beside the charts that show it.
 *
 * Deleting an instance leaves its record: the record is for auditing, and it
 * ages out with everything else. A new instance under the same name continues it.
 *
 * Everything lives under `logs/.monitoring/` of the machine whose daemon
 * measured it: per machine like the console journal, never mirrored. Instance
 * names cannot hold a dot, so the folder never collides with an instance's own
 * log archive beside it.
 */

import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { centralLogsDir } from "./config";

/** `[avg, max, n]`: a bucket's mean, its peak and how many samples it holds. */
export type Rollup = [number, number, number];

/** One group's figures at one instant, by metric. */
export type MetricValues = Record<string, number>;

/** One rollup line: a minute or an hour of one group. */
interface RollupLine {
	t: number;
	v: Record<string, Rollup>;
}

/** One event on the record. */
export interface StoredEvent {
	t: number;
	kind: "state" | "action" | "error";
	message: string;
	/** Who caused it: an account, `root`, `mcp:<token>`, `schedule` */
	actor?: string;
	/** A language key under `web.events.reason` for a cause the daemon recognised */
	reasonKey?: string;
	/** Free text: a failure's own message */
	reason?: string;
	/** Figures at the moment */
	facts?: Record<string, number | string>;
}

/** A window of a group's figures, one sample per step. */
export interface MetricsWindow {
	resolution: "minute" | "hour";
	/** Milliseconds between two samples */
	step: number;
	from: number;
	to: number;
	/** Oldest first; a metric is absent from a sample where nothing measured it */
	samples: Array<{ t: number } & MetricValues>;
}

/** The file group of the machine itself. */
export const HOST_GROUP = "_host";

/** How long hourly metrics and events are kept: long enough to audit a season. */
export const METRICS_KEEP_DAYS = 400;

/** Minute rollups are read this far back; older days' folders are removed. */
export const MINUTE_KEEP_MS = 48 * 3_600_000;

/** Metrics whose bucket reads its peak rather than its mean, since a mean hides the spike they exist to show. */
const PEAK_METRICS = new Set(["msptMax", "gcMs"]);

/** Steps a window snaps to, so buckets line up with clock boundaries. */
const NICE_STEPS = [60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000];

/** About this many samples per window when the caller names no step. */
const TARGET_POINTS = 360;

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

let minuteStart = 0;
let minuteAcc = new Map<string, Map<string, Rollup>>();
let writes: Promise<void> = Promise.resolve();

/** Where the record lives on this machine. */
export function monitoringDir(): string {
	return join(centralLogsDir(), ".monitoring");
}

function utcDay(at: number): string {
	return new Date(at).toISOString().slice(0, 10);
}

/** A group's file name; `daemon:<name>` event keys carry a colon. */
function fileOf(group: string): string {
	return `${encodeURIComponent(group)}.ndjson`;
}

function rollupPath(resolution: "minute" | "hour", at: number, group: string): string {
	return join(monitoringDir(), "metrics", resolution, utcDay(at), fileOf(group));
}

function eventsPath(group: string): string {
	return join(monitoringDir(), "events", fileOf(group));
}

/** Keep a stored number short: whole above 100, two decimals below. */
function trim(value: number): number {
	return Math.abs(value) >= 100
		? Math.round(value)
		: Math.round(value * 100) / 100;
}

function mergeRollup(target: Map<string, Rollup>, metric: string, avg: number, max: number, n: number): void {
	const existing = target.get(metric);

	if (!existing) {
		target.set(metric, [avg, max, n]);

		return;
	}

	const total = existing[2] + n;

	existing[0] = (existing[0] * existing[2] + avg * n) / total;
	existing[1] = Math.max(existing[1], max);
	existing[2] = total;
}

async function appendLine(path: string, line: unknown): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true });
	await appendFile(path, JSON.stringify(line) + "\n");
}

/** Lines of one rollup file, parsed once per change of the file. */
const fileCache = new Map<string, { size: number; mtime: number; lines: RollupLine[] }>();
const FILE_CACHE_SIZE = 64;

async function readRollupFile(path: string): Promise<RollupLine[]> {
	let info;

	try {
		info = await stat(path);
	} catch {
		return [];
	}

	const cached = fileCache.get(path);

	if (cached && cached.size === info.size && cached.mtime === info.mtimeMs) {
		fileCache.delete(path);
		fileCache.set(path, cached);

		return cached.lines;
	}

	const lines: RollupLine[] = [];

	for (const text of (await readFile(path, "utf8")).split("\n")) {
		if (!text) {
			continue;
		}

		try {
			lines.push(JSON.parse(text) as RollupLine);
		} catch {
			// a line torn by a crash mid-append is skipped
		}
	}

	fileCache.delete(path);
	fileCache.set(path, { size: info.size, mtime: info.mtimeMs, lines });

	while (fileCache.size > FILE_CACHE_SIZE) {
		fileCache.delete(fileCache.keys().next().value!);
	}

	return lines;
}

/** A group's rollup lines with `from <= t < to`. */
async function readRollups(resolution: "minute" | "hour", group: string, from: number, to: number): Promise<RollupLine[]> {
	const out: RollupLine[] = [];

	if (from >= to) {
		return out;
	}

	const firstDay = Math.floor(from / DAY) * DAY;

	for (let day = firstDay; day < to; day += DAY) {
		for (const line of await readRollupFile(rollupPath(resolution, day, group))) {
			if (line.t >= from && line.t < to) {
				out.push(line);
			}
		}
	}

	return out;
}

/** Write a closed minute, and the hour it finished, if it was the hour's last. */
async function writeMinute(at: number, acc: Map<string, Map<string, Rollup>>): Promise<void> {
	for (const [group, metrics] of acc) {
		const v = Object.fromEntries(
			[...metrics].map(([metric, [avg, max, n]]) => [metric, [trim(avg), trim(max), n] as Rollup]),
		);

		await appendLine(rollupPath("minute", at, group), { t: at, v });
	}

	const hour = Math.floor(at / HOUR) * HOUR;

	if (at + MINUTE >= hour + HOUR) {
		await closeHour(hour);
	}
}

/** Every group that has a minute file on a day. */
async function groupsOn(day: number): Promise<string[]> {
	try {
		return (await readdir(join(monitoringDir(), "metrics", "minute", utcDay(day))))
			.filter((name) => name.endsWith(".ndjson"))
			.map((name) => decodeURIComponent(name.slice(0, -".ndjson".length)));
	} catch {
		return [];
	}
}

/** Build the hour starting at `hour` from its minutes, for every group that has some and no hour line yet. */
async function closeHour(hour: number): Promise<void> {
	for (const group of await groupsOn(hour)) {
		const path = rollupPath("hour", hour, group);

		if ((await readRollupFile(path)).some((line) => line.t === hour)) {
			continue;
		}

		const minutes = await readRollups("minute", group, hour, hour + HOUR);

		if (minutes.length === 0) {
			continue;
		}

		const acc = new Map<string, Rollup>();

		for (const line of minutes) {
			for (const [metric, [avg, max, n]] of Object.entries(line.v)) {
				mergeRollup(acc, metric, avg, max, n);
			}
		}

		const v = Object.fromEntries([...acc].map(([metric, [avg, max, n]]) => [metric, [trim(avg), trim(max), n] as Rollup]));

		await appendLine(path, { t: hour, v });
	}
}

/** Close every hour of the last two days a stopped daemon left open. */
async function catchUpHours(now: number): Promise<void> {
	const current = Math.floor(now / HOUR) * HOUR;

	for (let hour = current - MINUTE_KEEP_MS; hour < current; hour += HOUR) {
		await closeHour(hour);
	}
}

/** Remove day folders past their keep, and events older than the hourly record. */
async function sweep(now: number): Promise<void> {
	const keep = {
		minute: now - MINUTE_KEEP_MS - DAY,
		hour: now - (METRICS_KEEP_DAYS + 1) * DAY,
	};

	for (const resolution of ["minute", "hour"] as const) {
		const dir = join(monitoringDir(), "metrics", resolution);

		if (!existsSync(dir)) {
			continue;
		}

		for (const day of await readdir(dir)) {
			const at = Date.parse(`${day}T00:00:00Z`);

			if (Number.isFinite(at) && at < keep[resolution]) {
				await rm(join(dir, day), { recursive: true, force: true });
			}
		}
	}

	const eventsDir = join(monitoringDir(), "events");

	if (!existsSync(eventsDir)) {
		return;
	}

	for (const name of await readdir(eventsDir)) {
		if (!name.endsWith(".ndjson")) {
			continue;
		}

		const path = join(eventsDir, name);
		const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
		const kept = lines.filter((text) => {
			try {
				return (JSON.parse(text) as StoredEvent).t >= keep.hour;
			} catch {
				return false;
			}
		});

		if (kept.length === lines.length) {
			continue;
		}

		// rewritten beside and renamed over, so a reader never sees half a file
		const temp = `${path}.tmp`;

		await writeFile(temp, kept.length > 0 ? kept.join("\n") + "\n" : "");
		await rename(temp, path);
	}
}

// -- writing ------------------------------------------------------------------------

/**
 * Add one group's figures at an instant to the open minute. A figure in a new
 * minute closes the previous one, which is then written in the background;
 * the caller never waits on disk.
 */
export function recordMetrics(group: string, at: number, values: MetricValues): void {
	const minute = Math.floor(at / MINUTE) * MINUTE;

	if (minute > minuteStart) {
		if (minuteStart !== 0 && minuteAcc.size > 0) {
			const closing = minuteAcc;
			const closedAt = minuteStart;

			writes = writes.then(() => writeMinute(closedAt, closing)).catch(() => undefined);
		}

		minuteAcc = new Map();
		minuteStart = minute;
	}

	let metrics = minuteAcc.get(group);

	if (!metrics) {
		metrics = new Map();
		minuteAcc.set(group, metrics);
	}

	for (const [metric, value] of Object.entries(values)) {
		if (Number.isFinite(value)) {
			mergeRollup(metrics, metric, value, value, 1);
		}
	}
}

/** Put an event on the record, in the background. */
export function recordEvent(group: string, event: StoredEvent): void {
	writes = writes.then(() => appendLine(eventsPath(group), event)).catch(() => undefined);
}

// -- reading ------------------------------------------------------------------------

function niceStep(wanted: number, floor: number): number {
	const least = Math.max(wanted, floor);

	return NICE_STEPS.find((step) => step >= least && step % floor === 0)
		?? NICE_STEPS.at(-1)!;
}

/**
 * A group's figures over a window, one sample per step: minute buckets inside
 * the last two days, hours beyond, and the minute still open from memory. A
 * step with nothing measured is left out, so a chart draws the gap.
 */
export async function readMetrics(group: string, from: number, to: number, step?: number): Promise<MetricsWindow> {
	const now = Date.now();
	const span = Math.max(MINUTE, to - from);
	const wanted = step ?? span / TARGET_POINTS;
	const useMinutes = from >= now - MINUTE_KEEP_MS && wanted < HOUR;
	const resolution: MetricsWindow["resolution"] = useMinutes ? "minute" : "hour";
	const stepMs = niceStep(wanted, useMinutes ? MINUTE : HOUR);
	const lines: RollupLine[] = [];
	const openHour = Math.floor(now / HOUR) * HOUR;

	if (useMinutes) {
		lines.push(...await readRollups("minute", group, from, to));
	} else {
		lines.push(...await readRollups("hour", group, from, Math.min(to, openHour)));
		// the hour still open is only on the minute files yet
		lines.push(...await readRollups("minute", group, Math.max(from, openHour), to));
	}

	const open = minuteAcc.get(group);

	if (open && minuteStart >= from && minuteStart < to) {
		lines.push({ t: minuteStart, v: Object.fromEntries(open) });
	}

	const origin = Math.floor(from / stepMs) * stepMs;
	const buckets = new Map<number, Map<string, Rollup>>();

	for (const line of lines) {
		const at = origin + Math.floor((line.t - origin) / stepMs) * stepMs;
		let bucket = buckets.get(at);

		if (!bucket) {
			bucket = new Map();
			buckets.set(at, bucket);
		}

		for (const [metric, [avg, max, n]] of Object.entries(line.v)) {
			mergeRollup(bucket, metric, avg, max, n);
		}
	}

	const samples = [...buckets.entries()]
		.sort(([left], [right]) => left - right)
		.map(([t, metrics]) => {
			const sample: { t: number } & MetricValues = { t } as { t: number } & MetricValues;

			for (const [metric, [avg, max]] of metrics) {
				sample[metric] = trim(PEAK_METRICS.has(metric) ? max : avg);
			}

			return sample;
		});

	return { resolution, step: stepMs, from, to, samples };
}

/** A group's events in a window, newest first, at most `limit`. */
export async function readEvents(group: string, from: number, to: number, limit: number = 500): Promise<StoredEvent[]> {
	let text: string;

	try {
		text = await readFile(eventsPath(group), "utf8");
	} catch {
		return [];
	}

	const out: StoredEvent[] = [];
	const lines = text.split("\n");

	for (let index = lines.length - 1; index >= 0 && out.length < limit; index--) {
		const line = lines[index];

		if (!line) {
			continue;
		}

		try {
			const event = JSON.parse(line) as StoredEvent;

			if (event.t >= from && event.t <= to) {
				out.push(event);
			}
		} catch {
			// a torn last line
		}
	}

	return out;
}

// -- lifecycle ------------------------------------------------------------------------

let sweeper: ReturnType<typeof setInterval> | undefined;

/** Close the hours a stopped daemon missed and start the hourly sweep; once per process. */
export async function startMetricsRecord(): Promise<void> {
	if (sweeper) {
		return;
	}

	const now = Date.now();

	await catchUpHours(now).catch(() => undefined);
	await sweep(now).catch(() => undefined);

	sweeper = setInterval(() => void sweep(Date.now()).catch(() => undefined), HOUR);
	sweeper.unref?.();
}

/** Write the minute in progress and wait for every pending write, so a restart loses nothing measured. */
export async function flushMetricsRecord(): Promise<void> {
	if (minuteStart !== 0 && minuteAcc.size > 0) {
		const closing = minuteAcc;
		const at = minuteStart;

		minuteAcc = new Map();
		writes = writes.then(() => writeMinute(at, closing)).catch(() => undefined);
	}

	await writes;
}
