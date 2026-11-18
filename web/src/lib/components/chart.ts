// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Types and arithmetic for the chart kit (`TimeSeriesChart`, `StackedBars`,
 * `LatencyChart`, `StatTile`, `RankedList`): the series shape the daemon's
 * monitoring ops return, unit formatting, round axis ticks and time ticks.
 * Geometry here is in CSS pixels, which is what the browser measures the plot
 * in; nothing here reaches a stylesheet.
 */

import { currentLanguage, t } from '$lib/i18n.svelte';

/** How a series' values are formatted. */
export type SeriesUnit = 'count' | 'bytes' | 'percent' | 'ms' | 'rate' | 'bytesRate';

/**
 * One time series. A point's value is null where nothing was measured (a gap),
 * never zero: a measurement nobody took is absent.
 */
export interface Series {
	key: string;
	unit: SeriesUnit;
	/** `[epoch ms, value]`, oldest first, one per step */
	points: [number, number | null][];
}

/** How a series is drawn and named; colour follows the key, never its rank. */
export interface SeriesStyle {
	label: string;
	/** Any CSS colour or token; the next free categorical slot when absent */
	color?: string;
	/** A reference line rather than a measurement: a max, the app's own p95, the codespace */
	dashed?: boolean;
}

/** A moment worth marking on a time axis: a deploy, a restart, an OOM kill. */
export interface ChartMarker {
	at: number;
	label: string;
	tone?: 'neutral' | 'good' | 'warning' | 'critical';
	/** The release or event row the marker opens */
	href?: string;
}

/** A shaded span on a time axis: an incident, a period the app was down. */
export interface ChartBand {
	from: number;
	to: number;
	label: string;
	tone?: 'neutral' | 'warning' | 'critical';
}

/** A horizontal reference line: a memory limit, a latency budget. */
export interface ChartThreshold {
	value: number;
	label: string;
	tone?: 'warning' | 'critical';
}

/** The categorical slots, in their validated order. */
export const CHART_SLOTS: readonly string[] = [
	'var(--chart-1)',
	'var(--chart-2)',
	'var(--chart-3)',
	'var(--chart-4)',
	'var(--chart-5)',
	'var(--chart-6)',
	'var(--chart-7)',
	'var(--chart-8)'
];

/** Colours for responses by status class: they mean something, so status tokens. */
export const STATUS_CLASS_COLORS: Readonly<Record<string, string>> = {
	'2xx': 'var(--chart-good)',
	'3xx': 'var(--chart-muted)',
	'4xx': 'var(--chart-warning)',
	'5xx': 'var(--chart-critical)'
};

/** Latency percentiles, an ordered set on one hue. */
export const PERCENTILE_COLORS: Readonly<Record<string, string>> = {
	p50: 'var(--chart-ordinal-1)',
	p95: 'var(--chart-ordinal-2)',
	p99: 'var(--chart-ordinal-3)'
};

/**
 * Resolve each series' colour: an explicit one first, then the categorical slot
 * matching its position among the series given, so a caller that keeps a fixed
 * key order keeps fixed colours.
 */
export function seriesColors(
	series: readonly Series[],
	styles: Readonly<Record<string, SeriesStyle>> | undefined
): Record<string, string> {
	const out: Record<string, string> = {};

	series.forEach((entry, index) => {
		const explicit = styles?.[entry.key]?.color;
		const slot = CHART_SLOTS[index % CHART_SLOTS.length] ?? 'var(--chart-1)';

		out[entry.key] = explicit ?? slot;
	});

	return out;
}

/** A unit's display scale: what to divide by and what to write after. */
interface UnitScale {
	divisor: number;
	suffix: string;
}

const BYTE_STEPS = ['B', 'KB', 'MB', 'GB', 'TB'];

/**
 * The scale a set of values is written in, chosen from the largest one so an
 * axis reads 0 / 250 / 500 MB rather than mixing units tick by tick.
 */
export function unitScale(unit: SeriesUnit, largest: number): UnitScale {
	if (unit === 'bytes' || unit === 'bytesRate') {
		let step = 0;
		let divisor = 1;

		while (largest / divisor >= 1024 && step < BYTE_STEPS.length - 1) {
			divisor *= 1024;
			step += 1;
		}

		const suffix = unit === 'bytesRate'
			? `${BYTE_STEPS[step]}/s`
			: (BYTE_STEPS[step] ?? 'B');

		return { divisor, suffix: ` ${suffix}` };
	}

	if (unit === 'ms') {
		return largest >= 2000
			? { divisor: 1000, suffix: ' s' }
			: { divisor: 1, suffix: ' ms' };
	}

	if (unit === 'percent') {
		return { divisor: 1, suffix: '%' };
	}

	if (unit === 'rate') {
		return { divisor: 1, suffix: '/s' };
	}

	return { divisor: 1, suffix: '' };
}

/** A plain number the way the console writes it: 950, 12.9k, 4.2M. */
export function fmtCompact(value: number): string {
	const size = Math.abs(value);

	if (size >= 1_000_000) {
		return `${trimZero(value / 1_000_000, size >= 10_000_000 ? 0 : 1)}M`;
	}

	if (size >= 10_000) {
		return `${trimZero(value / 1000, size >= 100_000 ? 0 : 1)}k`;
	}

	if (size >= 100 || Number.isInteger(value)) {
		return Math.round(value).toLocaleString('en-GB');
	}

	return trimZero(value, size >= 10 ? 1 : 2);
}

function trimZero(value: number, decimals: number): string {
	return String(Number(value.toFixed(decimals)));
}

/**
 * One value in its unit, scaled on its own: `12.4 MB`, `384 ms`, `1.2 s`,
 * `99.95%`. Null is the "not measured" dash.
 */
export function fmtValue(value: number | null | undefined, unit: SeriesUnit): string {
	if (value === null || value === undefined || Number.isNaN(value)) {
		return '–';
	}

	if (unit === 'percent') {
		const decimals = value >= 99 && value < 100
			? 2
			: 1;

		return `${trimZero(value, decimals)}%`;
	}

	const scale = unitScale(unit, Math.abs(value));

	return `${fmtCompact(value / scale.divisor)}${scale.suffix}`;
}

/**
 * Round ticks from zero (or a negative floor) up past the largest value: steps
 * of 1, 2, 2.5 or 5 times a power of ten, about `count` of them.
 */
export function niceTicks(min: number, max: number, count = 4): number[] {
	const low = Math.min(0, min);
	const high = max > low
		? max
		: low + 1;

	const rough = (high - low) / count;
	const power = 10 ** Math.floor(Math.log10(rough));

	const step = [1, 2, 2.5, 5, 10]
		.map((factor) => factor * power)
		.find((candidate) => candidate >= rough) ?? 10 * power;

	const ticks: number[] = [];
	const first = Math.floor(low / step) * step;

	for (let value = first; value < high + step * 0.999; value += step) {
		ticks.push(Number(value.toPrecision(12)));
	}

	return ticks;
}

/** Ticks for a unit's axis, in the unit's own display scale (bytes in MB, ms in s). */
export function unitTicks(unit: SeriesUnit, largest: number, count = 4, fit = false): { ticks: number[]; scale: UnitScale } {
	if (unit === 'percent' && largest <= 100 && !fit) {
		return { ticks: [0, 25, 50, 75, 100], scale: unitScale(unit, largest) };
	}

	const scale = unitScale(unit, largest);
	const scaled = niceTicks(0, largest / scale.divisor, count);

	return {
		ticks: scaled.map((tick) => tick * scale.divisor),
		scale
	};
}

/** An axis label for a tick, written in the axis' shared scale. */
export function fmtTick(value: number, scale: UnitScale): string {
	return `${fmtCompact(value / scale.divisor)}${scale.suffix}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const TIME_STEPS = [
	MINUTE,
	5 * MINUTE,
	10 * MINUTE,
	15 * MINUTE,
	30 * MINUTE,
	HOUR,
	3 * HOUR,
	6 * HOUR,
	12 * HOUR,
	DAY,
	2 * DAY,
	7 * DAY
];

function locale(): string {
	return currentLanguage() === 'vi'
		? 'vi-VN'
		: 'en-GB';
}

/**
 * Time ticks across `[from, to]` for a plot `width` px wide: whole minutes,
 * hours or local days, about one per `spacing` px.
 */
export function timeTicks(from: number, to: number, width: number, spacing = 96): number[] {
	const span = Math.max(1, to - from);
	const wanted = Math.max(2, Math.floor(width / spacing));

	// a span no listed step covers (months on a narrow plot) steps by whole
	// weeks, as many as it takes, or its labels pile onto each other
	const fitted = TIME_STEPS.find((candidate) => span / candidate <= wanted)
		?? Math.ceil(span / wanted / (7 * DAY)) * 7 * DAY;

	// past two days a tick is labelled with its date alone, so ticks inside a day
	// would print the same date twice: never step finer than a day there
	const step = span > 2 * DAY
		? Math.max(fitted, DAY)
		: fitted;

	const ticks: number[] = [];

	if (step >= DAY) {
		const cursor = new Date(from);
		cursor.setHours(0, 0, 0, 0);

		if (cursor.getTime() < from) {
			cursor.setDate(cursor.getDate() + 1);
		}

		const days = Math.round(step / DAY);

		while (cursor.getTime() <= to) {
			ticks.push(cursor.getTime());
			cursor.setDate(cursor.getDate() + days);
		}

		return ticks;
	}

	// whole steps in local time: a 3 h tick lands on 00, 03, 06 on the clock
	const offset = new Date(from).getTimezoneOffset() * MINUTE;
	let cursor = Math.ceil((from - offset) / step) * step + offset;

	while (cursor <= to) {
		ticks.push(cursor);
		cursor += step;
	}

	return ticks;
}

/** A time tick's label: a clock time inside a day, a date across days. */
export function fmtTimeTick(at: number, span: number): string {
	const date = new Date(at);
	const midnight = date.getHours() === 0 && date.getMinutes() === 0;

	if (span > 2 * DAY || (midnight && span > 6 * HOUR)) {
		return date.toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
	}

	return date.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
}

/** The full moment a crosshair or tooltip stands on. */
export function fmtMoment(at: number, span: number): string {
	const options: Intl.DateTimeFormatOptions = {
		day: 'numeric',
		month: 'short',
		hour: '2-digit',
		minute: '2-digit'
	};

	// an hour of 10 s samples needs the seconds to tell two moments apart
	if (span <= HOUR) {
		options.second = '2-digit';
	}

	return new Date(at).toLocaleString(locale(), options);
}

/** Every distinct timestamp across the series, sorted. */
export function timestamps(series: readonly Series[]): number[] {
	const all = new Set<number>();

	for (const entry of series) {
		for (const [at] of entry.points) {
			all.add(at);
		}
	}

	return [...all].sort((a, b) => a - b);
}

/** Index of the timestamp nearest `at` in a sorted list; -1 when the list is empty. */
export function nearestIndex(sorted: readonly number[], at: number): number {
	if (sorted.length === 0) {
		return -1;
	}

	let low = 0;
	let high = sorted.length - 1;

	while (high - low > 1) {
		const middle = (low + high) >> 1;

		if ((sorted[middle] ?? 0) < at) {
			low = middle;
		} else {
			high = middle;
		}
	}

	const below = Math.abs((sorted[low] ?? 0) - at);
	const above = Math.abs((sorted[high] ?? 0) - at);

	return above < below
		? high
		: low;
}

/** A series' value at a timestamp; null when it has no point there or measured nothing. */
export function valueAt(entry: Series, at: number): number | null {
	for (const [time, value] of entry.points) {
		if (time === at) {
			return value;
		}
	}

	return null;
}

/** The text a screen reader hears for one moment of a chart. */
export function describeMoment(
	at: number,
	span: number,
	rows: ReadonlyArray<{ label: string; value: string }>
): string {
	const values = rows.map((row) => `${row.label} ${row.value}`).join(', ');

	return `${fmtMoment(at, span)}: ${values || t('web.chart.notMeasured')}`;
}
