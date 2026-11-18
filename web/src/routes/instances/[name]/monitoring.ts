// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The Monitoring tab's judgements: what needs someone's attention, and which
 * of the daemon's events are worth a mark on the charts. Every sentence is a
 * language key; nothing here renders.
 */

import { t } from '$lib/i18n.svelte';
import type { ChartBand, ChartMarker, Series } from '$lib/components/chart';
import { enrichEvents, stateChange } from '$lib/components/events';
import type { InstanceEvent, InstanceHistory } from '../details';

/** The tab's views, in the order the switch offers them. */
export const MONITORING_VIEWS = ['overview', 'performance', 'resources', 'uptime'] as const;

export type MonitoringView = (typeof MONITORING_VIEWS)[number];

/**
 * The views an instance has. A proxy runs no world, so it measures no ticks,
 * chunks or entities, and a Performance view would hold nothing of its own.
 */
export function monitoringViews(proxy: boolean): MonitoringView[] {
	if (proxy) {
		return MONITORING_VIEWS.filter((view) => view !== 'performance');
	}

	return [...MONITORING_VIEWS];
}

/** A metric over the window shown: where it ended, and how far it went. */
export interface WindowStats {
	last: number | null;
	mean: number | null;
	min: number | null;
	max: number | null;
}

/** A metric's newest, mean, lowest and highest measured value in the samples given. */
export function windowStats(history: InstanceHistory, metric: string): WindowStats {
	let last: number | null = null;
	let min: number | null = null;
	let max: number | null = null;
	let sum = 0;
	let count = 0;

	for (const sample of history) {
		const value = sample[metric];

		if (typeof value !== 'number' || !Number.isFinite(value)) {
			continue;
		}

		last = value;
		min = min === null ? value : Math.min(min, value);
		max = max === null ? value : Math.max(max, value);
		sum += value;
		count++;
	}

	return {
		last,
		mean: count === 0 ? null : sum / count,
		min,
		max
	};
}

/** A sampling step in words: "5 s", "1 min", "2 h". */
export function fmtStep(ms: number): string {
	if (ms < 60_000) {
		return t('web.monitor.step.seconds', { count: String(Math.round(ms / 1000)) });
	}

	if (ms < 3_600_000) {
		return t('web.monitor.step.minutes', { count: String(Math.round(ms / 60_000)) });
	}

	if (ms < 86_400_000) {
		return t('web.monitor.step.hours', { count: String(Math.round(ms / 3_600_000)) });
	}

	return t('web.monitor.step.days', { count: String(Math.round(ms / 86_400_000)) });
}

/** What the judgement reads off the instance itself. */
export interface AttentionInput {
	state: string;
	checks?: Array<{ name: string; ok: boolean | undefined; detail: string }>;
	lastHeartbeatMs?: number | null;
}

/** One thing that needs attention. */
export interface AttentionReason {
	severity: 'warning' | 'critical';
	text: string;
	detail?: string;
}

/** How long a heartbeat may be silent on a running server before it is news. */
const STALE_HEARTBEAT_MS = 60_000;

/** The window the hour's figures are judged over: the last five minutes, so a spike an hour ago is history. */
const RECENT_MS = 5 * 60_000;

/** The newest measured value of a metric, or null. */
export function latestOf(history: InstanceHistory, metric: string): number | null {
	for (let index = history.length - 1; index >= 0; index--) {
		const value = history[index]![metric];

		if (typeof value === 'number' && Number.isFinite(value)) {
			return value;
		}
	}

	return null;
}

/** The mean of a metric over the samples since `since`, or null when none measured it. */
function meanSince(history: InstanceHistory, metric: string, since: number): number | null {
	let sum = 0;
	let count = 0;

	for (const sample of history) {
		const value = sample[metric];

		if (sample.t >= since && typeof value === 'number' && Number.isFinite(value)) {
			sum += value;
			count++;
		}
	}

	return count === 0
		? null
		: sum / count;
}

/** Everything about the instance that needs attention now, worst first. */
export function attentionReasons(
	inst: AttentionInput,
	history: InstanceHistory,
	events: InstanceEvent[]
): AttentionReason[] {
	const reasons: AttentionReason[] = [];
	const now = Date.now();

	if (inst.state === 'auto-restarting') {
		reasons.push({ severity: 'critical', text: t('web.monitor.reason.crashed') });
	}

	for (const check of inst.checks ?? []) {
		if (check.ok === false) {
			reasons.push({
				severity: 'critical',
				text: t('web.monitor.reason.checkFailed', { check: check.name }),
				detail: check.detail
			});
		}
	}

	if (inst.state === 'running') {
		const since = now - RECENT_MS;
		const tps = meanSince(history, 'tps', since);
		const mspt = meanSince(history, 'msptMean', since);
		const heap = latestOf(history, 'heapUsedMb');
		const heapMax = latestOf(history, 'heapMaxMb');

		if (tps !== null && tps < 19) {
			reasons.push({
				severity: tps < 15 ? 'critical' : 'warning',
				text: t('web.monitor.reason.lowTps', { tps: tps.toFixed(1) })
			});
		}

		if (mspt !== null && mspt > 40) {
			reasons.push({
				severity: mspt > 50 ? 'critical' : 'warning',
				text: t('web.monitor.reason.slowTicks', { ms: mspt.toFixed(1) })
			});
		}

		if (heap !== null && heapMax !== null && heapMax > 0 && heap / heapMax >= 0.9) {
			reasons.push({
				severity: 'warning',
				text: t('web.monitor.reason.heapFull', { percent: String(Math.round((heap / heapMax) * 100)) })
			});
		}

		if (inst.lastHeartbeatMs && now - inst.lastHeartbeatMs > STALE_HEARTBEAT_MS) {
			reasons.push({ severity: 'warning', text: t('web.monitor.reason.silent') });
		}
	}

	const hourAgo = now - 3_600_000;
	const errors = events.filter((event) => event.kind === 'error' && event.t >= hourAgo);

	if (errors.length > 0) {
		reasons.push({
			severity: 'warning',
			text: t('web.monitor.reason.errors', { count: String(errors.length) }),
			detail: errors[0]!.message
		});
	}

	// a stop somebody asked for is not news; one nobody asked for (a crash, or
	// /stop typed in game) in the last day is
	const dayAgo = now - 86_400_000;
	const unasked = enrichEvents(events).filter(
		(event) => event.t >= dayAgo && (event.reasonKey === 'crashed' || event.reasonKey === 'unasked')
	);

	if (unasked.length > 0) {
		reasons.push({
			severity: 'warning',
			text: t('web.monitor.reason.unaskedStops', { count: String(unasked.length) })
		});
	}

	return reasons.sort((left, right) => (left.severity === right.severity ? 0 : left.severity === 'critical' ? -1 : 1));
}

/** Past this many marks a chart is a fence; a long window keeps only what nobody planned. */
const MARKER_LIMIT = 40;

/** A stop nobody asked for: a crash, or `/stop` typed in game. */
function unplanned(event: InstanceEvent): boolean {
	return event.reasonKey === 'crashed' || event.reasonKey === 'unasked';
}

/**
 * The events a chart marks: errors, an operator's requests (usually the
 * explanation for the gap after them) and state changes. The time not running
 * is drawn as a band (`downtimeBands`), so a window crowded with events drops
 * the routine marks and keeps the errors and the stops nobody asked for.
 */
export function eventMarkers(events: InstanceEvent[], from: number | undefined, to: number | undefined): ChartMarker[] {
	if (from === undefined || to === undefined) {
		return [];
	}

	const inside = enrichEvents(events).filter((event) => event.t >= from && event.t <= to);
	const crowded = inside.length > MARKER_LIMIT;
	const markers: ChartMarker[] = [];

	for (const event of inside) {
		if (crowded && event.kind !== 'error' && !unplanned(event)) {
			continue;
		}

		const change = stateChange(event);

		// the outcome line repeats its request, and the steps on the way up are the band's edge
		if (/ finished$/.test(event.message) || (change && change.to !== 'running' && change.from !== 'running')) {
			continue;
		}

		const tone = event.kind === 'error' || unplanned(event)
			? 'critical'
			: event.kind === 'action'
				? 'neutral'
				: change?.to === 'running'
					? 'good'
					: 'warning';

		markers.push({ at: event.t, label: event.message, tone });
	}

	return markers;
}

/**
 * The spans the server was not running, from the state changes in the window:
 * each opens when it leaves `running` and closes when it is back. One that was
 * already open when the window began is drawn from the window's edge, but only
 * when nothing was measured before its end, since the events are a capped list
 * and the change that opened it may simply be missing.
 */
export function downtimeBands(
	events: InstanceEvent[],
	history: InstanceHistory,
	from: number | undefined,
	to: number | undefined
): ChartBand[] {
	if (from === undefined || to === undefined) {
		return [];
	}

	const changes = enrichEvents(events)
		.filter((event) => event.t >= from && event.t <= to && stateChange(event) !== null)
		.sort((left, right) => left.t - right.t);

	const bands: ChartBand[] = [];
	let open: { at: number; crashed: boolean } | null = null;
	let seenChange = false;

	function close(at: number): void {
		if (!open || at <= open.at) {
			open = null;

			return;
		}

		bands.push({
			from: open.at,
			to: at,
			label: open.crashed ? t('web.monitor.band.crashed') : t('web.monitor.band.down'),
			tone: open.crashed ? 'critical' : 'neutral'
		});

		open = null;
	}

	for (const event of changes) {
		const change = stateChange(event)!;

		if (change.from === 'running' && change.to !== 'running') {
			open = { at: event.t, crashed: unplanned(event) };
		} else if (change.to === 'running') {
			if (!open && !seenChange && !history.some((sample) => sample.t < event.t && Object.keys(sample).length > 1)) {
				open = { at: from, crashed: false };
			}

			close(event.t);
		}

		seenChange = true;
	}

	// still down as the window ends
	close(to);

	return bands;
}

/** Milliseconds of a window covered by its downtime bands. */
export function downtimeMs(bands: ChartBand[]): number {
	return bands.reduce((sum, band) => sum + (band.to - band.from), 0);
}

/** How a stop came about, as the stops chart stacks it. */
export const STOP_CAUSES = ['requested', 'crashed', 'unasked'] as const;

/** The stops in the window by cause, each cause in total. */
export interface StopBreakdown {
	series: Series[];
	totals: Record<(typeof STOP_CAUSES)[number], number>;
}

/**
 * Every time the server left `running` in the window, bucketed for a stacked
 * bar chart and split by cause: somebody asked (a stop or a restart), it
 * crashed, or it stopped with nobody on record.
 */
export function stopBreakdown(events: InstanceEvent[], from: number | undefined, to: number | undefined, buckets: number = 48): StopBreakdown {
	const totals = { requested: 0, crashed: 0, unasked: 0 };

	if (from === undefined || to === undefined || to <= from) {
		return { series: [], totals };
	}

	const step = Math.max(60_000, Math.ceil((to - from) / buckets / 60_000) * 60_000);
	const origin = Math.floor(from / step) * step;
	const size = Math.max(1, Math.ceil((to - origin) / step));
	const counts: Record<string, number[]> = {
		requested: new Array<number>(size).fill(0),
		crashed: new Array<number>(size).fill(0),
		unasked: new Array<number>(size).fill(0)
	};

	for (const event of enrichEvents(events)) {
		const change = stateChange(event);

		if (!change || change.from !== 'running' || change.to === 'running' || event.t < from || event.t > to) {
			continue;
		}

		const cause = event.reasonKey === 'crashed'
			? 'crashed'
			: event.reasonKey?.startsWith('requested')
				? 'requested'
				: 'unasked';
		const slot = Math.min(size - 1, Math.floor((event.t - origin) / step));

		counts[cause]![slot]!++;
		totals[cause]++;
	}

	return {
		series: STOP_CAUSES.map((cause): Series => ({
			key: cause,
			unit: 'count',
			points: counts[cause]!.map((value, index): [number, number] => [origin + index * step, value])
		})),
		totals
	};
}
