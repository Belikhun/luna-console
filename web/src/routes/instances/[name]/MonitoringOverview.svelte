<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { t } from '$lib/i18n.svelte';
	import { fmtCpuPct, fmtDuration } from '$lib/format';
	import { tooltip } from '$lib/tooltip.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import ChartPanel from '$lib/components/ChartPanel.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import SegmentedControl from '$lib/components/SegmentedControl.svelte';
	import Select from '$lib/components/Select.svelte';
	import StackedBars from '$lib/components/StackedBars.svelte';
	import StatGrid from '$lib/components/StatGrid.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import TimeSeriesChart from '$lib/components/TimeSeriesChart.svelte';
	import UptimeTimeline from '$lib/components/UptimeTimeline.svelte';
	import { ChartGroup } from '$lib/components/chartgroup.svelte';
	import { fmtWhen } from '$lib/components/events';
	import { INSTANCE_TAB_LABELS, instanceTabPath } from '$lib/components/instancetabs';
	import { METRICS_RANGES, type MetricsRange } from '$shared/metricsrange';
	import type { ChartBand, ChartMarker, ChartThreshold, Series, SeriesStyle } from '$lib/components/chart';
	import type { UptimeDayPoint } from '$lib/components/uptime';
	import {
		historySeries,
		MB,
		msptTone,
		tpsTone,
		uptimeWindow,
		type InstanceEvent,
		type InstanceHistory
	} from '../details';
	import {
		attentionReasons,
		downtimeBands,
		downtimeMs,
		eventMarkers,
		fmtStep,
		stopBreakdown,
		windowStats,
		type AttentionInput,
		type MonitoringView,
		type WindowStats
	} from './monitoring';

	/**
	 * The instance's Monitoring tab: a view switch and the one window every chart
	 * of the open view reads, over one view at a time. Overview is the figures
	 * that matter and what needs attention; Performance is the tick loop and the
	 * world; Resources is the process; Uptime is the long record and the stops.
	 * Every chart shares one crosshair, shades the time the server was not
	 * running, marks the daemon's events, and zooms on a drag.
	 */
	let {
		inst,
		views,
		history,
		events,
		uptimeDays,
		range,
		from,
		to,
		step = null,
		view,
		loaded = true,
		pending = false,
		error,
		zoomed = false,
		onrange,
		onzoom,
		onreset,
		onretry,
		performance,
		resources
	}: {
		inst: AttentionInput & { name: string; external?: string | null };
		/** The views this instance has, in order (`monitoringViews`) */
		views: MonitoringView[];
		history: InstanceHistory;
		events: InstanceEvent[];
		/** The long record, oldest first; null until the first metrics call lands */
		uptimeDays: UptimeDayPoint[] | null;
		/** The window shown; `1h` is the daemon's live hour, the rest the persisted record */
		range: MetricsRange;
		/** The window's bounds, when the record was read; the live hour spans its samples */
		from?: number;
		to?: number;
		/** Milliseconds one point of the record covers; null for the live samples */
		step?: number | null;
		view: MonitoringView;
		/** The first read has landed */
		loaded?: boolean;
		/** Another window is being read; the drawing stays and dims */
		pending?: boolean;
		/** Why the last read failed */
		error?: string;
		/** The window is one a drag picked, so it does not end now */
		zoomed?: boolean;
		onrange: (range: MetricsRange) => void;
		onzoom: (from: number, to: number) => void;
		onreset: () => void;
		onretry: () => void;
		/** The live panels the Performance view ends with (server load, worlds) */
		performance?: Snippet;
		/** The live panels the Resources view ends with (JVM, threads) */
		resources?: Snippet;
	} = $props();

	const group = new ChartGroup();

	const HEIGHT = 12;

	// a failed read shows nothing rather than the previous window under the new one's name
	const samples: InstanceHistory = $derived(error ? [] : history);
	const running = $derived(inst.state === 'running');

	const bounds = $derived.by(() => {
		if (from !== undefined && to !== undefined) {
			return { from, to };
		}

		const first = samples[0]?.t;
		const last = samples.at(-1)?.t;

		return first !== undefined && last !== undefined
			? { from: first, to: last }
			: { from: undefined, to: undefined };
	});

	/** Only what the server measured; a chart of nothing but gaps is left out. */
	function measured(list: Series[]): Series[] {
		return list.filter((series) => series.points.some(([, value]) => value !== null));
	}

	const cpu = $derived(measured([historySeries(samples, 'cpu', 'percent')]));
	const memory = $derived(
		measured([
			historySeries(samples, 'rssMb', 'bytes', MB),
			historySeries(samples, 'heapCommittedMb', 'bytes', MB),
			historySeries(samples, 'heapUsedMb', 'bytes', MB),
			historySeries(samples, 'nonHeapMb', 'bytes', MB)
		])
	);
	const tps = $derived(measured([historySeries(samples, 'tps', 'count')]));
	const tick = $derived(
		measured([
			historySeries(samples, 'msptMean', 'ms'),
			historySeries(samples, 'msptMax', 'ms')
		])
	);
	const apdex = $derived(measured([historySeries(samples, 'apdex', 'count')]));
	const players = $derived(measured([historySeries(samples, 'players', 'count')]));
	const gc = $derived(measured([historySeries(samples, 'gcMs', 'ms')]));
	const threads = $derived(measured([historySeries(samples, 'threads', 'count')]));
	const world = $derived(
		measured([
			historySeries(samples, 'chunks', 'count'),
			historySeries(samples, 'tickingEntities', 'count'),
			historySeries(samples, 'nonTickingEntities', 'count')
		])
	);

	const cpuStats = $derived(windowStats(samples, 'cpu'));
	const rssStats = $derived(windowStats(samples, 'rssMb'));
	const heapStats = $derived(windowStats(samples, 'heapUsedMb'));
	const heapMax = $derived(windowStats(samples, 'heapMaxMb').last);
	const tpsStats = $derived(windowStats(samples, 'tps'));
	const msptStats = $derived(windowStats(samples, 'msptMean'));
	const worstTick = $derived(windowStats(samples, 'msptMax'));
	const playerStats = $derived(windowStats(samples, 'players'));
	const chunkStats = $derived(windowStats(samples, 'chunks'));
	const entityStats = $derived(windowStats(samples, 'tickingEntities'));
	const gcStats = $derived(windowStats(samples, 'gcMs'));
	const threadStats = $derived(windowStats(samples, 'threads'));

	const uptime7 = $derived(uptimeDays ? uptimeWindow(uptimeDays, 7) : null);
	const uptime30 = $derived(uptimeDays ? uptimeWindow(uptimeDays, 30) : null);
	const uptime90 = $derived(uptimeDays ? uptimeWindow(uptimeDays, 90) : null);
	const stops30 = $derived(uptime30 ? uptime30.days.reduce((sum, day) => sum + (day.stops ?? 0), 0) : 0);

	const shownEvents: InstanceEvent[] = $derived(error ? [] : events);
	const reasons = $derived(attentionReasons(inst, history, events));
	const markers: ChartMarker[] = $derived(eventMarkers(shownEvents, bounds.from, bounds.to));
	const bands: ChartBand[] = $derived(downtimeBands(shownEvents, samples, bounds.from, bounds.to));
	const stops = $derived(stopBreakdown(shownEvents, bounds.from, bounds.to));
	const stopCount = $derived(stops.totals.requested + stops.totals.crashed + stops.totals.unasked);
	const unplanned = $derived(stops.totals.crashed + stops.totals.unasked);

	const memoryStyles: Record<string, SeriesStyle> = $derived({
		rssMb: { label: t('web.instanceDetail.memoryRss') },
		heapCommittedMb: { label: t('web.monitor.heapCommitted'), dashed: true },
		heapUsedMb: { label: t('web.instanceDetail.jvmHeap') },
		nonHeapMb: { label: t('web.instanceDetail.jvmNonHeap') }
	});

	const stopStyles: Record<string, SeriesStyle> = $derived({
		requested: { label: t('web.monitor.cause.requested'), color: 'var(--link)' },
		crashed: { label: t('web.monitor.cause.crashed'), color: 'var(--error)' },
		unasked: { label: t('web.monitor.cause.unasked'), color: 'var(--warning)' }
	});

	const tickBudget: ChartThreshold = $derived({ value: 50, label: t('web.monitor.tickBudget'), tone: 'warning' });
	const heapLimit: ChartThreshold | undefined = $derived(
		heapMax === null
			? undefined
			: { value: heapMax * MB, label: t('web.monitor.heapLimit') }
	);

	/** A tile wears only the bad tones; a healthy figure stays plain. */
	function tileTone(tone: 'good' | 'warning' | 'critical'): 'default' | 'warning' | 'critical' {
		return tone === 'good'
			? 'default'
			: tone;
	}

	/**
	 * What a tile leads with. A window that ends now shows where the figure
	 * stands; one a drag picked ends in the past, so "latest" would mean nothing
	 * and the average over it is shown instead.
	 */
	function lead(stats: WindowStats): number | null {
		return zoomed
			? stats.mean
			: stats.last;
	}

	/** The line under a tile's figure: how far it went in the window. */
	function extreme(value: number | null, format: (value: number) => string, low: boolean = false): string | undefined {
		if (value === null) {
			return undefined;
		}

		const kind = low
			? 'Low'
			: 'Peak';

		return zoomed
			? t(`web.monitor.stat.mean${kind}`, { value: format(value) })
			: t(`web.monitor.stat.${kind.toLowerCase()}`, { value: format(value) });
	}

	const fmtGb = (value: number): string => `${(value / 1024).toFixed(2)} GB`;
	const fmtMs = (value: number): string => `${value.toFixed(1)} ms`;
	const fmtWhole = (value: number): string => Math.round(value).toLocaleString();
	const fmtTps = (value: number): string => value.toFixed(2);
	const fmtUptime = (value: number): string => `${Number(value.toFixed(2))}%`;

	function uptimeTone(pct: number | null | undefined): 'default' | 'warning' | 'critical' {
		if (pct === null || pct === undefined || pct >= 99) {
			return 'default';
		}

		return pct >= 90
			? 'warning'
			: 'critical';
	}

	const rangeOptions = $derived(METRICS_RANGES.map((id) => ({ id, label: t(`web.monitor.ranges.${id}`) })));
	const viewOptions = $derived(views.map((id) => ({ id, label: t(`web.monitor.view.${id}`) })));

	const rangeLabel = $derived(
		zoomed && bounds.from !== undefined && bounds.to !== undefined
			? t('web.monitor.zoomWindow', { from: fmtWhen(bounds.from), to: fmtWhen(bounds.to) })
			: t(`web.monitor.rangeLabel.${range}`)
	);

	const live = $derived(range === '1h' && !zoomed && running && !error);
	const resolution = $derived(
		step === null
			? t('web.monitor.resolution.live')
			: t('web.monitor.resolution.record', { step: fmtStep(step) })
	);

	/** The address of another view, keeping the window. */
	function viewHref(next: MonitoringView): string {
		const url = new URL(page.url);

		if (next === 'overview') {
			url.searchParams.delete('view');
		} else {
			url.searchParams.set('view', next);
		}

		return `${url.pathname}${url.search}`;
	}

	function setView(next: string): void {
		void goto(viewHref(next as MonitoringView), { replaceState: true, noScroll: true, keepFocus: true });
	}

	function chartStatus(series: Series[]): 'ready' | 'loading' | 'empty' {
		if (!loaded) {
			return 'loading';
		}

		return series.length === 0
			? 'empty'
			: 'ready';
	}

	const uptimeStatus = $derived.by((): 'ready' | 'loading' | 'empty' => {
		if (!uptimeDays) {
			return 'loading';
		}

		return uptimeDays.length === 0
			? 'empty'
			: 'ready';
	});

	const stopsStatus = $derived.by((): 'ready' | 'loading' | 'empty' => {
		if (!loaded) {
			return 'loading';
		}

		return stopCount === 0
			? 'empty'
			: 'ready';
	});

	const unplannedTone = $derived.by((): 'default' | 'warning' | 'critical' => {
		if (stops.totals.crashed > 0) {
			return 'critical';
		}

		return unplanned > 0
			? 'warning'
			: 'default';
	});

	interface ChartOptions {
		headline?: string;
		info?: string;
		mode?: 'line' | 'area';
		max?: number;
		threshold?: ChartThreshold;
		format?: (value: number) => string;
		/** The view that says more about this figure */
		more?: MonitoringView;
		/** Series the legend starts with switched off */
		hidden?: string[];
	}
</script>

{#snippet chart(title: string, series: Series[], styles: Record<string, SeriesStyle>, options: ChartOptions)}
	<ChartPanel
		{title}
		info={options.info}
		headline={options.headline}
		href={options.more ? viewHref(options.more) : undefined}
		hrefLabel={options.more ? t(`web.monitor.view.${options.more}`) : undefined}
		status={chartStatus(series)}
		stale={pending}
		emptyTitle={t('web.monitoring.empty.noSamples')}
		emptyText={running ? undefined : t('web.instances.glance.notRunning')}
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
			{markers}
			{bands}
			{group}
			{onzoom}
			legend={series.length > 1}
			initialHidden={options.hidden}
		/>
	</ChartPanel>
{/snippet}

{#snippet cpuChart(more?: MonitoringView)}
	{@render chart(t('web.instanceDetail.cpuUtilization'), cpu, { cpu: { label: t('web.instances.glance.cpu') } }, {
		headline: cpuStats.last === null ? undefined : fmtCpuPct(cpuStats.last),
		mode: 'area',
		format: fmtCpuPct,
		info: t('web.monitor.cpuInfo'),
		more
	})}
{/snippet}

{#snippet memoryChart(more?: MonitoringView)}
	{@render chart(t('web.instances.glance.memory'), memory, memoryStyles, {
		headline: rssStats.last === null ? undefined : fmtGb(rssStats.last),
		threshold: heapLimit,
		info: t('web.monitor.memoryInfo'),
		more
	})}
{/snippet}

{#snippet tickChart(more?: MonitoringView)}
	{@render chart(t('web.instanceDetail.tickDuration'), tick, {
		msptMean: { label: t('web.instances.glance.mean') },
		msptMax: { label: t('web.instances.glance.peak'), dashed: true }
	}, {
		headline: msptStats.last === null ? undefined : fmtMs(msptStats.last),
		threshold: tickBudget,
		format: fmtMs,
		info: t('web.monitor.tickInfo'),
		more,
		// on the overview the mean leads: one stalled tick of seconds flattens it
		// otherwise, and the legend brings the worst tick back
		hidden: more ? ['msptMax'] : undefined
	})}
{/snippet}

{#snippet playersChart()}
	{@render chart(t('web.instanceDetail.playersOnline'), players, { players: { label: t('web.instances.colPlayers') } }, {
		headline: playerStats.last === null ? undefined : fmtWhole(playerStats.last),
		mode: 'area',
		format: fmtWhole
	})}
{/snippet}

{#snippet uptimePanel(more: boolean)}
	<ChartPanel
		title={t('web.instanceDetail.uptimeHistory')}
		info={t('web.instanceDetail.uptimeHistoryDesc')}
		headline={uptime90?.pct == null ? undefined : fmtUptime(uptime90.pct)}
		href={more ? viewHref('uptime') : undefined}
		hrefLabel={more ? t('web.monitor.view.uptime') : undefined}
		status={uptimeStatus}
		emptyTitle={t('web.monitoring.empty.noSamples')}
		height={4}
	>
		{#if uptimeDays}
			<UptimeTimeline
				days={uptimeDays}
				pct={uptime90?.pct ?? null}
				count={90}
				height={more ? '2rem' : '2.5rem'}
				label={t('web.instanceDetail.uptimeHistory')}
			/>
		{/if}
	</ChartPanel>
{/snippet}

<div class="monitoring">
	<div class="toolbar">
		<div class="views">
			<div class="segments">
				<SegmentedControl options={viewOptions} value={view} label={t('web.monitor.viewLabel')} onchange={setView} />
			</div>
			<div class="picker">
				<Select
					ariaLabel={t('web.monitor.viewLabel')}
					value={view}
					options={viewOptions.map((option) => ({ value: option.id, label: option.label }))}
					onchange={setView}
				/>
			</div>
		</div>
		<div class="tools">
			{#if live}
				<StatusBadge state="running" label={t('web.monitor.live')} />
			{/if}
			{#if loaded && !error}
				<span
					class="resolution dim"
					use:tooltip={{ content: step === null ? t('web.monitor.liveHint') : t('web.monitor.recordHint') }}
				>
					{resolution}
				</span>
			{/if}
			{#if zoomed}
				<span class="zoom mono">{rangeLabel}</span>
				<Btn icon="magnifyingGlassMinus" onclick={onreset}>{t('web.monitor.resetZoom')}</Btn>
			{/if}
			<div class="segments">
				<SegmentedControl
					label={t('web.monitor.range')}
					value={zoomed ? '' : range}
					options={rangeOptions}
					onchange={(id) => onrange(id as MetricsRange)}
				/>
			</div>
			<div class="picker">
				<Select
					ariaLabel={t('web.monitor.range')}
					value={zoomed ? '' : range}
					options={rangeOptions.map((option) => ({ value: option.id, label: t(`web.monitor.rangeLabel.${option.id}`) }))}
					width="11rem"
					onchange={(id) => onrange(id as MetricsRange)}
				/>
			</div>
		</div>
	</div>

	{#if loaded && !running && !inst.external}
		<Flash kind="info">{t('web.monitor.notRunning')}</Flash>
	{/if}

	{#if error}
		<!-- one failure said once, in place of a tile row of dashes and a retry per chart -->
		<ChartPanel title={t(`web.monitor.view.${view}`)} status="error" {error} {onretry} height={8}>
			<span></span>
		</ChartPanel>
	{:else if view === 'overview'}
		<StatGrid min={10}>
			<StatTile
				label={t('web.instances.detail.uptime30')}
				value={uptime30?.pct ?? null}
				unit="percent"
				formatValue={fmtUptime}
				tone={uptimeTone(uptime30?.pct)}
				secondary={uptime30 ? t('web.monitor.stopsInWindow', { count: String(stops30) }) : undefined}
				loading={uptimeDays === null}
				href={viewHref('uptime')}
			>
				{#snippet strip()}
					{#if uptime30}
						<UptimeTimeline days={uptime30.days} count={14} compact height="1rem" label={t('web.instances.detail.uptime30')} />
					{/if}
				{/snippet}
			</StatTile>
			{#if tps.length > 0}
				<StatTile
					label={t('web.instances.tickRate')}
					value={lead(tpsStats)}
					formatValue={fmtTps}
					secondary={extreme(tpsStats.min, fmtTps, true)}
					tone={lead(tpsStats) === null ? 'default' : tileTone(tpsTone(lead(tpsStats)!))}
					spark={tps[0]}
					href={viewHref('performance')}
				/>
			{/if}
			{#if tick.length > 0}
				<StatTile
					label={t('web.instances.tickDuration')}
					value={lead(msptStats)}
					unit="ms"
					formatValue={fmtMs}
					secondary={t('web.monitor.ofBudget')}
					tone={lead(msptStats) === null ? 'default' : tileTone(msptTone(lead(msptStats)!))}
					spark={tick[0]}
					href={viewHref('performance')}
				/>
			{/if}
			<StatTile
				label={t('web.instanceDetail.playersOnline')}
				value={lead(playerStats)}
				formatValue={fmtWhole}
				secondary={extreme(playerStats.max, fmtWhole)}
				spark={players[0]}
				loading={!loaded}
			/>
			<StatTile
				label={t('web.instanceDetail.cpuUtilization')}
				value={lead(cpuStats)}
				formatValue={fmtCpuPct}
				secondary={extreme(cpuStats.max, fmtCpuPct)}
				spark={cpu[0]}
				loading={!loaded}
				href={viewHref('resources')}
			/>
			<StatTile
				label={t('web.instanceDetail.memoryRss')}
				value={lead(rssStats) === null ? null : lead(rssStats)! * MB}
				unit="bytes"
				secondary={extreme(rssStats.max, fmtGb)}
				spark={memory.find((series) => series.key === 'rssMb')}
				loading={!loaded}
				href={viewHref('resources')}
			/>
			{#if heapStats.last !== null && heapMax !== null}
				<StatTile
					label={t('web.instanceDetail.jvmHeap')}
					value={heapStats.last * MB}
					unit="bytes"
					secondary={t('web.instances.detail.ofMax', { max: `${(heapMax / 1024).toFixed(1)} GB` })}
					progress={heapStats.last / heapMax}
					tone={heapStats.last / heapMax >= 0.9 ? 'warning' : 'default'}
					href={viewHref('resources')}
				/>
			{/if}
		</StatGrid>

		<Panel title={t('web.monitor.attention')} count={reasons.length || undefined}>
			{#snippet actions()}
				<a class="headlink" href={instanceTabPath(inst.name, 'checks')}>{t(INSTANCE_TAB_LABELS.checks)}</a>
			{/snippet}
			{#if reasons.length === 0}
				<p class="calm">
					<Icon name="circleCheck" color="var(--success)" />
					<span>{t('web.monitor.nothingNeedsAttention')}</span>
				</p>
			{:else}
				<ul class="reasons">
					{#each reasons as reason, index (index)}
						<li>
							<span class="tone {reason.severity}">
								<Icon name={reason.severity === 'critical' ? 'circleXMark' : 'triangleExclamation'} />
							</span>
							<span class="text">{reason.text}</span>
							{#if reason.detail}
								<span class="detail dim">{reason.detail}</span>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</Panel>

		<div class="charts">
			{#if tick.length > 0}
				{@render tickChart('performance')}
			{/if}
			{@render playersChart()}
			{@render cpuChart('resources')}
			{@render memoryChart('resources')}
		</div>

		{@render uptimePanel(true)}
	{:else if view === 'performance'}
		<StatGrid min={10}>
			{#if tps.length > 0 || !loaded}
				<StatTile
					label={t('web.instances.tickRate')}
					value={lead(tpsStats)}
					formatValue={fmtTps}
					secondary={extreme(tpsStats.min, fmtTps, true)}
					tone={lead(tpsStats) === null ? 'default' : tileTone(tpsTone(lead(tpsStats)!))}
					info={t('web.monitor.tpsInfo')}
					loading={!loaded}
				/>
			{/if}
			{#if tick.length > 0}
				<StatTile
					label={t('web.instances.tickDuration')}
					value={lead(msptStats)}
					unit="ms"
					formatValue={fmtMs}
					secondary={extreme(msptStats.max, fmtMs)}
					tone={lead(msptStats) === null ? 'default' : tileTone(msptTone(lead(msptStats)!))}
				/>
				<StatTile
					label={t('web.monitor.worstTick')}
					value={worstTick.max}
					unit="ms"
					formatValue={fmtMs}
					secondary={rangeLabel}
					tone={worstTick.max !== null && worstTick.max > 50 ? 'warning' : 'default'}
				/>
			{/if}
			{#if world.length > 0}
				<StatTile
					label={t('web.instanceDetail.loadedChunks')}
					value={lead(chunkStats)}
					formatValue={fmtWhole}
					secondary={extreme(chunkStats.max, fmtWhole)}
				/>
				<StatTile
					label={t('web.monitor.tickingEntities')}
					value={lead(entityStats)}
					formatValue={fmtWhole}
					secondary={extreme(entityStats.max, fmtWhole)}
				/>
			{/if}
		</StatGrid>

		<div class="charts">
			{#if tps.length > 0}
				{@render chart(t('web.instanceDetail.tickRate'), tps, { tps: { label: 'TPS' } }, {
					headline: tpsStats.last === null ? undefined : fmtTps(tpsStats.last),
					max: 20,
					format: fmtTps,
					info: t('web.monitor.tpsInfo')
				})}
			{/if}
			{#if tick.length > 0}
				{@render tickChart()}
			{/if}
			{#if apdex.length > 0}
				{@render chart(t('web.instanceDetail.apdex'), apdex, { apdex: { label: t('web.instanceDetail.apdex') } }, {
					max: 1,
					format: (value) => value.toFixed(3),
					info: t('web.instanceDetail.apdexHint')
				})}
			{/if}
			{#if world.length > 0}
				{@render chart(t('web.monitor.worldLoad'), world, {
					chunks: { label: t('web.instanceDetail.loadedChunks') },
					tickingEntities: { label: t('web.monitor.tickingEntities') },
					nonTickingEntities: { label: t('web.monitor.idleEntities') }
				}, {
					format: fmtWhole
				})}
			{/if}
		</div>

		{@render performance?.()}
	{:else if view === 'resources'}
		<StatGrid min={10}>
			<StatTile
				label={t('web.instanceDetail.cpuUtilization')}
				value={lead(cpuStats)}
				formatValue={fmtCpuPct}
				secondary={extreme(cpuStats.max, fmtCpuPct)}
				info={t('web.monitor.cpuInfo')}
				loading={!loaded}
			/>
			<StatTile
				label={t('web.instanceDetail.memoryRss')}
				value={lead(rssStats) === null ? null : lead(rssStats)! * MB}
				unit="bytes"
				secondary={extreme(rssStats.max, fmtGb)}
				loading={!loaded}
			/>
			{#if heapStats.last !== null && heapMax !== null}
				<StatTile
					label={t('web.instanceDetail.jvmHeap')}
					value={heapStats.last * MB}
					unit="bytes"
					secondary={t('web.instances.detail.ofMax', { max: `${(heapMax / 1024).toFixed(1)} GB` })}
					progress={heapStats.last / heapMax}
					tone={heapStats.last / heapMax >= 0.9 ? 'warning' : 'default'}
				/>
			{/if}
			{#if gc.length > 0}
				<StatTile
					label={t('web.instanceDetail.gcTime')}
					value={lead(gcStats)}
					unit="ms"
					formatValue={(value) => `${Math.round(value)} ms`}
					secondary={extreme(gcStats.max, (value) => `${Math.round(value)} ms`)}
					info={t('web.monitor.gcInfo')}
				/>
			{/if}
			{#if threads.length > 0}
				<StatTile
					label={t('web.instanceDetail.threadCount')}
					value={lead(threadStats)}
					formatValue={fmtWhole}
					secondary={extreme(threadStats.max, fmtWhole)}
				/>
			{/if}
		</StatGrid>

		<div class="charts">
			{@render cpuChart()}
			{@render memoryChart()}
			{#if gc.length > 0}
				{@render chart(t('web.instanceDetail.gcTime'), gc, { gcMs: { label: t('web.instanceDetail.gcTime') } }, {
					format: (value) => `${Math.round(value)} ms`,
					info: t('web.monitor.gcInfo')
				})}
			{/if}
			{#if threads.length > 0}
				{@render chart(t('web.monitor.threadCount'), threads, { threads: { label: t('web.instanceDetail.threadCount') } }, {
					headline: threadStats.last === null ? undefined : fmtWhole(threadStats.last),
					format: fmtWhole
				})}
			{/if}
		</div>

		{@render resources?.()}
	{:else}
		<StatGrid min={10}>
			<StatTile
				label={t('web.monitor.uptime7')}
				value={uptime7?.pct ?? null}
				unit="percent"
				formatValue={fmtUptime}
				tone={uptimeTone(uptime7?.pct)}
				loading={uptimeDays === null}
			/>
			<StatTile
				label={t('web.instances.detail.uptime30')}
				value={uptime30?.pct ?? null}
				unit="percent"
				formatValue={fmtUptime}
				tone={uptimeTone(uptime30?.pct)}
				secondary={uptime30 ? t('web.monitor.stopsInWindow', { count: String(stops30) }) : undefined}
				loading={uptimeDays === null}
			/>
			<StatTile
				label={t('web.monitor.uptime90')}
				value={uptime90?.pct ?? null}
				unit="percent"
				formatValue={fmtUptime}
				tone={uptimeTone(uptime90?.pct)}
				loading={uptimeDays === null}
			/>
			<StatTile
				label={t('web.monitor.stops')}
				value={loaded ? stopCount : null}
				formatValue={fmtWhole}
				secondary={rangeLabel}
				loading={!loaded}
			/>
			<StatTile
				label={t('web.monitor.unplannedStops')}
				value={loaded ? unplanned : null}
				formatValue={fmtWhole}
				secondary={rangeLabel}
				tone={unplannedTone}
				info={t('web.monitor.unplannedInfo')}
				loading={!loaded}
			/>
			<StatTile
				label={t('web.monitor.timeDown')}
				value={loaded ? downtimeMs(bands) : null}
				formatValue={(value) => fmtDuration(value)}
				secondary={rangeLabel}
				loading={!loaded}
			/>
		</StatGrid>

		{@render uptimePanel(false)}

		<ChartPanel
			title={t('web.monitor.stopsByCause')}
			info={t('web.monitor.stopsInfo')}
			headline={loaded ? fmtWhole(stopCount) : undefined}
			href={instanceTabPath(inst.name, 'checks')}
			hrefLabel={t(INSTANCE_TAB_LABELS.checks)}
			status={stopsStatus}
			stale={pending}
			emptyTitle={t('web.monitor.noStops')}
			height={HEIGHT}
		>
			<StackedBars
				series={stops.series}
				label={t('web.monitor.stopsByCause')}
				styles={stopStyles}
				from={bounds.from}
				to={bounds.to}
				height={HEIGHT}
				{bands}
				{group}
				{onzoom}
				formatValue={fmtWhole}
			/>
		</ChartPanel>
	{/if}
</div>

<style lang="scss">
	.monitoring {
		display: flex;
		flex-direction: column;
		gap: 1rem;

		// the kit's panels and flashes carry a bottom margin of their own; the column's gap is the spacing here
		> :global(.flash) {
			margin-bottom: 0;
		}
	}

	// the window stays in reach down a long view: the bar sticks under the tab strip.
	// Stuck, it sits at the scroll box's content edge, below the box's top padding
	// (1.25rem); the shadow paints that band in the page colour so nothing scrolls
	// through above it.
	.toolbar {
		position: sticky;
		top: 0;
		z-index: 5;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem 1rem;
		margin-bottom: -0.5rem;
		padding: 0 0 0.5rem;
		background: var(--bg-body);
		box-shadow: 0 -1.25rem 0 0 var(--bg-body);
	}

	.views,
	.tools {
		min-width: 0;
		max-width: 100%;

		.picker {
			display: none;
		}

		@include below($bp-medium) {
			.segments {
				display: none;
			}

			.picker {
				display: block;
			}
		}
	}

	.views .picker {
		min-width: 12rem;
	}

	.tools {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 0.75rem;
	}

	.resolution {
		font-size: 0.875rem;
		white-space: nowrap;
	}

	.zoom {
		font-size: 0.875rem;
		color: var(--text-heading);
		white-space: nowrap;
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

	.headlink {
		font-size: 0.875rem;
	}

	.calm {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0;
		color: var(--text-secondary);
	}

	// what is wrong, spelled out; a line per reason, its detail beside it
	.reasons {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin: 0;
		padding: 0;
		list-style: none;

		li {
			display: grid;
			grid-template-columns: 1.25rem minmax(0, auto) minmax(0, 1fr);
			align-items: baseline;
			gap: 0.25rem 0.75rem;
		}

		.tone {
			display: inline-flex;
			align-self: center;

			&.warning {
				color: var(--warning);
			}

			&.critical {
				color: var(--error);
			}
		}

		.text {
			color: var(--text-heading);
		}

		.detail {
			@include ellipsis;

			font-size: 0.875rem;
		}

		@include below($bp-medium) {
			li {
				grid-template-columns: 1.25rem minmax(0, 1fr);
			}

			.detail {
				grid-column: 2;
				white-space: normal;
			}
		}
	}
</style>
