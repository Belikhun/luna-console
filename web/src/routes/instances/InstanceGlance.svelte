<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->
<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { fmtCpuPct } from '$lib/format';
	import ChartPanel from '$lib/components/ChartPanel.svelte';
	import TimeSeriesChart from '$lib/components/TimeSeriesChart.svelte';
	import { ChartGroup } from '$lib/components/chartgroup.svelte';
	import { fmtValue, type Series } from '$lib/components/chart';
	import type { InstanceRow } from '$lib/api';
	import { historySeries, MB, type InstanceHistory } from './details';

	/**
	 * The split panel's Monitoring tab: the sampled hour as charts sharing one
	 * crosshair; the header's button opens the instance's own tab. A right dock
	 * stacks them; a bottom dock lays them out in pairs.
	 */
	let {
		row,
		history,
		failed,
		dock
	}: {
		row: InstanceRow;
		/** null while the metrics call is out */
		history: InstanceHistory | null;
		/** The metrics call failed; its message */
		failed: string | null;
		dock: 'bottom' | 'right';
	} = $props();

	const group = new ChartGroup();

	const status = $derived(
		failed
			? 'error'
			: history === null
				? 'loading'
				: history.length === 0
					? 'empty'
					: 'ready'
	);

	/** Only the series the server measured; a chart of nothing but gaps is left out. */
	function measured(list: Series[]): Series[] {
		return list.filter((series) => series.points.some(([, value]) => value !== null));
	}

	const cpu = $derived(history ? measured([historySeries(history, 'cpu', 'percent')]) : []);
	const memory = $derived(
		history
			? measured([
				historySeries(history, 'rssMb', 'bytes', MB),
				historySeries(history, 'heapUsedMb', 'bytes', MB)
			])
			: []
	);
	const tick = $derived(
		history
			? measured([
				historySeries(history, 'msptMean', 'ms'),
				historySeries(history, 'msptMax', 'ms')
			])
			: []
	);
	const players = $derived(history ? measured([historySeries(history, 'players', 'count')]) : []);
	const tps = $derived(history ? measured([historySeries(history, 'tps', 'count')]) : []);

	function latest(list: Series[]): number | null {
		const points = list[0]?.points ?? [];

		for (let index = points.length - 1; index >= 0; index--) {
			const value = points[index]![1];

			if (value !== null) {
				return value;
			}
		}

		return null;
	}

	const window = $derived.by(() => {
		const first = history?.[0]?.t;
		const last = history?.at(-1)?.t;

		return first !== undefined && last !== undefined
			? { from: first, to: last }
			: { from: undefined, to: undefined };
	});
</script>

{#snippet panel(title: string, headline: string | undefined, series: Series[], styles: Record<string, { label: string; dashed?: boolean }>, options: { max?: number; format?: (value: number) => string; mode?: 'line' | 'area' })}
	<ChartPanel
		{title}
		description={t('web.instances.glance.lastHour')}
		{headline}
		status={status === 'ready' && series.length === 0 ? 'empty' : status}
		emptyTitle={t('web.monitoring.empty.noSamples')}
		emptyText={row.state === 'running' ? undefined : t('web.instances.glance.notRunning')}
		error={failed ?? undefined}
		height={8}
	>
		<TimeSeriesChart
			{series}
			label={title}
			{styles}
			mode={options.mode ?? 'line'}
			from={window.from}
			to={window.to}
			height={8}
			max={options.max}
			formatValue={options.format}
			{group}
			legend={series.length > 1}
		/>
	</ChartPanel>
{/snippet}

<div class="glance" class:stacked={dock === 'right'}>
	{@render panel(
		t('web.instances.cpuUtilization'),
		latest(cpu) === null ? undefined : fmtCpuPct(latest(cpu)!),
		cpu,
		{ cpu: { label: t('web.instances.glance.cpu') } },
		{ mode: 'area', format: fmtCpuPct }
	)}
	{@render panel(
		t('web.instances.glance.memory'),
		latest(memory) === null ? undefined : fmtValue(latest(memory), 'bytes'),
		memory,
		{
			rssMb: { label: t('web.instances.residentMemory') },
			heapUsedMb: { label: t('web.instances.jvmHeap') }
		},
		{}
	)}
	{#if tps.length > 0 || tick.length > 0}
		{@render panel(
			t('web.instances.tickDuration'),
			latest(tick) === null ? undefined : `${latest(tick)!.toFixed(1)} ms`,
			tick,
			{
				msptMean: { label: t('web.instances.glance.mean') },
				msptMax: { label: t('web.instances.glance.peak'), dashed: true }
			},
			{ format: (value) => `${value.toFixed(1)} ms` }
		)}
	{/if}
	{@render panel(
		t('web.instances.colPlayers'),
		latest(players) === null ? undefined : String(latest(players)),
		players,
		{ players: { label: t('web.instances.colPlayers') } },
		{ mode: 'area', format: (value) => String(Math.round(value)) }
	)}
</div>

<style lang="scss">
	.glance {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
		gap: 1rem;

		&.stacked {
			grid-template-columns: 1fr;
		}
	}
</style>
