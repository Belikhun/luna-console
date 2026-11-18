// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Arithmetic for the instances list's split panel: the hour of samples turned
 * into the kit's series, the uptime record cut to a window, and the tones a
 * live figure wears. Nothing here renders.
 */

import type { Series, SeriesUnit } from '$lib/components/chart';
import type { UptimeDayPoint } from '$lib/components/uptime';

/** One sampled moment, as `/api/instances/<name>/metrics` answers it. */
export interface HistorySample {
	t: number;
	[metric: string]: number | undefined;
}

export type { InstanceEvent } from '$lib/components/events';

/** The sampled hour, oldest first. */
export type InstanceHistory = HistorySample[];

/**
 * A figure the sampler took every few seconds, as one series; an unmeasured
 * sample is a gap. `scale` converts the stored unit into the series' own (the
 * sampler keeps memory in MB, the kit formats bytes).
 */
export function historySeries(history: InstanceHistory, metric: string, unit: SeriesUnit, scale: number = 1): Series {
	return {
		key: metric,
		unit,
		points: history.map((sample): [number, number | null] => {
			const value = sample[metric];
			const measured = typeof value === 'number' && Number.isFinite(value);

			return [sample.t, measured ? value * scale : null];
		})
	};
}

/** A row's trends, as `/api/instances?trends=1` answers them. */
export interface RowTrends {
	from: number;
	step: number;
	series: Record<'cpu' | 'rssMb' | 'tps' | 'players', (number | null)[]>;
	uptime: { pct: number | null; days: UptimeDayPoint[] } | null;
}

/** One of a row's trends as a series the kit draws; null when nothing in the hour was measured. */
export function trendSeries(trends: RowTrends | undefined, metric: keyof RowTrends['series'], unit: SeriesUnit, scale: number = 1): Series | null {
	const values = trends?.series[metric];

	if (!trends || !values || values.every((value) => value === null)) {
		return null;
	}

	return {
		key: metric,
		unit,
		points: values.map((value, index): [number, number | null] => [
			trends.from + index * trends.step,
			value === null ? null : value * scale
		])
	};
}

/** Bytes in a megabyte, for the sampler's memory figures. */
export const MB = 1024 * 1024;

/** How the status checks came out. */
export interface CheckSummary {
	total: number;
	passed: number;
	failed: number;
	/** Checks that could not be decided (the server is not answering yet) */
	unknown: number;
}

/** Count the status checks by outcome. */
export function checkSummary(checks: Array<{ ok: boolean | undefined }>): CheckSummary {
	const summary: CheckSummary = { total: checks.length, passed: 0, failed: 0, unknown: 0 };

	for (const check of checks) {
		if (check.ok === undefined) {
			summary.unknown++;
		} else if (check.ok) {
			summary.passed++;
		} else {
			summary.failed++;
		}
	}

	return summary;
}

/** The last `count` days of the uptime record and their uptime, percent (null when nothing was watched). */
export function uptimeWindow(days: UptimeDayPoint[], count: number): { days: UptimeDayPoint[]; pct: number | null } {
	const window = days.slice(-count);

	let up = 0;
	let seen = 0;

	for (const day of window) {
		up += day.up;
		seen += day.seen;
	}

	return {
		days: window,
		pct: seen > 0
			? (up / seen) * 100
			: null
	};
}

/** Tick rate: 20 is the ceiling, below 15 a server visibly lags. */
export function tpsTone(tps: number): 'good' | 'warning' | 'critical' {
	if (tps >= 19) {
		return 'good';
	}

	return tps >= 15
		? 'warning'
		: 'critical';
}

/**
 * Tick duration against the 50 ms budget. TPS floors at 20 while this keeps
 * climbing, so a server at 20 TPS and 45 ms is one bad chunk from stuttering.
 */
export function msptTone(mspt: number): 'good' | 'warning' | 'critical' {
	if (mspt <= 25) {
		return 'good';
	}

	return mspt <= 40
		? 'warning'
		: 'critical';
}

/** The badge state for what the proxy says about a backend. */
export function networkTone(status: string): string {
	switch (status.toUpperCase()) {
		case 'ONLINE':
			return 'passed';

		case 'MAINT':
			return 'warning';

		default:
			return 'stopped';
	}
}
