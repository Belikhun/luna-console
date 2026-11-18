<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->
<script lang="ts">
	import { untrack } from 'svelte';

	import { t } from '$lib/i18n.svelte';
	import { api, type InstanceRow } from '$lib/api';
	import { cpuCeiling, fmtBytes, fmtCpuPct, fmtDuration } from '$lib/format';
	import Btn from '$lib/components/Btn.svelte';
	import CellStack from '$lib/components/CellStack.svelte';
	import ChartPanel from '$lib/components/ChartPanel.svelte';
	import DetailPanel from '$lib/components/DetailPanel.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import MiniSpark from '$lib/components/MiniSpark.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import TimeSeriesChart from '$lib/components/TimeSeriesChart.svelte';
	import UptimeTimeline from '$lib/components/UptimeTimeline.svelte';
	import { ChartGroup } from '$lib/components/chartgroup.svelte';
	import type { Series, SeriesStyle, SeriesUnit } from '$lib/components/chart';
	import { instanceTabPath } from '$lib/components/instancetabs';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import type { MetricsRange } from '$shared/metricsrange';
	import InstanceGlance from '../instances/InstanceGlance.svelte';
	import { msptTone, tpsTone, trendSeries, type HistorySample, type InstanceHistory, type RowTrends } from '../instances/details';
	import {
		MB,
		OTHER_KEY,
		fleetHealth,
		fleetRowActions,
		fleetSeries,
		healthRank,
		isProxy,
		lowestValue,
		peakTotal,
		reasonsByInstance,
		topSeries,
		trendHistory,
		type DaemonRow,
		type FleetHistory,
		type FleetReason
	} from './fleet';

	/**
	 * The Monitoring page's Overview tab: what needs attention, every instance
	 * with its health and its figures now, then the fleet over the page's window
	 * as four charts sharing one crosshair. Picking a row opens its last hour in
	 * the split panel.
	 */
	let {
		rows,
		trends,
		reasons,
		daemons,
		range,
		loading = false,
		selected = $bindable(new Set<string>())
	}: {
		/** The instances luna manages, external servers left out */
		rows: InstanceRow[];
		trends: Record<string, RowTrends>;
		reasons: FleetReason[];
		daemons: DaemonRow[];
		range: MetricsRange;
		/** The first read is still out */
		loading?: boolean;
		selected?: Set<string>;
	} = $props();

	// -- needs attention ---------------------------------------------------------------

	const byInstance = $derived(reasonsByInstance(reasons));

	const attention = $derived(
		[...byInstance.entries()].map(([instance, list]) => ({
			instance,
			first: list[0]!,
			more: list.length - 1,
			critical: list.some((reason) => reason.severity === 'critical')
		}))
	);

	// -- the instances table -----------------------------------------------------------

	const primaryName = $derived(daemons.find((machine) => machine.mode === 'primary')?.name ?? '');

	function machineOf(row: InstanceRow): string {
		return row.daemon ?? primaryName;
	}

	// the first five share whatever width is left; the figures keep room for their small charts
	const columns: Column[] = $derived([
		{ id: 'name', label: t('web.common.name'), sortable: true, minWidth: 100 },
		{ id: 'health', label: t('web.monitor.health'), sortable: true, minWidth: 120 },
		{ id: 'state', label: t('web.instances.colState'), sortable: true, minWidth: 130 },
		{ id: 'machine', label: t('web.instances.colMachine'), sortable: true, minWidth: 130 },
		{ id: 'uptime30', label: t('web.instances.detail.uptime30'), sortable: true, minWidth: 160 },
		{ id: 'tps', label: 'TPS', sortable: true, width: 140, align: 'right' },
		{ id: 'mspt', label: t('web.instances.tickDuration'), sortable: true, width: 140, align: 'right' },
		{ id: 'cpu', label: 'CPU', sortable: true, width: 150, align: 'right' },
		{ id: 'rss', label: t('web.instances.colRss'), sortable: true, width: 160, align: 'right' },
		{ id: 'heap', label: t('web.fleet.heap'), sortable: true, width: 170, align: 'right', hidden: true },
		{ id: 'players', label: t('web.instances.colPlayers'), sortable: true, width: 140, align: 'right' }
	]);

	const filters: TableFilterGroup<InstanceRow>[] = $derived([
		{
			id: 'health',
			label: t('web.instances.filterState'),
			width: '12rem',
			options: [
				{ value: 'any', label: t('web.instances.anyState') },
				{ value: 'attention', label: t('web.monitor.attention'), match: (row: InstanceRow) => byInstance.has(row.name) },
				{ value: 'running', label: t('web.status.running'), match: (row: InstanceRow) => row.state === 'running' },
				{ value: 'stopped', label: t('web.status.stopped'), match: (row: InstanceRow) => row.state === 'stopped' }
			]
		},
		{
			id: 'machine',
			label: t('web.fleet.filterMachine'),
			width: '12rem',
			options: [
				{ value: 'any', label: t('web.fleet.anyMachine') },
				...daemons.map((machine) => ({
					value: machine.name,
					label: machine.name,
					match: (row: InstanceRow) => machineOf(row) === machine.name
				}))
			]
		}
	]);

	function sortValue(row: InstanceRow, col: string): string | number | null {
		switch (col) {
			case 'name':
				return row.name;

			case 'health':
				return healthRank(fleetHealth(row, byInstance.get(row.name)));

			case 'state':
				return row.state;

			case 'machine':
				return machineOf(row);

			case 'uptime30':
				return trends[row.name]?.uptime?.pct ?? -1;

			case 'tps':
				return row.tps ?? -1;

			case 'mspt':
				return row.msptMean ?? -1;

			case 'cpu':
				return row.cpu ?? -1;

			case 'rss':
				return row.rssMb ?? -1;

			case 'heap':
				return row.heapUsedMb ?? -1;

			case 'players':
				return row.players?.online ?? -1;

			default:
				return null;
		}
	}

	function uptimeTone(pct: number): string {
		return pct >= 99
			? ''
			: pct >= 95
				? 'warn'
				: 'bad';
	}

	function toneClass(tone: 'good' | 'warning' | 'critical'): string {
		return tone === 'good'
			? ''
			: tone === 'warning'
				? 'warn'
				: 'bad';
	}

	// -- the split panel: the picked instance's last hour --------------------------------

	const picked = $derived(rows.find((row) => selected.has(row.name)) ?? null);

	let dock = $state<'bottom' | 'right'>('bottom');
	let glance = $state.raw<{ name: string; history: InstanceHistory } | null>(null);
	let glanceFailed = $state<string | null>(null);

	async function loadGlance(): Promise<void> {
		const name = picked?.name;

		if (!name) {
			return;
		}

		try {
			const data = await api(`/instances/${encodeURIComponent(name)}/metrics`);

			glance = { name, history: data.history ?? [] };
			glanceFailed = null;
		} catch (err) {
			if (glance?.name !== name) {
				glanceFailed = (err as Error).message;
			}
		}
	}

	$effect(() => {
		const name = picked?.name;

		untrack(() => {
			if (name && glance?.name !== name) {
				glanceFailed = null;
				void loadGlance();
			}
		});
	});

	// -- the fleet over the window -------------------------------------------------------

	let record = $state.raw<{ range: MetricsRange; history: FleetHistory } | null>(null);
	let recordStatus = $state<'loading' | 'ready' | 'error'>('loading');
	let recordError = $state('');

	const group = new ChartGroup();
	const names = $derived(rows.map((row) => row.name));

	// everyone on the proxy is also on a backend, so a pile of both would count each player twice
	const backends = $derived(rows.filter((row) => !isProxy(row)).map((row) => row.name));

	/** Read every instance's saved figures over a window longer than the live hour. */
	async function loadRecord(): Promise<void> {
		const asked = range;

		if (asked === '1h' || names.length === 0) {
			return;
		}

		if (record?.range !== asked) {
			recordStatus = 'loading';
		}

		let failure = '';

		const answers = await Promise.all(
			names.map((name) =>
				api(`/instances/${encodeURIComponent(name)}/metrics?range=${asked}`).catch((err: Error) => {
					failure = err.message;

					return null;
				})
			)
		);

		if (asked !== range) {
			return;
		}

		const read = answers.filter((answer) => answer !== null);
		const first = read[0];

		if (!first) {
			recordStatus = 'error';
			recordError = failure;

			return;
		}

		const samples: Record<string, HistorySample[]> = {};

		answers.forEach((answer, index) => {
			if (answer) {
				samples[names[index]!] = answer.history ?? [];
			}
		});

		record = { range: asked, history: { from: first.from, to: first.to, samples } };
		recordStatus = 'ready';
	}

	/** Read again what this tab fetches on its own; the page's refresh calls this. */
	export async function load(): Promise<void> {
		await Promise.all([loadRecord(), loadGlance()]);
	}

	// a longer window is read once the instances are known, and again when it changes
	$effect(() => {
		void range;
		void names.length;
		untrack(() => void loadRecord());
	});

	const history = $derived(
		range === '1h'
			? trendHistory(trends)
			: record?.range === range
				? record.history
				: null
	);

	const chartStatus = $derived(
		range === '1h'
			? (loading && !history ? 'loading' : 'ready')
			: recordStatus === 'ready' && !history
				? 'loading'
				: recordStatus
	);

	const stale = $derived(range !== '1h' && recordStatus === 'loading' && history !== null);

	const playerSeries = $derived(fleetSeries(history, backends, 'players', 'count', { idleAsZero: true }));
	const tpsSeries = $derived(fleetSeries(history, names, 'tps', 'count'));
	const cpuSeries = $derived(topSeries(fleetSeries(history, names, 'cpu', 'percent'), 5));
	const memorySeries = $derived(fleetSeries(history, names, 'rssMb', 'bytes', { scale: MB, idleAsZero: true }));

	const playersPeak = $derived(peakTotal(playerSeries));
	const memoryPeak = $derived(peakTotal(memorySeries));
	const tpsLowest = $derived(lowestValue(tpsSeries));

	const seriesStyles = $derived<Record<string, SeriesStyle>>({
		...Object.fromEntries(rows.map((row) => [row.name, { label: row.name }])),
		[OTHER_KEY]: { label: t('web.fleet.otherInstances'), color: 'var(--chart-muted)' }
	});

	const rangeLabel = $derived(t(`web.monitor.rangeLabel.${range}`));
</script>

<!-- a row's last hour beside its figure; nothing when the hour measured nothing -->
{#snippet trend(name: string, metric: 'cpu' | 'rssMb' | 'tps' | 'players', unit: SeriesUnit, label: string, scale: number = 1)}
	{@const series = trendSeries(trends[name], metric, unit, scale)}
	{#if series}
		<MiniSpark {series} {label} width={3} height={1.5} />
	{/if}
{/snippet}

{#snippet chart(title: string, series: Series[], options: { headline?: string; info?: string; mode?: 'line' | 'stacked'; max?: number; format?: (value: number) => string })}
	<ChartPanel
		{title}
		description={rangeLabel}
		info={options.info}
		headline={chartStatus === 'ready' ? options.headline : undefined}
		status={chartStatus === 'ready' && series.length === 0 ? 'empty' : chartStatus}
		emptyTitle={t('web.monitoring.empty.noSamples')}
		emptyText={t('web.fleet.chartsEmptyHint')}
		error={recordError}
		onretry={() => void loadRecord()}
		{stale}
		height={12}
	>
		<TimeSeriesChart
			{series}
			label={title}
			styles={seriesStyles}
			mode={options.mode ?? 'line'}
			from={history?.from}
			to={history?.to}
			height={12}
			max={options.max}
			formatValue={options.format}
			{group}
		/>
	</ChartPanel>
{/snippet}

<div class="overview">
	<Panel title={t('web.monitor.attention')} count={attention.length}>
		{#if loading && rows.length === 0}
			<p class="quiet">{t('web.chart.loading')}</p>
		{:else if attention.length === 0}
			<p class="calm">
				<span class="ok"><Icon name="circleCheck" style="solid" /></span>
				{t('web.monitor.nothingNeedsAttention')}
			</p>
		{:else}
			<ul class="attention">
				{#each attention as item (item.instance)}
					<li>
						<a href={instanceTabPath(item.instance, 'monitoring')}>
							<span class="tone" class:critical={item.critical}>
								<Icon name={item.critical ? 'circleXMark' : 'triangleExclamation'} style="solid" />
							</span>
							<span class="name">{item.instance}</span>
							<span class="text">
								{item.first.text}
								{#if item.first.detail}
									<span class="detail">{item.first.detail}</span>
								{/if}
							</span>
							{#if item.more > 0}
								<span class="more">{t('web.fleet.moreReasons', { count: String(item.more) })}</span>
							{/if}
							<span class="go">{t('web.instances.glance.open')}</span>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</Panel>

	<Panel title={t('web.fleet.instances')} count={rows.length} flush>
		<ResourceTable
			tableId="monitoring-instances"
			{columns}
			{rows}
			{filters}
			getId={(row) => row.name}
			selectable="single"
			bind:selected
			paging={false}
			loading={loading && rows.length === 0}
			rowActions={fleetRowActions}
			rowLabel={(row) => row.name}
			{sortValue}
			defaultSort={{ col: 'health', dir: 'asc' }}
			searchValue={(row) => `${row.name} ${row.state} ${machineOf(row)}`}
			searchPlaceholder={t('web.fleet.searchInstances')}
			noun={t('web.instances.noun')}
			emptyTitle={t('web.fleet.noInstances')}
			rowDim={(row) => row.state === 'stopped'}
		>
			{#snippet cell(row, col)}
				{#if col === 'name'}
					<a href={instanceTabPath(row.name, 'monitoring')}>{row.name}</a>
				{:else if col === 'health'}
					{@const own = byInstance.get(row.name)}
					{@const health = fleetHealth(row, own)}
					{#if own && own.length > 0}
						<StatusBadge
							state={health === 'critical' ? 'failed' : 'warning'}
							label={t('web.fleet.attentionCount', { count: String(own.length) })}
							detail={own.map((reason) => ({
								state: reason.severity === 'critical' ? 'failed' : 'warning',
								label: reason.text,
								detail: reason.detail
							}))}
						/>
					{:else if health === 'healthy'}
						<StatusBadge state="passed" label={t('web.fleet.healthy')} />
					{:else}
						<span class="dim">–</span>
					{/if}
				{:else if col === 'state'}
					<CellStack>
						{#snippet main()}
							<StatusBadge state={row.paused && row.state === 'running' ? 'paused' : row.state} />
						{/snippet}
						{#snippet sub()}
							{#if row.state === 'running' && row.uptimeMs}
								{t('web.instances.detail.upFor', { span: fmtDuration(row.uptimeMs) })}
							{/if}
						{/snippet}
					</CellStack>
				{:else if col === 'machine'}
					{@const machine = machineOf(row)}
					{#if machine}
						<a href="/machines/{encodeURIComponent(machine)}">{machine}</a>
					{:else}
						<span class="dim">–</span>
					{/if}
				{:else if col === 'uptime30'}
					{@const kept = trends[row.name]?.uptime}
					{#if !kept || kept.pct === null}
						<span class="dim">–</span>
					{:else}
						<span class="chartcell left">
							<!-- a server switched off on purpose is not an outage to colour -->
							<span class="mono figure {row.state === 'stopped' ? '' : uptimeTone(kept.pct)}">{`${Number(kept.pct.toFixed(2))}%`}</span>
							<span class="strip">
								<UptimeTimeline days={kept.days} count={14} compact height="0.875rem" label={t('web.instances.detail.uptime30')} />
							</span>
						</span>
					{/if}
				{:else if col === 'tps'}
					{#if row.tps == null}
						<span class="dim">–</span>
					{:else}
						<span class="chartcell">
							<span class="mono {toneClass(tpsTone(row.tps))}">{row.tps.toFixed(2)}</span>
							{@render trend(row.name, 'tps', 'count', t('web.instances.tickRate'))}
						</span>
					{/if}
				{:else if col === 'mspt'}
					{#if row.msptMean == null}
						<span class="dim">–</span>
					{:else}
						<CellStack align="right">
							{#snippet main()}
								<span class="mono {toneClass(msptTone(row.msptMean!))}">{row.msptMean!.toFixed(1)} ms</span>
							{/snippet}
							{#snippet sub()}
								{#if row.msptMax != null}
									{t('web.instances.detail.worstTick', { max: row.msptMax.toFixed(1) })}
								{/if}
							{/snippet}
						</CellStack>
					{/if}
				{:else if col === 'cpu'}
					{#if row.cpu == null}
						<span class="dim">–</span>
					{:else}
						<span class="chartcell">
							<span class="mono" class:warn={row.cpu / cpuCeiling(row.cpuCores) >= 0.7}>{fmtCpuPct(row.cpu)}</span>
							{@render trend(row.name, 'cpu', 'percent', t('web.instances.cpuUtilization'))}
						</span>
					{/if}
				{:else if col === 'rss'}
					{#if row.rssMb == null}
						<span class="dim">–</span>
					{:else}
						<span class="chartcell">
							<span class="mono">{fmtBytes(row.rssMb * MB)}</span>
							{@render trend(row.name, 'rssMb', 'bytes', t('web.instances.residentMemory'), MB)}
						</span>
					{/if}
				{:else if col === 'heap'}
					{#if row.heapUsedMb == null}
						<span class="dim">–</span>
					{:else}
						<span class="mono" class:warn={!!row.heapMaxMb && row.heapUsedMb / row.heapMaxMb >= 0.9}>
							{fmtBytes(row.heapUsedMb * MB)}{#if row.heapMaxMb}<span class="dim"> / {fmtBytes(row.heapMaxMb * MB)}</span>{/if}
						</span>
					{/if}
				{:else if col === 'players'}
					{#if !row.players}
						<span class="dim">–</span>
					{:else}
						<span class="chartcell">
							<span class="mono">{row.players.online}/{row.players.max}</span>
							{@render trend(row.name, 'players', 'count', t('web.instances.colPlayers'))}
						</span>
					{/if}
				{/if}
			{/snippet}
		</ResourceTable>
	</Panel>

	<!-- one failed read is one message, not the same error on every chart -->
	{#if chartStatus === 'error'}
		<Panel title={t('web.fleet.chartsTitle')} description={rangeLabel}>
			<div class="charts-failed">
				<Flash kind="error">{recordError || t('web.fleet.chartsFailed')}</Flash>
				<Btn icon="arrowRotateRight" onclick={() => void loadRecord()}>{t('web.chart.retry')}</Btn>
			</div>
		</Panel>
	{:else}
		<div class="charts">
			{@render chart(t('web.fleet.playersChart'), playerSeries, {
				headline: playersPeak === null ? undefined : t('web.fleet.peak', { value: String(Math.round(playersPeak)) }),
				info: t('web.fleet.playersInfo'),
				mode: 'stacked',
				format: (value) => String(Math.round(value))
			})}
			{@render chart(t('web.fleet.tpsChart'), tpsSeries, {
				headline: tpsLowest === null ? undefined : t('web.fleet.lowest', { value: tpsLowest.toFixed(1) }),
				info: t('web.monitor.tpsInfo'),
				max: 20,
				format: (value) => value.toFixed(2)
			})}
			{@render chart(t('web.fleet.cpuChart'), cpuSeries, {
				info: t('web.monitor.cpuInfo'),
				format: fmtCpuPct
			})}
			{@render chart(t('web.fleet.memoryChart'), memorySeries, {
				headline: memoryPeak === null ? undefined : t('web.fleet.peak', { value: fmtBytes(memoryPeak) }),
				mode: 'stacked'
			})}
		</div>
	{/if}
</div>

{#if picked}
	<DetailPanel
		title={picked.name}
		subtitle="({picked.software}{picked.mcVersion ? ` ${picked.mcVersion}` : ''})"
		href={instanceTabPath(picked.name, 'monitoring')}
		hrefLabel={t('web.instances.glance.open')}
		bind:location={dock}
		onclose={() => (selected = new Set())}
	>
		{#snippet actions()}
			<StatusBadge state={picked.paused && picked.state === 'running' ? 'paused' : picked.state} />
			{#if dock === 'right'}
				<Btn variant="icon" icon="chartLine" href={instanceTabPath(picked.name, 'monitoring')} title={t('web.instances.glance.open')} />
			{:else}
				<Btn icon="chartLine" href={instanceTabPath(picked.name, 'monitoring')}>{t('web.instances.glance.open')}</Btn>
			{/if}
		{/snippet}
		<div class="glance">
			<InstanceGlance
				row={picked}
				history={glance?.name === picked.name ? glance.history : null}
				failed={glanceFailed}
				{dock}
			/>
		</div>
	</DetailPanel>
{/if}

<style lang="scss">
	.overview {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.quiet,
	.calm {
		margin: 0;
		font-size: 0.875rem;
		color: var(--text-secondary);
	}

	.calm {
		display: flex;
		align-items: center;
		gap: 0.5rem;

		.ok {
			color: var(--success);
		}
	}

	// one line per instance, the whole line its link; the panel's own padding is
	// taken back so the hover fill reaches both edges
	.attention {
		display: flex;
		flex-direction: column;
		margin: -0.5rem -1.25rem;
		padding: 0;
		list-style: none;

		li + li {
			border-top: 0.1rem solid var(--border-divider);
		}

		a {
			display: flex;
			align-items: baseline;
			gap: 0.75rem;
			padding: 0.625rem 1.25rem;
			color: var(--text);
			text-decoration: none;

			&:hover {
				background: var(--bg-hover);

				.go {
					text-decoration: underline;
				}
			}

			&:focus-visible {
				@include focus-ring;
			}
		}

		.tone {
			flex: none;
			align-self: center;
			color: var(--warning);

			&.critical {
				color: var(--error);
			}
		}

		.name {
			flex: none;
			min-width: 8rem;
			font-weight: 700;
		}

		.text {
			flex: 1;
			min-width: 0;

			@include ellipsis;
		}

		.detail {
			margin-left: 0.5rem;
			font-size: 0.875rem;
			color: var(--text-secondary);
		}

		.more,
		.go {
			flex: none;
			font-size: 0.875rem;
			color: var(--text-secondary);
		}

		.go {
			color: var(--link);
		}

		@include below($bp-medium) {
			a {
				flex-wrap: wrap;
			}

			.text {
				flex-basis: 100%;
				order: 1;
				white-space: normal;
			}
		}
	}

	.charts-failed {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.5rem;

		:global(.flash) {
			margin-bottom: 0;
		}
	}

	.charts {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem;

		@include below($bp-medium) {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.chartcell {
		display: inline-flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.5rem;
		max-width: 100%;

		&.left {
			justify-content: flex-start;
		}

		.figure {
			min-width: 3.75rem;
		}

		.strip {
			width: 4.5rem;
		}
	}

	.glance {
		padding: 1rem;
	}

	.dim {
		color: var(--text-secondary);
	}

	.warn {
		color: var(--warning);
	}

	.bad {
		color: var(--error);
	}
</style>
