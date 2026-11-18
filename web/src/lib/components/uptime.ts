// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Types and slot resolution for `UptimeTimeline.svelte`. The bands are the
 * daemon's own (`core/uptime.ts`), so the timeline and the uptime store cannot
 * drift apart.
 */

import { bandFor, type UptimeTone } from '$core/uptime';

export type { UptimeTone } from '$core/uptime';

/** One day, as the timeline reads it: seconds up over seconds observed. */
export interface UptimeDayPoint {
	/** Calendar day, `YYYY-MM-DD` */
	d: string;
	up: number;
	seen: number;
	/** Times it stopped that day, when the store counts them */
	stops?: number;
}

/** One row of a stacked timeline: a service and its days. */
export interface UptimeRow {
	label: string;
	days: UptimeDayPoint[];
	/** Uptime across the window, percent; null when nothing was observed */
	pct: number | null;
}

/** A day resolved into what the timeline draws for it. */
export interface UptimeSlot {
	d: string;
	tone: UptimeTone;
	/** Fill height as a percentage of the track; 0 when nothing was observed */
	height: number;
	/** Uptime that day, or null when it was not observed */
	pct: number | null;
	/** Minutes not running that day */
	lostMinutes: number;
	/** Hours the daemon watched that day, rounded down */
	watchedHours: number;
	stops: number;
}

/**
 * Resolve a day into its slot. A day nobody observed is `none` with no fill,
 * which is deliberately not a day at 0%: the track is drawn either way, and an
 * empty one says the daemon was not watching rather than that the app was down.
 */
export function slotFor(day: UptimeDayPoint): UptimeSlot {
	if (!day.seen) {
		return { d: day.d, tone: 'none', height: 0, pct: null, lostMinutes: 0, watchedHours: 0, stops: 0 };
	}

	const pct = (day.up / day.seen) * 100;
	const band = bandFor(pct);

	return {
		d: day.d,
		tone: band.tone,
		height: band.height,
		pct,
		lostMinutes: Math.round((day.seen - day.up) / 60),
		watchedHours: Math.floor(day.seen / 3600),
		stops: day.stops ?? 0
	};
}
