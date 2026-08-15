// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Long-term uptime history: how much of each day every instance was actually
 * running, kept for long enough to answer "was it up last Tuesday".
 *
 * The metrics sampler keeps one hour in memory and loses it when the daemon
 * exits, which is fine for a chart and useless for a record. This store is the
 * record: one bucket per instance per day, appended to from the health samples
 * the cluster already produces.
 *
 * A bucket holds seconds *up* over seconds *observed*, and the second half is
 * what keeps it honest. A daemon that was not running did not measure that
 * window, so those seconds are absent rather than counted as downtime; a
 * machine that was off for a week does not read as a week-long outage, and the
 * percentage divides by what was really watched. Same rule the health sampler
 * follows: a measurement nobody took is absent, never zero.
 *
 * This module is pure. It never reads the clock on its own, never touches disk
 * and imports nothing that does; the daemon feeds it observations and decides
 * when to persist. That matters beyond tidiness: the console's timeline
 * component imports the banding below, so anything reached from here would be
 * pulled into the browser bundle. Where the store lives is `daemon/uptime.ts`.
 */

/** One instance's day. */
export interface UptimeDay {
	/** Calendar day, `YYYY-MM-DD`, in the daemon's local zone */
	d: string;
	/** Seconds the instance was observed running */
	up: number;
	/** Seconds the instance was observed at all */
	seen: number;
	/** Transitions into a down state during the day */
	stops: number;
}

/** One instance's record. */
export interface UptimeRecord {
	/** Last state seen, so a transition can be detected */
	state?: string;
	/** When the current state began, epoch ms */
	since?: number;
	/** Oldest first, capped at `RETENTION_DAYS` */
	days: UptimeDay[];
}

export interface UptimeStore {
	instances: Record<string, UptimeRecord>;
}

/** How much history is kept. Ninety days is what status pages settle on. */
export const RETENTION_DAYS = 90;

/**
 * Longest gap between two observations that still counts as observed.
 *
 * Samples arrive every few seconds, so a larger gap means nobody was watching:
 * the daemon was restarting, the link to a follower was down, or the machine
 * was off. Crediting that gap either way would be a guess, so it is dropped and
 * the day's `seen` simply does not grow.
 */
export const MAX_OBSERVATION_GAP_MS = 30_000;

/** States that count as the instance being up. */
const UP_STATES = new Set(["running", "stopping", "restarting"]);

/** An empty store, which is also what a missing file reads as. */
export function emptyStore(): UptimeStore {
	return { instances: {} };
}

/**
 * Calendar day key for an instant, `YYYY-MM-DD` in local time.
 *
 * Local rather than UTC because the person reading the timeline thinks in their
 * own days; an outage at 9pm belongs to the evening it ruined.
 */
export function dayKey(at: number): string {
	const date = new Date(at);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");

	return `${date.getFullYear()}-${month}-${day}`;
}

/** Whether a UI state counts as the instance being up. */
export function isUp(state: string): boolean {
	return UP_STATES.has(state);
}

/** The record for an instance, created on first sight. */
function recordFor(store: UptimeStore, instance: string): UptimeRecord {
	const existing = store.instances[instance];

	if (existing) {
		return existing;
	}

	const created: UptimeRecord = { days: [] };

	store.instances[instance] = created;

	return created;
}

/** The bucket for a day, appended and trimmed as the window rolls forward. */
function dayFor(record: UptimeRecord, key: string): UptimeDay {
	const last = record.days.at(-1);

	if (last?.d === key) {
		return last;
	}

	// an out-of-order key means the clock went backwards; reuse the bucket rather
	// than appending a second one for the same day and breaking the ordering
	const existing = record.days.find((day) => day.d === key);

	if (existing) {
		return existing;
	}

	const created: UptimeDay = { d: key, up: 0, seen: 0, stops: 0 };

	record.days.push(created);

	if (record.days.length > RETENTION_DAYS) {
		record.days.splice(0, record.days.length - RETENTION_DAYS);
	}

	return created;
}

/**
 * Fold one round of observed instance states into the store.
 *
 * `states` is a machine's live view, exactly as `HealthSample.states` carries
 * it, so the caller is whoever already receives those: the primary for its own
 * instances, and the hub for a follower's as its samples ride the heartbeat.
 *
 * Time is credited from the previous observation of the same instance up to
 * this one, which is why a gap longer than `MAX_OBSERVATION_GAP_MS` credits
 * nothing: the state in between is unknown.
 */
export function observe(store: UptimeStore, states: Record<string, string>, at: number): void {
	for (const [instance, state] of Object.entries(states)) {
		const record = recordFor(store, instance);
		const previous = record.since;
		const elapsed = previous === undefined ? 0 : at - previous;

		if (elapsed > 0 && elapsed <= MAX_OBSERVATION_GAP_MS && record.state !== undefined) {
			const day = dayFor(record, dayKey(previous!));
			const seconds = elapsed / 1000;

			day.seen += seconds;

			if (isUp(record.state)) {
				day.up += seconds;
			}
		}

		// a stop is counted where it is seen, which is the day it happened rather
		// than the day the previous observation fell in
		if (record.state !== undefined && isUp(record.state) && !isUp(state)) {
			dayFor(record, dayKey(at)).stops += 1;
		}

		record.state = state;
		record.since = at;
	}
}

/**
 * Mark instances as no longer observed, so the next observation does not credit
 * the whole gap. Called when a follower's link drops: its instances keep
 * whatever state they were last seen in, and nothing accrues until it returns.
 */
export function forget(store: UptimeStore, instances: string[]): void {
	for (const instance of instances) {
		const record = store.instances[instance];

		if (record) {
			record.since = undefined;
		}
	}
}

/** Drop records for instances the cluster no longer has. */
export function prune(store: UptimeStore, known: string[]): number {
	const keep = new Set(known);
	let dropped = 0;

	for (const instance of Object.keys(store.instances)) {
		if (!keep.has(instance)) {
			delete store.instances[instance];
			dropped += 1;
		}
	}

	return dropped;
}

// -- how a day is read ----------------------------------------------------------

/** How a day is painted; `none` is a day nobody observed. */
export type UptimeTone = "ok" | "warn" | "bad" | "down" | "none";

/** A band of uptime and how it is drawn. */
export interface UptimeBand {
	/** Lowest percentage in this band */
	min: number;
	tone: UptimeTone;
	/** Bar height as a percentage of its track */
	height: number;
}

/**
 * The bands a day's uptime falls into.
 *
 * Uptime lives between 99 and 100 nearly all the time, so a bar whose height is
 * linear in it is a flat wall with nothing to read. These are the boundaries an
 * operator actually distinguishes: a clean day, a restart or two, a bad hour, a
 * broken day. They live here rather than in the component because the CLI draws
 * the same record as a row of blocks and the two must not disagree about what
 * counts as a bad day.
 */
export const UPTIME_BANDS: readonly UptimeBand[] = [
	{ min: 99.99, tone: "ok", height: 100 },
	{ min: 99.9, tone: "ok", height: 78 },
	{ min: 99, tone: "warn", height: 58 },
	{ min: 95, tone: "bad", height: 40 },
	{ min: 0, tone: "down", height: 26 },
];

/** The band a percentage falls into. */
export function bandFor(pct: number): UptimeBand {
	return UPTIME_BANDS.find((band) => pct >= band.min) ?? UPTIME_BANDS[UPTIME_BANDS.length - 1]!;
}

/** Just the tone, for a caller that has no bar to size. */
export function slotTone(pct: number): UptimeTone {
	return bandFor(pct).tone;
}

/** One instance's timeline, oldest first, padded so every day has a slot. */
export interface UptimeSeries {
	days: Array<{ d: string; up: number; seen: number; stops: number }>;
	/** Uptime over the window, percent, or null when nothing was observed */
	pct: number | null;
	/** Seconds observed across the window */
	seen: number;
	stops: number;
}

/**
 * Read an instance's window as a dense series ending today.
 *
 * Days the store has no bucket for are filled with zeroes, which is the
 * "not measured" state rather than a zero-uptime day: `seen` is what separates
 * them, and the timeline paints an empty slot for it.
 */
export function series(store: UptimeStore, instance: string, days: number, now: number): UptimeSeries {
	const record = store.instances[instance];
	const byDay = new Map((record?.days ?? []).map((day) => [day.d, day]));
	const out: UptimeSeries["days"] = [];

	let seen = 0;
	let up = 0;
	let stops = 0;

	for (let offset = days - 1; offset >= 0; offset--) {
		const at = now - offset * 86_400_000;
		const key = dayKey(at);
		const day = byDay.get(key);

		out.push({
			d: key,
			up: day?.up ?? 0,
			seen: day?.seen ?? 0,
			stops: day?.stops ?? 0,
		});

		seen += day?.seen ?? 0;
		up += day?.up ?? 0;
		stops += day?.stops ?? 0;
	}

	return {
		days: out,
		pct: seen > 0 ? Math.round((up / seen) * 10_000) / 100 : null,
		seen,
		stops,
	};
}
