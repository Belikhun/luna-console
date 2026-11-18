// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/** The change a `StatTile` reports against the previous period. */

import { fmtCompact, type SeriesUnit } from './chart';

/** Which way is good for a figure: up for uptime, down for errors, neither for requests. */
export type DeltaGood = 'up' | 'down' | 'neutral';

/** A change as a screen hands it to a tile. */
export interface StatDeltaInput {
	/** Signed: +12 is up twelve percent (or points) */
	value: number;
	/** `percent` of the previous figure, or percentage `points` for a rate */
	unit: 'percent' | 'points';
	good: DeltaGood;
}

/** A change, ready to draw. */
export interface StatDelta {
	direction: 'up' | 'down' | 'flat';
	/** `+12%` or `−0.4`; the points suffix is the tile's, in the reader's language */
	text: string;
	points: boolean;
	tone: 'good' | 'bad' | 'neutral';
}

/**
 * The change from the previous window to this one, as a tile takes it. A rate
 * (an error rate, uptime) changes in points, since "+50%" of a 0.2% error rate
 * says less than "+0.1 points"; everything else in percent. Null when there is
 * nothing to compare with: no figure, no previous figure, or a previous zero.
 */
export function deltaBetween(
	value: number | null,
	previous: number | null | undefined,
	unit: SeriesUnit,
	good: DeltaGood
): StatDeltaInput | null {
	if (value === null || previous === null || previous === undefined) {
		return null;
	}

	if (unit === 'percent') {
		return { value: value - previous, unit: 'points', good };
	}

	if (previous === 0) {
		return null;
	}

	return { value: ((value - previous) / previous) * 100, unit: 'percent', good };
}

/**
 * How a change is drawn. The colour comes from whether its direction is good
 * for this figure, never from the sign alone: more requests is neutral, a
 * higher error rate is bad, higher uptime is good.
 */
export function statDelta(delta: StatDeltaInput): StatDelta {
	const size = Math.abs(delta.value);
	const rounded = size >= 10
		? Math.round(size)
		: Math.round(size * 10) / 10;

	const points = delta.unit === 'points';
	const suffix = points
		? ''
		: '%';

	if (rounded === 0) {
		return { direction: 'flat', text: `0${suffix}`, points, tone: 'neutral' };
	}

	const direction = delta.value > 0
		? 'up'
		: 'down';

	const sign = direction === 'up'
		? '+'
		: '−';

	const tone = delta.good === 'neutral'
		? 'neutral'
		: direction === delta.good
			? 'good'
			: 'bad';

	return { direction, text: `${sign}${fmtCompact(rounded)}${suffix}`, points, tone };
}
