// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The fleet Monitoring page's judgements: what needs attention across every
 * instance, the chosen window as series per instance, events as counts over
 * time, and the verbs of a row. Nothing here renders.
 */

import { goto } from '$app/navigation';

import { t } from '$lib/i18n.svelte';
import type { InstanceRow } from '$lib/api';
import type { Series, SeriesUnit } from '$lib/components/chart';
import { menuGroups, type ContextMenuItem } from '$lib/components/contextmenu';
import type { InstanceEvent } from '$lib/components/events';
import { instanceTabPath } from '$lib/components/instancetabs';
import { METRICS_RANGES, type MetricsRange } from '$shared/metricsrange';
import { MB, type HistorySample, type RowTrends } from '../instances/details';

/** The page's tabs, in order; the first is the default. */
export const FLEET_TABS = ['overview', 'events', 'machines'] as const;

export type FleetTab = (typeof FLEET_TABS)[number];

/** The series key of the instances a top-N chart folds together. */
export const OTHER_KEY = '~other';

/** One sample of a machine's own figures, as its daemon takes them. */
export interface MachineHealth {
	t: number;
	cpuPct: number;
	cpuCores: number;
	memUsedMb: number;
	memTotalMb: number;
	swapUsedMb?: number;
	swapTotalMb?: number;
	diskUsedBytes: number;
	diskTotalBytes: number;
	load1: number;
	uptimeSec: number;
	/** Resident memory of every instance the machine runs, MB */
	instancesRssMb?: number;
}

/** One machine of the cluster, as `/api/daemons` answers it. */
export interface DaemonRow {
	name: string;
	mode: 'primary' | 'follower';
	state: 'online' | 'quarantined' | 'offline';
	version?: string;
	/** Round trip of the cluster link, ms; null on the primary itself */
	latencyMs?: number | null;
	uptimeMs: number | null;
	instances: string[];
	health: MachineHealth | null;
}

/** One thing on one instance that needs attention. */
export interface FleetReason {
	instance: string;
	severity: 'warning' | 'critical';
	text: string;
	detail?: string;
}

/** Every instance's figures over one window, oldest first, whatever they were read from. */
export interface FleetHistory {
	from: number;
	to: number;
	samples: Record<string, HistorySample[]>;
}

/** The window the URL asks for; the live hour when it names none. */
export function parseFleetRange(asked: string | null): MetricsRange {
	return (METRICS_RANGES as readonly string[]).includes(asked ?? '')
		? (asked as MetricsRange)
		: '1h';
}

/** The page's own address on a tab and a window, the defaults left out. */
export function fleetHref(tab: FleetTab, range: MetricsRange): string {
	const query = new URLSearchParams();

	if (tab !== 'overview') {
		query.set('tab', tab);
	}

	if (range !== '1h') {
		query.set('range', range);
	}

	const text = query.toString();

	return `/monitoring${text ? `?${text}` : ''}`;
}

/** Whether a row is the network's proxy, whose players are every backend's players counted again. */
export function isProxy(row: InstanceRow): boolean {
	return row.software === 'velocity';
}

/**
 * People on the network now. A running proxy knows the figure exactly, servers
 * it routes to but luna does not run included; without one, the backends' own
 * counts are added up.
 */
export function playersOnline(rows: InstanceRow[]): number {
	const running = rows.filter((row) => row.state === 'running');
	const proxies = running.filter((row) => isProxy(row) && row.players);
	const counted = proxies.length > 0
		? proxies
		: running.filter((row) => !isProxy(row));

	return counted.reduce((sum, row) => sum + (row.players?.online ?? 0), 0);
}

/** The mean of a trend's last few measured points, or null. */
function recentMean(values: (number | null)[] | undefined, points: number): number | null {
	const measured = (values ?? []).slice(-points).filter((value): value is number => value !== null);

	return measured.length === 0
		? null
		: measured.reduce((sum, value) => sum + value, 0) / measured.length;
}

/** Everything that needs attention across the fleet, worst first. */
export function fleetReasons(rows: InstanceRow[], trends: Record<string, RowTrends>): FleetReason[] {
	const reasons: FleetReason[] = [];

	for (const row of rows) {
		if (row.state === 'auto-restarting') {
			reasons.push({ instance: row.name, severity: 'critical', text: t('web.monitor.reason.crashed') });
		}

		if (row.state === 'running' || row.state === 'starting') {
			for (const check of row.checks) {
				if (check.ok === false) {
					reasons.push({
						instance: row.name,
						severity: 'critical',
						text: t('web.monitor.reason.checkFailed', { check: check.name }),
						detail: check.detail
					});
				}
			}
		}

		if (row.state !== 'running') {
			continue;
		}

		// the last six minutes of the trend: a spike an hour ago is history
		const tps = recentMean(trends[row.name]?.series.tps, 3) ?? row.tps;

		if (tps !== null && tps < 19) {
			reasons.push({
				instance: row.name,
				severity: tps < 15 ? 'critical' : 'warning',
				text: t('web.monitor.reason.lowTps', { tps: tps.toFixed(1) })
			});
		}

		if (row.msptMean !== null && row.msptMean > 40) {
			reasons.push({
				instance: row.name,
				severity: row.msptMean > 50 ? 'critical' : 'warning',
				text: t('web.monitor.reason.slowTicks', { ms: row.msptMean.toFixed(1) })
			});
		}

		if (row.heapUsedMb !== null && row.heapMaxMb && row.heapUsedMb / row.heapMaxMb >= 0.9) {
			reasons.push({
				instance: row.name,
				severity: 'warning',
				text: t('web.monitor.reason.heapFull', { percent: String(Math.round((row.heapUsedMb / row.heapMaxMb) * 100)) })
			});
		}
	}

	return reasons.sort((left, right) => (left.severity === right.severity ? 0 : left.severity === 'critical' ? -1 : 1));
}

/** The reasons of each instance that has any, in the order `fleetReasons` gave them. */
export function reasonsByInstance(reasons: FleetReason[]): Map<string, FleetReason[]> {
	const out = new Map<string, FleetReason[]>();

	for (const reason of reasons) {
		const list = out.get(reason.instance) ?? [];

		list.push(reason);
		out.set(reason.instance, list);
	}

	return out;
}

/** How an instance is doing, as the table's Health column and the State filter read it. */
export type FleetHealth = 'critical' | 'warning' | 'changing' | 'healthy' | 'stopped';

const HEALTH_ORDER: FleetHealth[] = ['critical', 'warning', 'changing', 'healthy', 'stopped'];

/** An instance's health: the worst of its reasons, else what its state says. */
export function fleetHealth(row: InstanceRow, reasons: FleetReason[] | undefined): FleetHealth {
	if (reasons?.some((reason) => reason.severity === 'critical')) {
		return 'critical';
	}

	if (reasons && reasons.length > 0) {
		return 'warning';
	}

	if (row.state === 'running') {
		return 'healthy';
	}

	return row.state === 'stopped'
		? 'stopped'
		: 'changing';
}

/** Where a health sorts: what needs a look first, what is switched off last. */
export function healthRank(health: FleetHealth): number {
	return HEALTH_ORDER.indexOf(health);
}

/** The live hour of every instance, out of the trends the instance list carries. */
export function trendHistory(trends: Record<string, RowTrends>): FleetHistory | null {
	const names = Object.keys(trends);
	const first = trends[names[0] ?? ''];

	if (!first) {
		return null;
	}

	const samples: Record<string, HistorySample[]> = {};

	for (const name of names) {
		const trend = trends[name]!;
		const count = trend.series.cpu.length;
		const list: HistorySample[] = [];

		for (let index = 0; index < count; index++) {
			const sample: HistorySample = { t: trend.from + index * trend.step };

			for (const metric of ['cpu', 'rssMb', 'tps', 'players'] as const) {
				const value = trend.series[metric][index];

				if (value !== null && value !== undefined) {
					sample[metric] = value;
				}
			}

			list.push(sample);
		}

		samples[name] = list;
	}

	return {
		from: first.from,
		to: first.from + first.step * (first.series.cpu.length - 1),
		samples
	};
}

/**
 * One series per instance of a metric, on one shared run of timestamps so a
 * pile lines up; instances that measured nothing in the window are left out.
 * With `idleAsZero`, a moment an instance did not measure while another did
 * reads zero (a stopped server has no players and holds no memory), which is
 * what keeps a stacked chart from breaking wherever one server was off.
 */
export function fleetSeries(
	history: FleetHistory | null,
	names: string[],
	metric: string,
	unit: SeriesUnit,
	options: { scale?: number; idleAsZero?: boolean } = {}
): Series[] {
	if (!history) {
		return [];
	}

	const scale = options.scale ?? 1;
	const values = new Map<string, Map<number, number>>();
	const moments = new Set<number>();

	for (const name of names) {
		const measured = new Map<number, number>();

		for (const sample of history.samples[name] ?? []) {
			const value = sample[metric];

			if (typeof value === 'number' && Number.isFinite(value)) {
				measured.set(sample.t, value * scale);
				moments.add(sample.t);
			}
		}

		if (measured.size > 0) {
			values.set(name, measured);
		}
	}

	const grid = [...moments].sort((left, right) => left - right);
	const missing = options.idleAsZero
		? 0
		: null;

	return [...values.entries()].map(([name, measured]) => ({
		key: name,
		unit,
		points: grid.map((at): [number, number | null] => [at, measured.get(at) ?? missing])
	}));
}

function seriesMean(entry: Series): number {
	const values = entry.points.map(([, value]) => value).filter((value): value is number => value !== null);

	return values.length === 0
		? 0
		: values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** The `count` series with the highest means, and the rest (when more than one) summed into one under `OTHER_KEY`. */
export function topSeries(series: Series[], count: number): Series[] {
	const ranked = [...series].sort((left, right) => seriesMean(right) - seriesMean(left));
	const top = ranked.slice(0, count);
	const rest = ranked.slice(count);
	const first = rest[0];

	// one instance left over is drawn as itself; "other" would only hide its name
	if (!first || rest.length === 1) {
		return ranked;
	}

	const other: Series = {
		key: OTHER_KEY,
		unit: first.unit,
		points: first.points.map(([at], index): [number, number | null] => {
			const measured = rest.map((entry) => entry.points[index]?.[1] ?? null).filter((value): value is number => value !== null);

			return [at, measured.length === 0 ? null : measured.reduce((sum, value) => sum + value, 0)];
		})
	};

	return [...top, other];
}

/** The highest total of a pile at any one moment, or null when nothing was measured. */
export function peakTotal(series: Series[]): number | null {
	const length = series[0]?.points.length ?? 0;
	let peak: number | null = null;

	for (let index = 0; index < length; index++) {
		const measured = series.map((entry) => entry.points[index]?.[1] ?? null).filter((value): value is number => value !== null);

		if (measured.length === 0) {
			continue;
		}

		const total = measured.reduce((sum, value) => sum + value, 0);

		peak = peak === null
			? total
			: Math.max(peak, total);
	}

	return peak;
}

/** The lowest value any series measured, or null. */
export function lowestValue(series: Series[]): number | null {
	let lowest: number | null = null;

	for (const entry of series) {
		for (const [, value] of entry.points) {
			if (value !== null && (lowest === null || value < lowest)) {
				lowest = value;
			}
		}
	}

	return lowest;
}

/** Bucket widths the events chart snaps to, so bars start on clock boundaries. */
const EVENT_STEPS = [60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000, 10_800_000, 21_600_000, 86_400_000, 7 * 86_400_000];

/** About this many bars across the events chart. */
const EVENT_BARS = 48;

/** Events counted per stretch of the window, one series per kind, for `StackedBars`. */
export function eventBuckets(events: InstanceEvent[], from: number, to: number): Series[] {
	const wanted = Math.max(1, to - from) / EVENT_BARS;
	const step = EVENT_STEPS.find((candidate) => candidate >= wanted) ?? EVENT_STEPS.at(-1)!;
	const origin = Math.floor(from / step) * step;
	const count = Math.max(1, Math.ceil((to - origin) / step));
	const kinds = ['state', 'action', 'error'] as const;
	const counts: Record<string, number[]> = Object.fromEntries(kinds.map((kind) => [kind, new Array<number>(count).fill(0)]));

	for (const event of events) {
		const index = Math.floor((event.t - origin) / step);
		const list = counts[event.kind];

		if (list && index >= 0 && index < count) {
			list[index]!++;
		}
	}

	return kinds.map((kind) => ({
		key: kind,
		unit: 'count' as const,
		points: counts[kind]!.map((value, index): [number, number | null] => [origin + index * step, value])
	}));
}

/** Whether an event is a server going down that nobody asked for. */
export function isUnaskedStop(event: InstanceEvent): boolean {
	return event.reasonKey === 'crashed' || event.reasonKey === 'unasked';
}

/** A machine's sampled hour as one series under the machine's name. */
export function machineSeries(
	history: Record<string, MachineHealth[]>,
	unit: SeriesUnit,
	read: (sample: MachineHealth) => number | null | undefined
): Series[] {
	return Object.entries(history)
		.filter(([, samples]) => samples.length > 0)
		.map(([name, samples]) => ({
			key: name,
			unit,
			points: samples.map((sample): [number, number | null] => {
				const value = read(sample);

				return [sample.t, typeof value === 'number' && Number.isFinite(value) ? value : null];
			})
		}));
}

/** An instance row's verbs: open it at each place an operator looks next. */
export function fleetRowActions(row: InstanceRow): ContextMenuItem[] {
	const stopped = row.state === 'stopped';

	return menuGroups(
		[
			{ label: t('web.instances.glance.open'), icon: 'chartLine', action: () => goto(instanceTabPath(row.name, 'monitoring')) },
			{ label: t('web.fleet.openChecks'), icon: 'circleCheck', action: () => goto(instanceTabPath(row.name, 'checks')) },
			{ label: t('web.fleet.openLogs'), icon: 'fileLines', action: () => goto(instanceTabPath(row.name, 'logs')) },
			{
				label: t('web.fleet.openConsole'),
				icon: 'terminal',
				disabled: stopped,
				hint: stopped ? t('web.instances.glance.notRunning') : undefined,
				action: () => goto(`/instances/${encodeURIComponent(row.name)}/console`)
			}
		],
		[{ label: t('web.fleet.openInstance'), icon: 'server', action: () => goto(instanceTabPath(row.name, 'details')) }]
	);
}

/** A machine row's one verb: its own screen. */
export function machineRowActions(machine: DaemonRow): ContextMenuItem[] {
	return [{ label: t('web.fleet.openMachine'), icon: 'server', action: () => goto(`/machines/${encodeURIComponent(machine.name)}`) }];
}

export { MB };
