// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * What the machines list and a machine's own screen both work out from a
 * daemon's row and its sampled hour: the tabs and their addresses, why a verb
 * is refused, and the hour as series for the chart kit. Nothing here renders.
 */

import { t } from '$lib/i18n.svelte';
import { checksFailed, checksPassed } from '$lib/daemons';
import type { DaemonRow, HealthSample } from '$client/daemon';
import type { Series, SeriesUnit } from '$lib/components/chart';
import type { DistributionSegment } from '$lib/components/distribution';
import type { StatusDetailRow } from '$lib/components/statusbadge';

/** A machine screen's tabs, in order; the first is the default. */
export const MACHINE_TABS = ['details', 'monitoring', 'instances', 'checks', 'pools', 'environment', 'events'] as const;

export type MachineTab = (typeof MACHINE_TABS)[number];

/** The icon a button leading to each tab carries. */
export const MACHINE_TAB_ICONS: Record<MachineTab, string> = {
	details: 'circleInfo',
	monitoring: 'chartLine',
	instances: 'cube',
	checks: 'listCheck',
	pools: 'sitemap',
	environment: 'key',
	events: 'clockRotateLeft'
};

export const MB = 1024 * 1024;

/** How many points a table's small chart draws out of the sampled hour. */
const SPARK_POINTS = 60;

/** The tab an address asks for; the first when it names none or an unknown one. */
export function parseMachineTab(asked: string | null): MachineTab {
	return (MACHINE_TABS as readonly string[]).includes(asked ?? '')
		? (asked as MachineTab)
		: 'details';
}

/** A machine's screen on one of its tabs. */
export function machineHref(name: string, tab: MachineTab = 'details'): string {
	const base = `/machines/${encodeURIComponent(name)}`;

	return tab === 'details'
		? base
		: `${base}?tab=${tab}`;
}

/** The role as a word: primary or follower. */
export function roleLabel(row: DaemonRow): string {
	return row.mode === 'primary'
		? t('web.fleet.primary')
		: t('web.fleet.follower');
}

/**
 * Why this machine cannot be handed a new binary from here, or undefined when
 * it can. A quarantined follower can: the upgrade is the one request its link
 * still accepts, and the way it rejoins the cluster.
 */
export function upgradeRefusal(row: DaemonRow): string | undefined {
	if (row.mode !== 'follower') {
		return t('web.machines.refusal.primarySource');
	}

	if (row.state === 'offline') {
		return t('web.machines.refusal.notConnected');
	}

	return undefined;
}

/**
 * Why this machine's registration cannot be removed, or undefined when it can.
 * A follower still holding a link would register again on its next reconnect.
 */
export function removeRefusal(row: DaemonRow): string | undefined {
	if (row.mode !== 'follower') {
		return t('web.machines.refusal.primaryRegistration');
	}

	if (row.state !== 'offline') {
		return t('web.machines.refusal.stillConnected');
	}

	if (row.instances.length > 0) {
		return t('web.machines.refusal.ownsInstances', { instances: row.instances.join(', ') });
	}

	return undefined;
}

/** How many of the machine's instances its daemon reports as running. */
export function runningCount(row: DaemonRow): number {
	const states = row.health?.states ?? {};

	return row.instances.filter((name) => states[name] === 'running').length;
}

/** The machine's instances by state, for a distribution bar. */
export function instanceSegments(rows: DaemonRow[]): DistributionSegment[] {
	let running = 0;
	let changing = 0;
	let stopped = 0;

	for (const row of rows) {
		const states = row.health?.states ?? {};

		for (const name of row.instances) {
			const state = states[name] ?? 'stopped';

			if (state === 'running') {
				running++;
			} else if (state === 'stopped' || state === 'unknown') {
				stopped++;
			} else {
				changing++;
			}
		}
	}

	return [
		{ key: 'running', label: t('web.status.running'), count: running, color: 'var(--success)' },
		{ key: 'changing', label: t('web.fleet.changing'), count: changing, color: 'var(--warning)' },
		{ key: 'stopped', label: t('web.status.stopped'), count: stopped, color: 'var(--text-disabled)' }
	];
}

/** The badge state of one health check; a check that does not apply is neither. */
export function checkState(check: { ok: boolean | undefined }): string {
	if (check.ok === undefined) {
		return 'unknown';
	}

	return check.ok
		? 'passed'
		: 'failed';
}

/** A machine's checks as the rows of a status badge's popover. */
export function checkRows(row: DaemonRow): StatusDetailRow[] {
	return row.checks.map((check) => ({
		state: checkState(check),
		label: check.name,
		detail: check.detail
	}));
}

/** "5/6 passed", the summary a checks badge wears. */
export function checksLabel(row: DaemonRow): string {
	return t('web.machines.checksPassed', {
		passed: String(checksPassed(row)),
		total: String(row.checks.length)
	});
}

/** The badge state of a machine's checks as a whole. */
export function checksState(row: DaemonRow): string {
	return checksFailed(row) > 0
		? 'failed'
		: 'passed';
}

function numberOrNull(value: number | null | undefined): number | null {
	return typeof value === 'number' && Number.isFinite(value)
		? value
		: null;
}

/** The sampled hour of one figure, a point per sample. */
export function healthSeries(
	history: HealthSample[],
	key: string,
	unit: SeriesUnit,
	read: (sample: HealthSample) => number | null | undefined
): Series {
	return {
		key,
		unit,
		points: history.map((sample): [number, number | null] => [sample.t, numberOrNull(read(sample))])
	};
}

/** Whether a series measured anything at all. */
export function measured(series: Series): boolean {
	return series.points.some(([, value]) => value !== null);
}

/**
 * The sampled hour thinned to about a minute a point, each the mean of the
 * samples it stands for, which is all a chart a few rem wide can show.
 * Undefined when the hour measured nothing, so the cell draws no chart.
 */
export function sparkSeries(
	history: HealthSample[] | undefined,
	key: string,
	unit: SeriesUnit,
	read: (sample: HealthSample) => number | null | undefined
): Series | undefined {
	if (!history || history.length === 0) {
		return undefined;
	}

	const size = Math.max(1, Math.ceil(history.length / SPARK_POINTS));
	const points: [number, number | null][] = [];

	for (let start = 0; start < history.length; start += size) {
		const bucket = history.slice(start, start + size);
		const values = bucket.map((sample) => numberOrNull(read(sample))).filter((value): value is number => value !== null);
		const mean = values.length === 0
			? null
			: values.reduce((sum, value) => sum + value, 0) / values.length;

		points.push([bucket[0]!.t, mean]);
	}

	const series: Series = { key, unit, points };

	return measured(series)
		? series
		: undefined;
}

/** The highest value a figure reached in the sampled hour, or null. */
export function peakOf(history: HealthSample[], read: (sample: HealthSample) => number | null | undefined): number | null {
	let peak: number | null = null;

	for (const sample of history) {
		const value = numberOrNull(read(sample));

		if (value !== null && (peak === null || value > peak)) {
			peak = value;
		}
	}

	return peak;
}

/** "12.4 GB" out of a figure in megabytes. */
export function fmtMbAsGb(mb: number): string {
	return `${(mb / 1024).toFixed(1)} GB`;
}

/** The tone a share of a capacity wears: quiet until it is nearly full. */
export function shareTone(share: number | null): 'default' | 'warning' | 'critical' {
	if (share === null || share < 0.8) {
		return 'default';
	}

	return share >= 0.92
		? 'critical'
		: 'warning';
}

/** The colour of a strip cell's bar for a share of a capacity, 0 to 1. */
export function shareColor(share: number): string {
	if (share >= 0.92) {
		return 'var(--error)';
	}

	return share >= 0.8
		? 'var(--warning)'
		: 'var(--success)';
}
