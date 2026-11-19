// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The time range a monitoring screen shows, and its place in the URL. A
 * preset is relative (`?range=24h` always means the last day, so a link or a
 * refresh keeps moving with the clock); a custom range or a drag-to-zoom is two
 * fixed instants (`?range=1731500000000-1731586400000`).
 */

import {
	DEFAULT_PRESET,
	RANGE_PRESET_MS,
	isRangePreset,
	parseFixedRange,
	type RangePreset
} from '$shared/timerange';

// the presets and their spans are the daemon's own, so a link and an API read agree
export { RANGE_PRESETS, type RangePreset } from '$shared/timerange';

/** A relative preset, or two fixed instants in epoch ms. */
export type TimeRange =
	| { kind: 'preset'; preset: RangePreset }
	| { kind: 'fixed'; from: number; to: number };

/** The query parameter every monitoring screen keeps its range in. */
export const RANGE_PARAM = 'range';

/** The range a screen opens on when the URL names none. */
export const DEFAULT_RANGE: TimeRange = { kind: 'preset', preset: DEFAULT_PRESET };

/** The shortest range a zoom may narrow to: below it the rollups have nothing finer. */
export const MIN_RANGE_MS = 5 * 60_000;

/** Read `?range=`; anything unreadable falls back to the default rather than failing the page. */
export function parseRange(value: string | null | undefined): TimeRange {
	if (!value) {
		return DEFAULT_RANGE;
	}

	if (isRangePreset(value)) {
		return { kind: 'preset', preset: value };
	}

	const fixed = parseFixedRange(value);

	if (!fixed || !(fixed.to - fixed.from >= MIN_RANGE_MS)) {
		return DEFAULT_RANGE;
	}

	return { kind: 'fixed', from: fixed.from, to: fixed.to };
}

/** A range as its `?range=` value. */
export function rangeParam(range: TimeRange): string {
	return range.kind === 'preset'
		? range.preset
		: `${Math.round(range.from)}-${Math.round(range.to)}`;
}

/** The instants a range covers, now. */
export function resolveRange(range: TimeRange, now: number = Date.now()): { from: number; to: number } {
	if (range.kind === 'fixed') {
		return { from: range.from, to: range.to };
	}

	return { from: now - RANGE_PRESET_MS[range.preset], to: now };
}

/** A preset's length in ms. */
export function presetSpan(preset: RangePreset): number {
	return RANGE_PRESET_MS[preset];
}

/**
 * The same page with another range, every other query parameter kept: what a
 * picker or a zoom navigates to.
 */
export function withRange(url: URL, range: TimeRange): string {
	const next = new URL(url);

	if (rangeParam(range) === rangeParam(DEFAULT_RANGE)) {
		next.searchParams.delete(RANGE_PARAM);
	} else {
		next.searchParams.set(RANGE_PARAM, rangeParam(range));
	}

	return `${next.pathname}${next.search}${next.hash}`;
}

/**
 * The step a range is read at, mirroring the daemon's resolutions: 10 s
 * samples for an hour, minutes up to two days, hours beyond.
 */
export function stepFor(span: number): number {
	if (span <= 3_600_000) {
		return 10_000;
	}

	if (span <= 6 * 3_600_000) {
		return 60_000;
	}

	if (span <= 48 * 3_600_000) {
		return 5 * 60_000;
	}

	return 3_600_000;
}
