<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->
<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { fmtBytes, fmtCpuPct } from '$lib/format';
	import ChartPanel from '$lib/components/ChartPanel.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import StatGrid from '$lib/components/StatGrid.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import TimeSeriesChart from '$lib/components/TimeSeriesChart.svelte';
	import { ChartGroup } from '$lib/components/chartgroup.svelte';
	import { diskPct, latencyTone, memPct, swapPct } from '$lib/daemons';
	import type { ChartThreshold, Series, SeriesStyle, SeriesUnit } from '$lib/components/chart';
	import type { DaemonRow, HealthSample } from '$client/daemon';
	import { MB, healthSeries, measured, peakOf, shareTone, sparkSeries } from '../machines';

	/**
	 * A machine's Monitoring tab: where each figure stands now, then the hour
	 * its daemon keeps as charts on one shared crosshair, down to which instance
	 * the memory and the processor time went to.
	 */
	let {
		row,
		history,
		loaded = true
	}: {
		row: DaemonRow;
		/** The machine's sampled hour, oldest first */
		history: HealthSample[];
		/** The first read has landed */
		loaded?: boolean;
	} = $props();

	const group = new ChartGroup();

	const HEIGHT = 12;

	const health = $derived(row.health);
	const follower = $derived(row.mode === 'follower');

	const bounds = $derived({
		from: history[0]?.t,
		to: history.at(-1)?.t
	});

	// -- the hour as series -------------------------------------------------------------

	const cpu = $derived([healthSeries(history, 'cpu', 'percent', (sample) => sample.cpuPct)]);

	const load = $derived([
		healthSeries(history, 'load1', 'count', (sample) => sample.load1),
		healthSeries(history, 'load5', 'count', (sample) => sample.load5),
		healthSeries(history, 'load15', 'count', (sample) => sample.load15)
	]);

	// undefined rather than 0 for a sample with no swap to report, so the line
	// breaks where the measurement is missing instead of drawing a floor
	const memory = $derived(
		[
			healthSeries(history, 'used', 'bytes', (sample) => sample.memUsedMb * MB),
			healthSeries(history, 'instances', 'bytes', (sample) => sample.instancesRssMb * MB),
			healthSeries(history, 'swap', 'bytes', (sample) => (sample.swapTotalMb ? (sample.swapUsedMb ?? 0) * MB : undefined))
		].filter(measured)
	);

	const disk = $derived([
		healthSeries(history, 'disk', 'percent', (sample) =>
			sample.diskTotalBytes > 0
				? (sample.diskUsedBytes / sample.diskTotalBytes) * 100
				: undefined
		)
	]);

	const latency = $derived([healthSeries(history, 'latency', 'ms', (sample) => sample.latencyMs)]);

	/** Every instance the hour measured, the ones holding the most memory now first. */
	const instanceNames = $derived.by(() => {
		const names = new Set<string>();

		for (const sample of history) {
			for (const name of Object.keys(sample.instanceRssMb ?? {})) {
				names.add(name);
			}
		}

		const now = health?.instanceRssMb ?? {};

		return [...names].sort((left, right) => (now[right] ?? 0) - (now[left] ?? 0));
	});

	// a moment an instance was not running reads zero: it held no memory, and a
	// pile that broke there would lose every instance above it
	const instanceMemory = $derived(
		instanceNames.map((name) => healthSeries(history, name, 'bytes', (sample) => (sample.instanceRssMb?.[name] ?? 0) * MB))
	);

	const instanceCpu = $derived(
		instanceNames
			.map((name) => healthSeries(history, name, 'percent', (sample) => sample.instanceCpu?.[name]))
			.filter(measured)
	);

	const instanceStyles = $derived<Record<string, SeriesStyle>>(
		Object.fromEntries(instanceNames.map((name) => [name, { label: name }]))
	);

	const memoryStyles = $derived<Record<string, SeriesStyle>>({
		used: { label: t('web.machineDetail.memoryUsed') },
		instances: { label: t('web.machineDetail.instanceMemory') },
		swap: { label: t('web.fleet.swap'), dashed: true }
	});

	const loadStyles = $derived<Record<string, SeriesStyle>>({
		load1: { label: t('web.machineDetail.loadMinutes', { minutes: '1' }) },
		load5: { label: t('web.machineDetail.loadMinutes', { minutes: '5' }) },
		load15: { label: t('web.machineDetail.loadMinutes', { minutes: '15' }), dashed: true }
	});

	const memoryLimit: ChartThreshold | undefined = $derived(
		health
			? { value: health.memTotalMb * MB, label: t('web.machineDetail.installed'), tone: 'critical' }
			: undefined
	);

	const coreLimit: ChartThreshold | undefined = $derived(
		health
			? { value: health.cpuCores, label: t('web.machineDetail.cores', { cores: String(health.cpuCores) }), tone: 'warning' }
			: undefined
	);

	// -- the tiles ----------------------------------------------------------------------

	const cpuPeak = $derived(peakOf(history, (sample) => sample.cpuPct));
	const latencyPeak = $derived(peakOf(history, (sample) => sample.latencyMs));
	const memoryShare = $derived(memPct(health));
	const swapShare = $derived(swapPct(health));
	const diskShare = $derived(diskPct(health));

	const fmtPercent = (value: number): string => `${value.toFixed(1)}%`;
	const fmtLoad = (value: number): string => value.toFixed(2);
	const fmtMs = (value: number): string => `${Math.round(value)} ms`;

	function spark(key: string, unit: SeriesUnit, read: (sample: HealthSample) => number | null | undefined): Series | undefined {
		return sparkSeries(history, key, unit, read);
	}

	function share(percent: number | null): number | undefined {
		return percent === null
			? undefined
			: percent / 100;
	}

	function shareToneOf(percent: number | null): 'default' | 'warning' | 'critical' {
		return shareTone(percent === null ? null : percent / 100);
	}

	const latencyToneNow = $derived.by((): 'default' | 'warning' | 'critical' => {
		const tone = latencyTone(row.latencyMs);

		if (tone === 'danger') {
			return 'critical';
		}

		return tone === 'warning'
			? 'warning'
			: 'default';
	});

	function chartStatus(series: Series[]): 'ready' | 'loading' | 'empty' {
		if (!loaded) {
			return 'loading';
		}

		return series.some(measured)
			? 'ready'
			: 'empty';
	}

	interface ChartOptions {
		headline?: string;
		info?: string;
		mode?: 'line' | 'area' | 'stacked';
		max?: number;
		threshold?: ChartThreshold;
		format?: (value: number) => string;
	}
</script>

{#snippet chart(title: string, series: Series[], styles: Record<string, SeriesStyle>, options: ChartOptions)}
	<ChartPanel
		{title}
		description={t('web.instances.glance.lastHour')}
		info={options.info}
		headline={options.headline}
		status={chartStatus(series)}
		emptyTitle={t('web.monitoring.empty.noSamples')}
		emptyText={t('web.fleet.machinesEmptyHint')}
		height={HEIGHT}
	>
		<TimeSeriesChart
			{series}
			label={title}
			{styles}
			mode={options.mode ?? 'line'}
			from={bounds.from}
			to={bounds.to}
			height={HEIGHT}
			max={options.max}
			threshold={options.threshold}
			formatValue={options.format}
			{group}
			legend={series.length > 1}
		/>
	</ChartPanel>
{/snippet}

<div class="monitoring">
	{#if row.state === 'offline'}
		<Flash kind="info">{t('web.machineDetail.offlineFigures')}</Flash>
	{/if}

	<StatGrid min={10}>
		<StatTile
			label={t('web.machines.colCpu')}
			value={health?.cpuPct ?? null}
			unit="percent"
			formatValue={fmtPercent}
			secondary={cpuPeak === null ? undefined : t('web.fleet.peak', { value: fmtPercent(cpuPeak) })}
			tone={shareToneOf(health?.cpuPct ?? null)}
			spark={spark('cpu', 'percent', (sample) => sample.cpuPct)}
			loading={!loaded}
		/>
		<StatTile
			label={t('web.machineDetail.loadAverage')}
			value={health?.load1 ?? null}
			formatValue={fmtLoad}
			secondary={health ? t('web.instances.detail.ofCores', { cores: String(health.cpuCores) }) : undefined}
			tone={health && health.load1 > health.cpuCores ? 'warning' : 'default'}
			info={t('web.machineDetail.loadInfo')}
			spark={spark('load', 'count', (sample) => sample.load1)}
			loading={!loaded}
		/>
		<StatTile
			label={t('web.fleet.memory')}
			value={health ? health.memUsedMb * MB : null}
			unit="bytes"
			secondary={health ? t('web.instances.detail.ofMax', { max: fmtBytes(health.memTotalMb * MB) }) : undefined}
			progress={share(memoryShare)}
			tone={shareToneOf(memoryShare)}
			loading={!loaded}
		/>
		<!-- swap sits beside memory rather than inside it: a host that looks comfortable
		     on memory while paging steadily is exactly the case worth seeing -->
		<StatTile
			label={t('web.fleet.swap')}
			value={health?.swapTotalMb ? (health.swapUsedMb ?? 0) * MB : null}
			unit="bytes"
			secondary={health?.swapTotalMb
				? t('web.instances.detail.ofMax', { max: fmtBytes(health.swapTotalMb * MB) })
				: health
					? t('web.machines.noSwap')
					: undefined}
			progress={share(swapShare)}
			tone={shareToneOf(swapShare)}
			loading={!loaded}
		/>
		<StatTile
			label={t('web.fleet.disk')}
			value={health && health.diskTotalBytes > 0 ? health.diskUsedBytes : null}
			unit="bytes"
			secondary={health && health.diskTotalBytes > 0 ? t('web.instances.detail.ofMax', { max: fmtBytes(health.diskTotalBytes) }) : undefined}
			progress={share(diskShare)}
			tone={shareToneOf(diskShare)}
			loading={!loaded}
		/>
		<StatTile
			label={t('web.machineDetail.instanceMemory')}
			value={health ? health.instancesRssMb * MB : null}
			unit="bytes"
			secondary={health ? t('web.machineDetail.acrossInstances', { count: String(Object.keys(health.instanceRssMb).length) }) : undefined}
			spark={spark('instances', 'bytes', (sample) => sample.instancesRssMb * MB)}
			loading={!loaded}
		/>
		{#if follower}
			<StatTile
				label={t('web.fleet.latency')}
				value={row.latencyMs}
				unit="ms"
				formatValue={fmtMs}
				secondary={latencyPeak === null ? undefined : t('web.fleet.peak', { value: fmtMs(latencyPeak) })}
				tone={latencyToneNow}
				info={t('web.machineDetail.latencyInfo')}
				spark={spark('latency', 'ms', (sample) => sample.latencyMs)}
				loading={!loaded}
			/>
		{/if}
	</StatGrid>

	<div class="charts">
		{@render chart(t('web.machineDetail.cpuUtilization'), cpu, { cpu: { label: t('web.machines.colCpu') } }, {
			headline: health ? fmtPercent(health.cpuPct) : undefined,
			mode: 'area',
			max: 100,
			format: fmtPercent
		})}
		{@render chart(t('web.machineDetail.loadAverage'), load, loadStyles, {
			headline: health ? fmtLoad(health.load1) : undefined,
			threshold: coreLimit,
			format: fmtLoad,
			info: t('web.machineDetail.loadInfo')
		})}
		{@render chart(t('web.fleet.memory'), memory, memoryStyles, {
			headline: health ? fmtBytes(health.memUsedMb * MB) : undefined,
			threshold: memoryLimit
		})}
		{@render chart(t('web.machineDetail.diskUsed'), disk, { disk: { label: t('web.fleet.disk') } }, {
			headline: diskShare === null ? undefined : `${diskShare}%`,
			mode: 'area',
			max: 100,
			format: fmtPercent
		})}
		{@render chart(t('web.machineDetail.memoryByInstance'), instanceMemory, instanceStyles, {
			headline: health ? fmtBytes(health.instancesRssMb * MB) : undefined,
			mode: 'stacked'
		})}
		{@render chart(t('web.machineDetail.cpuByInstance'), instanceCpu, instanceStyles, {
			format: fmtCpuPct,
			info: t('web.monitor.cpuInfo')
		})}
		{#if follower}
			{@render chart(t('web.fleet.latency'), latency, { latency: { label: t('web.fleet.latency') } }, {
				headline: row.latencyMs === null ? undefined : fmtMs(row.latencyMs),
				mode: 'area',
				format: fmtMs,
				info: t('web.machineDetail.latencyInfo')
			})}
		{/if}
	</div>
</div>

<style lang="scss">
	.monitoring {
		display: flex;
		flex-direction: column;
		gap: 1rem;

		// the kit's flash carries a bottom margin of its own; the column's gap is the spacing here
		> :global(.flash) {
			margin-bottom: 0;
		}
	}

	// two across; a chart left alone on the last row takes the row
	.charts {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem;

		> :global(:last-child:nth-child(odd)) {
			grid-column: 1 / -1;
		}

		@include below($bp-medium) {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
