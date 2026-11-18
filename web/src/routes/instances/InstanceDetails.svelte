<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->
<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { cpuCeiling, fmtCpuPct, fmtDuration } from '$lib/format';
	import { resourceId } from '$shared/iam/resources';
	import type { InstanceRow } from '$lib/api';
	import type { ResourceMetaIndex } from '$lib/resourcemeta.svelte';
	import DateTime from '$lib/components/DateTime.svelte';
	import DistributionBar from '$lib/components/DistributionBar.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import MiniSpark from '$lib/components/MiniSpark.svelte';
	import ResourceMetaCell from '$lib/components/ResourceMetaCell.svelte';
	import SoftwareLabel from '$lib/components/SoftwareLabel.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import UptimeTimeline from '$lib/components/UptimeTimeline.svelte';
	import type { DistributionSegment } from '$lib/components/distribution';
	import type { InfoCell } from '$lib/components/grid';
	import type { UptimeDayPoint } from '$lib/components/uptime';
	import {
		checkSummary,
		historySeries,
		msptTone,
		MB,
		networkTone,
		tpsTone,
		uptimeWindow,
		type InstanceHistory
	} from './details';

	/**
	 * The instances list's split panel, Details tab: what the row says about the
	 * selected instance and what a row has no room for, in sections that flow
	 * into as many columns as the panel is wide. Live figures carry the last
	 * hour beside them, from the samples the panel's metrics call brings.
	 */
	let {
		row,
		history,
		uptimeDays,
		hostMemMb,
		hostName,
		meta
	}: {
		row: InstanceRow;
		/** The instance's sampled hour; null until the panel's metrics call answers */
		history: InstanceHistory | null;
		/** The long uptime record, oldest first; null until it loads */
		uptimeDays: UptimeDayPoint[] | null;
		/** Memory of the machine the console's primary runs on, MB; 0 when unknown */
		hostMemMb: number;
		/** The primary daemon's name, which a registry entry without an owner means */
		hostName: string;
		meta: ResourceMetaIndex;
	} = $props();

	const live = $derived(row.state === 'running');
	const machine = $derived(row.daemon ?? hostName);
	const checks = $derived(checkSummary(row.checks));
	const uptime = $derived(uptimeDays ? uptimeWindow(uptimeDays, 30) : null);
	const view = $derived(meta.view(row.name));

	const spark = $derived({
		cpu: history ? historySeries(history, 'cpu', 'percent') : null,
		memory: history ? historySeries(history, 'rssMb', 'bytes', MB) : null,
		tps: history ? historySeries(history, 'tps', 'count') : null,
		mspt: history ? historySeries(history, 'msptMean', 'ms') : null,
		heap: history ? historySeries(history, 'heapUsedMb', 'bytes', MB) : null,
		players: history ? historySeries(history, 'players', 'count') : null
	});

	/**
	 * Entities split by whether they are ticked: non-ticking entities are nearly
	 * free, so a total alone cannot tell a heavy farm from a hall of item frames.
	 */
	const entitySegments: DistributionSegment[] = $derived.by(() => {
		const segments: DistributionSegment[] = [];

		if (row.tickingEntities != null) {
			segments.push({
				key: 'ticking',
				label: t('web.instances.tickingEntities'),
				count: row.tickingEntities,
				color: 'var(--warning)'
			});
		}

		if (row.nonTickingEntities != null) {
			segments.push({
				key: 'nonticking',
				label: t('web.instances.nonTickingEntities'),
				count: row.nonTickingEntities,
				color: 'var(--link)'
			});
		}

		return segments;
	});

	const telemetryAge = $derived(row.lastHeartbeatMs ? Date.now() - row.lastHeartbeatMs : null);

	// -- sections ------------------------------------------------------------------------

	const statusCells: InfoCell[] = $derived([
		{ id: 'state', label: t('web.instances.colState') },
		{ id: 'network', label: t('web.instances.networkStatus') },
		{ id: 'uptime30', label: t('web.instances.detail.uptime30') },
		{ id: 'checks', label: t('web.instances.statusChecks') },
		{ id: 'players', label: t('web.instances.colPlayers') },
		{ id: 'telemetry', label: t('web.instances.telemetry') }
	]);

	const performanceCells: InfoCell[] = $derived([
		{ id: 'cpu', label: t('web.instances.cpuUtilization') },
		{ id: 'memory', label: t('web.instances.residentMemory') },
		...(row.tps != null ? [{ id: 'tps', label: t('web.instances.tickRate') }] : []),
		...(row.msptMean != null ? [{ id: 'mspt', label: t('web.instances.tickDuration') }] : []),
		...(row.heapUsedMb != null && row.heapMaxMb != null ? [{ id: 'heap', label: t('web.instances.jvmHeap') }] : []),
		...(row.chunks != null || entitySegments.length > 0
			? [{ id: 'world', label: t('web.instances.worldLoad'), colSpan: 2 }]
			: [])
	]);

	const softwareCells: InfoCell[] = $derived([
		{ id: 'software', label: t('web.instances.colSoftware') },
		{ label: t('web.instances.protocol'), value: row.pingVersion },
		{ label: t('web.instances.colProfile'), value: row.profile },
		{ label: t('web.instances.memoryHeap'), value: row.memory },
		{ label: t('web.instances.colPid'), value: row.javaPid, style: 'mono' },
		{
			label: t('web.instances.cpuCores'),
			value: row.cpuCores === null ? null : String(row.cpuCores)
		}
	]);

	const registration = $derived(
		row.proxy?.register
			? t('web.instances.registered')
			: row.name === 'proxy'
				? t('web.instances.isTheProxy')
				: t('web.instances.notRegistered')
	);

	const networkCells: InfoCell[] = $derived([
		{
			label: t('web.instances.colMachine'),
			value: machine,
			href: machine ? `/machines/${machine}` : undefined
		},
		{ label: t('web.instances.gameAddress'), value: row.address, copyable: true, style: 'mono' },
		{ label: t('web.instances.proxyRegistration'), value: registration },
		...Object.entries(row.ports).map(([key, port]) => ({
			label: key,
			value: String(port),
			style: 'mono' as const
		})),
		...(row.proxy?.forcedHosts?.length
			? [{ label: t('web.instances.forcedHosts'), value: row.proxy.forcedHosts.join(', '), colSpan: 2 }]
			: [])
	]);

	const aboutCells: InfoCell[] = $derived([
		{
			label: t('web.resourceMeta.id'),
			value: resourceId('instance', row.name),
			copyable: true,
			style: 'code',
			colSpan: 2
		},
		{ id: 'createdAt', label: t('web.resourceMeta.createdAt') },
		{ id: 'createdBy', label: t('web.resourceMeta.createdBy') },
		{ id: 'tags', label: t('web.resourceMeta.tags'), colSpan: 2 },
		{ label: t('web.instances.directory'), value: row.dir, copyable: true, style: 'mono', colSpan: 2 }
	]);
</script>

{#snippet dash()}
	<span class="dim">–</span>
{/snippet}

<!-- a live figure, a dim line of context under it, and the hour beside them -->
{#snippet chart(value: string, sub: string | null, series: ReturnType<typeof historySeries> | null, label: string, tone?: string, ceiling?: number, format?: (value: number) => string)}
	<span class="chartcell">
		<span class="stack">
			<span class="mono tone-{tone ?? 'plain'}">{value}</span>
			{#if sub}
				<span class="sub">{sub}</span>
			{/if}
		</span>
		{#if series && series.points.some(([, point]) => point !== null)}
			<MiniSpark {series} {label} width={4} height={1.75} {ceiling} formatValue={format} />
		{/if}
	</span>
{/snippet}

{#snippet cellBody(cell: InfoCell)}
	{#if cell.id === 'state'}
		<span class="stack">
			<StatusBadge state={row.paused ? 'paused' : row.state} />
			{#if live && row.uptimeMs}
				<span class="sub">{t('web.instances.detail.upFor', { span: fmtDuration(row.uptimeMs) })}</span>
			{/if}
		</span>
	{:else if cell.id === 'network'}
		{#if row.lunaStatus}
			<StatusBadge state={networkTone(row.lunaStatus)} label={row.lunaStatus} />
		{:else}
			<span class="dim">{t('web.instances.notReporting')}</span>
		{/if}
	{:else if cell.id === 'uptime30'}
		{#if !uptime || uptime.pct === null}
			{@render dash()}
		{:else}
			<span class="uptime">
				<span class="mono">{`${Number(uptime.pct.toFixed(2))}%`}</span>
				<span class="strip">
					<UptimeTimeline days={uptime.days} count={14} compact height="0.875rem" label={t('web.instances.detail.uptime30')} />
				</span>
			</span>
		{/if}
	{:else if cell.id === 'checks'}
		{#if checks.total === 0}
			{@render dash()}
		{:else}
			<StatusBadge
				state={checks.failed > 0 ? 'failed' : checks.unknown > 0 ? 'pending' : 'passed'}
				label={t('web.instances.checksPassed', { passed: String(checks.passed), total: String(checks.total) })}
				detail={row.checks.map((check) => ({
					state: check.ok === undefined ? 'unknown' : check.ok ? 'passed' : 'failed',
					label: check.name,
					detail: check.detail
				}))}
			/>
		{/if}
	{:else if cell.id === 'players'}
		{#if !row.players}
			{@render dash()}
		{:else}
			{@render chart(`${row.players.online} / ${row.players.max}`, null, spark.players, t('web.instances.colPlayers'))}
		{/if}
	{:else if cell.id === 'telemetry'}
		{#if telemetryAge === null || !row.lastHeartbeatMs}
			<span class="dim">{t('web.instances.notReporting')}</span>
		{:else}
			<DateTime at={row.lastHeartbeatMs} text={t('web.instances.agoOf', { age: fmtDuration(telemetryAge) })} />
		{/if}
	{:else if cell.id === 'cpu'}
		{#if row.cpu == null}
			{@render dash()}
		{:else}
			{@const ceiling = cpuCeiling(row.cpuCores)}
			{@render chart(
				fmtCpuPct(row.cpu),
				row.cpuCores ? t('web.instances.detail.ofCores', { cores: String(row.cpuCores) }) : null,
				spark.cpu,
				t('web.instances.cpuUtilization'),
				row.cpu / ceiling >= 0.9 ? 'critical' : row.cpu / ceiling >= 0.7 ? 'warning' : undefined,
				undefined,
				fmtCpuPct
			)}
		{/if}
	{:else if cell.id === 'memory'}
		{#if row.rssMb == null}
			{@render dash()}
		{:else}
			{@render chart(
				`${(row.rssMb / 1024).toFixed(1)} GB`,
				hostMemMb && !row.daemon ? t('web.instances.detail.ofMachine', { total: `${(hostMemMb / 1024).toFixed(0)} GB` }) : null,
				spark.memory,
				t('web.instances.residentMemory')
			)}
		{/if}
	{:else if cell.id === 'tps' && row.tps != null}
		{@render chart(
			row.tps.toFixed(2),
			t('web.instances.detail.tpsCeiling'),
			spark.tps,
			t('web.instances.tickRate'),
			tpsTone(row.tps),
			20,
			(value) => value.toFixed(2)
		)}
	{:else if cell.id === 'mspt' && row.msptMean != null}
		{@render chart(
			`${row.msptMean.toFixed(1)} ms`,
			row.msptMax == null ? null : t('web.instances.detail.worstTick', { max: row.msptMax.toFixed(1) }),
			spark.mspt,
			t('web.instances.tickDuration'),
			msptTone(row.msptMean),
			undefined,
			(value) => `${value.toFixed(1)} ms`
		)}
	{:else if cell.id === 'heap' && row.heapUsedMb != null && row.heapMaxMb != null}
		{@render chart(
			`${(row.heapUsedMb / 1024).toFixed(1)} GB`,
			t('web.instances.detail.ofMax', { max: `${(row.heapMaxMb / 1024).toFixed(1)} GB` }),
			spark.heap,
			t('web.instances.jvmHeap'),
			row.heapUsedMb / row.heapMaxMb >= 0.9 ? 'warning' : undefined,
			row.heapMaxMb * MB
		)}
	{:else if cell.id === 'world'}
		<span class="world">
			<span class="sub">
				{#if row.chunks != null}
					{t('web.instances.chunksLoaded', { count: row.chunks.toLocaleString() })}
				{/if}
				{#if row.worlds.length > 0}
					· {t('web.instances.worldCount', { count: String(row.worlds.length) })}
				{/if}
			</span>
			{#if entitySegments.length > 0}
				<DistributionBar segments={entitySegments} empty={t('web.instances.noEntities')} />
			{/if}
		</span>
	{:else if cell.id === 'software'}
		<SoftwareLabel software={row.software} version={row.mcVersion} />
	{:else if cell.id === 'createdAt'}
		{#if view?.createdAt}
			<DateTime at={view.createdAt} />
		{:else}
			{@render dash()}
		{/if}
	{:else if cell.id === 'createdBy' || cell.id === 'tags'}
		<ResourceMetaCell index={meta} names={row.name} col={cell.id} />
	{/if}
{/snippet}

{#snippet section(title: string, cells: InfoCell[])}
	<section>
		<h3>{title}</h3>
		<InfoGrid {cells} columns={2} custom={cellBody} />
	</section>
{/snippet}

<div class="sections">
	{@render section(t('web.instances.detail.secStatus'), statusCells)}

	<section>
		<h3>{t('web.instances.detail.secPerformance')}</h3>
		{#if live}
			<InfoGrid cells={performanceCells} columns={2} custom={cellBody} />
		{:else}
			<p class="dim quiet">{t('web.instances.detail.liveWhileRunning')}</p>
		{/if}
	</section>

	{@render section(t('web.instances.detail.secSoftware'), softwareCells)}
	{@render section(t('web.instances.detail.secNetwork'), networkCells)}
	{@render section(t('web.instances.detail.secAbout'), aboutCells)}
</div>

<style lang="scss">
	// sections flow down, then across: as many columns as the panel is wide, so
	// a wide bottom dock fills sideways and a side dock stays one column
	.sections {
		columns: 24rem;
		column-gap: 2.5rem;
		column-rule: 0.1rem solid var(--border-divider);
	}

	section {
		break-inside: avoid;
		padding-bottom: 1rem;
	}

	h3 {
		margin-bottom: 0.75rem;
		padding-bottom: 0.375rem;
		border-bottom: 0.1rem solid var(--border-divider);
		color: var(--text-secondary);
		font-size: 0.75rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.quiet {
		font-size: 0.875rem;
	}

	// a value and one dim line of context under it, as the table's cells stack
	.stack {
		display: inline-flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.125rem;
		min-width: 0;
		max-width: 100%;
	}

	.sub {
		max-width: 100%;
		color: var(--text-secondary);
		font-size: 0.75rem;
		line-height: 1rem;
	}

	// the number, then the hour's small chart beside it
	.chartcell {
		display: inline-flex;
		align-items: center;
		gap: 0.75rem;
		max-width: 100%;
	}

	.uptime {
		display: inline-flex;
		align-items: center;
		gap: 0.75rem;

		.strip {
			width: 6rem;
		}
	}

	.world {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		width: 100%;
	}

	.tone-warning {
		color: var(--warning);
	}

	.tone-critical {
		color: var(--error);
	}

	.tone-good {
		color: var(--success);
	}
</style>
