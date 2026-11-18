<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->
<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { fmtBytes, fmtDuration } from '$lib/format';
	import Btn from '$lib/components/Btn.svelte';
	import CopyValue from '$lib/components/CopyValue.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import DateTime from '$lib/components/DateTime.svelte';
	import EventsTable from '$lib/components/EventsTable.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import MiniSpark from '$lib/components/MiniSpark.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import ResourceIdValue from '$lib/components/ResourceIdValue.svelte';
	import ScreenLink from '$lib/components/ScreenLink.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { diskPct, latencyTone, linkBadge, memPct, swapPct } from '$lib/daemons';
	import type { Series } from '$lib/components/chart';
	import type { InstanceEvent } from '$lib/components/events';
	import type { InfoCell } from '$lib/components/grid';
	import type { Column } from '$lib/components/table';
	import type { DaemonRow, HealthSample, UpgradeCheck, UpgradeOffer } from '$client/daemon';
	import { resourceId } from '$shared/iam/resources';
	import {
		MACHINE_TAB_ICONS,
		MB,
		checkRows,
		checksLabel,
		checksState,
		machineHref,
		roleLabel,
		sparkSeries
	} from '../machines';

	/**
	 * A machine's Details tab: how it stands and how loaded it is, what runs
	 * there and what happened to it lately, then its build and where it lives.
	 * Each panel leads to the tab that says more.
	 */
	let {
		row,
		history,
		events,
		check,
		checking = false
	}: {
		row: DaemonRow;
		/** The machine's sampled hour, oldest first */
		history: HealthSample[];
		/** The machine's own events, newest first */
		events: InstanceEvent[];
		/** What each upgrade source offers; null until one has been asked */
		check: UpgradeCheck | null;
		/** The sources are being asked now */
		checking?: boolean;
	} = $props();

	/** How many rows the instances and events panels show before sending the reader to the tab. */
	const BRIEF_ROWS = 6;

	const health = $derived(row.health);
	const badge = $derived(linkBadge(row));
	const failing = $derived(row.checks.filter((entry) => entry.ok === false));

	// the link's own figures are a follower's: the primary has no link to itself
	const linkCells: InfoCell[] = $derived(
		row.mode === 'follower'
			? [
					{ id: 'latency', label: t('web.fleet.latency') },
					{ id: 'beat', label: t('web.machineDetail.lastHeartbeat') },
					{
						label: t('web.machineDetail.connectedSince'),
						time: row.connectedAt || null
					}
				]
			: []
	);

	const statusCells: InfoCell[] = $derived([
		{ id: 'state', label: t('web.common.state') },
		{ label: t('web.machineDetail.role'), value: roleLabel(row) },
		{ id: 'checks', label: t('web.machines.colChecks') },
		...linkCells,
		{ label: t('web.machineDetail.daemonUptime'), value: row.uptimeMs === null ? null : fmtDuration(row.uptimeMs) },
		{ label: t('web.fleet.hostUptime'), value: health ? fmtDuration(health.uptimeSec * 1000) : null }
	]);

	const resourceCells: InfoCell[] = $derived([
		{ id: 'cpu', label: t('web.machines.colCpu') },
		{ id: 'load', label: t('web.machineDetail.loadAverage') },
		{ id: 'memory', label: t('web.fleet.memory') },
		{ id: 'swap', label: t('web.fleet.swap') },
		{ id: 'disk', label: t('web.fleet.disk') },
		{ id: 'instanceMemory', label: t('web.machineDetail.instanceMemory') }
	]);

	const addressCells: InfoCell[] = $derived([
		{ id: 'host', label: t('web.machineDetail.routingHost'), help: t('web.machineDetail.routingHostHelp') },
		{ id: 'addresses', label: t('web.machineDetail.ipAddresses') },
		{ id: 'root', label: t('web.machineDetail.clusterRoot') },
		{ id: 'resourceId', label: t('web.resourceId.label') }
	]);

	const buildCells: InfoCell[] = $derived([
		{ id: 'version', label: t('web.machineDetail.runningBuild') },
		{ label: t('web.machineDetail.protocol'), value: row.protocol === null ? null : String(row.protocol), help: t('web.machineDetail.protocolHelp') },
		{ label: t('web.machineDetail.platform'), value: check?.platform ?? null, style: 'mono' },
		{ id: 'checked', label: t('web.machineDetail.lastChecked') },
		...(check?.offers ?? []).map((offer): InfoCell => ({
			id: `offer:${offer.channel}`,
			label: offer.channel === 'primary'
				? t('web.machineDetail.offerPrimary')
				: t('web.machineDetail.offerRelease'),
			colSpan: 2
		}))
	]);

	function offerOf(cell: InfoCell): UpgradeOffer | undefined {
		return check?.offers.find((offer) => `offer:${offer.channel}` === cell.id);
	}

	const spark = $derived({
		cpu: sparkSeries(history, 'cpu', 'percent', (sample) => sample.cpuPct),
		load: sparkSeries(history, 'load', 'count', (sample) => sample.load1),
		memory: sparkSeries(history, 'memory', 'bytes', (sample) => sample.memUsedMb * MB),
		swap: sparkSeries(history, 'swap', 'bytes', (sample) => (sample.swapTotalMb ? (sample.swapUsedMb ?? 0) * MB : null)),
		disk: sparkSeries(history, 'disk', 'bytes', (sample) => (sample.diskTotalBytes > 0 ? sample.diskUsedBytes : null)),
		instanceMemory: sparkSeries(history, 'instances', 'bytes', (sample) => sample.instancesRssMb * MB),
		latency: sparkSeries(history, 'latency', 'ms', (sample) => sample.latencyMs)
	});

	/** The tone of a share of a capacity, in percent. */
	function shareTone(percent: number | null): 'warning' | 'critical' | undefined {
		if (percent === null || percent < 80) {
			return undefined;
		}

		return percent >= 92
			? 'critical'
			: 'warning';
	}

	// -- what runs here ---------------------------------------------------------------

	interface InstanceLine {
		name: string;
		state: string;
		rssMb: number | null;
	}

	const instanceLines: InstanceLine[] = $derived(
		row.instances
			.map((name) => ({
				name,
				state: health?.states[name] ?? 'unknown',
				rssMb: health?.instanceRssMb[name] ?? null
			}))
			.sort((left, right) => (right.rssMb ?? -1) - (left.rssMb ?? -1))
	);

	const instanceCols: Column[] = $derived([
		{ id: 'name', label: t('web.events.col.instance') },
		{ id: 'state', label: t('web.common.state'), width: 150 },
		{ id: 'memory', label: t('web.fleet.memory'), width: 110, align: 'right' }
	]);
</script>

{#snippet dash()}
	<span class="dim">–</span>
{/snippet}

<!-- a figure, one dim line of context under it, and its last hour beside it -->
{#snippet figure(value: string, sub: string | null, series: Series | undefined, label: string, tone?: 'warning' | 'critical', ceiling?: number, format?: (value: number) => string)}
	<span class="figure">
		<span class="stack">
			<span class="mono tone-{tone ?? 'plain'}">{value}</span>
			{#if sub}
				<span class="sub">{sub}</span>
			{/if}
		</span>
		{#if series}
			<MiniSpark {series} {label} width={5} height={1.75} {ceiling} {tone} formatValue={format} />
		{/if}
	</span>
{/snippet}

{#snippet cellBody(cell: InfoCell)}
	{#if cell.id === 'state'}
		<StatusBadge state={badge.state} label={badge.label} detail={row.quarantine ?? undefined} />
	{:else if cell.id === 'checks'}
		{#if row.checks.length === 0}
			{@render dash()}
		{:else}
			<StatusBadge state={checksState(row)} label={checksLabel(row)} detail={checkRows(row)} />
		{/if}
	{:else if cell.id === 'latency'}
		{#if row.latencyMs === null}
			{@render dash()}
		{:else}
			{@const tone = latencyTone(row.latencyMs)}
			{@render figure(
				`${Math.round(row.latencyMs)} ms`,
				null,
				spark.latency,
				t('web.fleet.latency'),
				tone === 'danger' ? 'critical' : tone === 'warning' ? 'warning' : undefined,
				undefined,
				(value) => `${Math.round(value)} ms`
			)}
		{/if}
	{:else if cell.id === 'beat'}
		{#if row.lastBeatMs === null}
			<DateTime at={row.lastSeen} empty={t('web.machines.neverSeen')} />
		{:else}
			{t('web.machineDetail.secondsAgo', { seconds: String(Math.round(row.lastBeatMs / 1000)) })}
		{/if}
	{:else if !health && ['cpu', 'load', 'memory', 'swap', 'disk', 'instanceMemory'].includes(cell.id ?? '')}
		{@render dash()}
	{:else if cell.id === 'cpu' && health}
		{@render figure(
			`${health.cpuPct.toFixed(1)}%`,
			t('web.instances.detail.ofCores', { cores: String(health.cpuCores) }),
			spark.cpu,
			t('web.machines.colCpu'),
			shareTone(health.cpuPct),
			100
		)}
	{:else if cell.id === 'load' && health}
		{@render figure(
			health.load1.toFixed(2),
			t('web.machineDetail.loadRest', { five: health.load5.toFixed(2), fifteen: health.load15.toFixed(2) }),
			spark.load,
			t('web.machineDetail.loadAverage'),
			health.load1 > health.cpuCores ? 'warning' : undefined,
			undefined,
			(value) => value.toFixed(2)
		)}
	{:else if cell.id === 'memory' && health}
		{@render figure(
			fmtBytes(health.memUsedMb * MB),
			t('web.instances.detail.ofMax', { max: fmtBytes(health.memTotalMb * MB) }),
			spark.memory,
			t('web.fleet.memory'),
			shareTone(memPct(health)),
			health.memTotalMb * MB
		)}
	{:else if cell.id === 'swap' && health}
		{#if !health.swapTotalMb}
			<span class="dim">{t('web.machines.noSwap')}</span>
		{:else}
			{@render figure(
				fmtBytes((health.swapUsedMb ?? 0) * MB),
				t('web.instances.detail.ofMax', { max: fmtBytes(health.swapTotalMb * MB) }),
				spark.swap,
				t('web.fleet.swap'),
				shareTone(swapPct(health)),
				health.swapTotalMb * MB
			)}
		{/if}
	{:else if cell.id === 'disk' && health}
		{#if health.diskTotalBytes <= 0}
			{@render dash()}
		{:else}
			{@render figure(
				fmtBytes(health.diskUsedBytes),
				t('web.instances.detail.ofMax', { max: fmtBytes(health.diskTotalBytes) }),
				spark.disk,
				t('web.fleet.disk'),
				shareTone(diskPct(health)),
				health.diskTotalBytes
			)}
		{/if}
	{:else if cell.id === 'instanceMemory' && health}
		{@render figure(
			fmtBytes(health.instancesRssMb * MB),
			t('web.machineDetail.acrossInstances', { count: String(Object.keys(health.instanceRssMb).length) }),
			spark.instanceMemory,
			t('web.machineDetail.instanceMemory'),
			undefined,
			health.memTotalMb * MB
		)}
	{:else if cell.id === 'host'}
		{#if row.host}
			<CopyValue value={row.host} label={cell.label} />
		{:else}
			{@render dash()}
		{/if}
	{:else if cell.id === 'addresses'}
		{#if row.addresses.length === 0}
			{@render dash()}
		{:else}
			<span class="list">
				{#each row.addresses as address (address)}
					<CopyValue value={address} label={cell.label} />
				{/each}
			</span>
		{/if}
	{:else if cell.id === 'root'}
		{#if row.root}
			<CopyValue value={row.root} label={cell.label} />
		{:else}
			{@render dash()}
		{/if}
	{:else if cell.id === 'resourceId'}
		<ResourceIdValue value={resourceId('machine', row.name)} label={cell.label} />
	{:else if cell.id === 'version'}
		<span class="stack">
			<span class="mono">{row.version ?? '–'}</span>
			{#if row.outdated}
				<StatusBadge state="warning" label={t('web.machines.behindPrimary')} />
			{/if}
		</span>
	{:else if cell.id === 'checked'}
		{#if check}
			<DateTime at={check.checkedAt} />
		{:else if checking}
			<span class="dim">{t('web.machineDetail.checking')}</span>
		{:else}
			<span class="dim">{t('web.machineDetail.notCheckedYet')}</span>
		{/if}
	{:else if cell.id?.startsWith('offer:')}
		{@const offer = offerOf(cell)}
		{#if offer}
			<span class="stack">
				<StatusBadge
					state={offer.newer ? 'warning' : 'passed'}
					label={offer.newer
						? t('web.machineDetail.offerNewer', { version: offer.version })
						: t('web.machineDetail.offerSame', { version: offer.version })}
				/>
				<span class="sub">
					{offer.origin} · {fmtBytes(offer.size)}
					{#if offer.pageUrl}
						· <a href={offer.pageUrl} target="_blank" rel="noreferrer">{t('web.machineDetail.releaseNotes')}</a>
					{/if}
				</span>
			</span>
		{/if}
	{/if}
{/snippet}

{#if row.quarantine}
	<Flash kind="error">{t('web.machineDetail.quarantined', { reason: row.quarantine })}</Flash>
{:else if row.state === 'offline'}
	<Flash kind="warning">{t('web.machineDetail.offline')}</Flash>
{:else if failing.length > 0}
	<Flash kind="warning">
		<div class="attention">
			<b>{t('web.monitor.attention')}</b>
			<ul>
				{#each failing as entry (entry.name)}
					<li>
						<span>{entry.name}</span>
						<span class="detail">{entry.detail}</span>
					</li>
				{/each}
			</ul>
			<a href={machineHref(row.name, 'checks')}>{t('web.machineDetail.tab.checks')}</a>
		</div>
	</Flash>
{/if}

<div class="stack-panels">
	<div class="pair">
		<Panel fill title={t('web.instances.detail.secStatus')}>
			{#snippet actions()}
				<Btn icon={MACHINE_TAB_ICONS.checks} href={machineHref(row.name, 'checks')}>{t('web.machineDetail.tab.checks')}</Btn>
			{/snippet}

			<InfoGrid cells={statusCells} columns={[2, 2, 1]} custom={cellBody} />
		</Panel>

		<Panel fill title={t('web.instanceOverview.resourceUse')} description={health ? t('web.machineDetail.resourceUseHint') : undefined}>
			{#snippet actions()}
				<Btn icon={MACHINE_TAB_ICONS.monitoring} href={machineHref(row.name, 'monitoring')}>{t('web.nav.monitoring')}</Btn>
			{/snippet}

			{#if health}
				<InfoGrid cells={resourceCells} columns={[3, 2, 1]} custom={cellBody} />
			{:else}
				<p class="quiet">{t('web.machineDetail.noFigures')}</p>
			{/if}
		</Panel>
	</div>

	<div class="pair">
		<Panel fill flush title={t('web.fleet.instances')} count={row.instances.length}>
			{#snippet actions()}
				<Btn icon={MACHINE_TAB_ICONS.instances} href={machineHref(row.name, 'instances')}>{t('web.machineDetail.allInstances')}</Btn>
			{/snippet}

			<DataTable
				columns={instanceCols}
				rows={instanceLines.slice(0, BRIEF_ROWS)}
				getId={(line) => line.name}
				emptyTitle={t('web.machineDetail.noInstances')}
				emptyText={t('web.machineDetail.noInstancesHint')}
			>
				{#snippet cell(line, col)}
					{#if col === 'name'}
						<ScreenLink href="/instances/{encodeURIComponent(line.name)}">{line.name}</ScreenLink>
					{:else if col === 'state'}
						<StatusBadge state={line.state} />
					{:else if col === 'memory'}
						{#if line.rssMb === null}
							{@render dash()}
						{:else}
							<span class="mono">{fmtBytes(line.rssMb * MB)}</span>
						{/if}
					{/if}
				{/snippet}
			</DataTable>
			{#if instanceLines.length > BRIEF_ROWS}
				<p class="more">{t('web.machineDetail.moreInstances', { count: String(instanceLines.length - BRIEF_ROWS) })}</p>
			{/if}
		</Panel>

		<Panel fill flush title={t('web.instanceOverview.recentEvents')}>
			{#snippet actions()}
				<Btn icon={MACHINE_TAB_ICONS.events} href={machineHref(row.name, 'events')}>{t('web.instanceOverview.allEvents')}</Btn>
			{/snippet}

			<EventsTable
				tableId="machine-recent-events"
				events={events.slice(0, BRIEF_ROWS)}
				brief
				maxHeight="none"
				emptyTitle={t('web.machineDetail.noRecentEvents')}
				emptyText={t('web.machineDetail.eventsHint')}
			/>
		</Panel>
	</div>

	<div class="pair">
		<Panel fill title={t('web.machineDetail.buildAndUpgrades')}>
			<InfoGrid cells={buildCells} columns={[2, 2, 1]} custom={cellBody} />

			{#if check}
				{#each check.notes as note (note)}
					<p class="quiet note">{note}</p>
				{/each}
				{#if check.offers.length === 0 && check.notes.length === 0}
					<p class="quiet note">{t('web.machineDetail.noUpgradeSourceAnswered')}</p>
				{/if}
			{/if}
		</Panel>

		<Panel fill title={t('web.instanceOverview.addresses')}>
			<InfoGrid cells={addressCells} columns={[2, 2, 1]} custom={cellBody} />
		</Panel>
	</div>
</div>

<style lang="scss">
	.stack-panels {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	// two across, level with each other; one under the other on a narrow screen
	.pair {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem;
		align-items: stretch;

		@include below($bp-medium) {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	// what is wrong, a line per failing check, and the way to the tab that lists them all
	.attention {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.25rem 1rem;

		ul {
			display: flex;
			flex: 1 1 20rem;
			flex-direction: column;
			gap: 0.125rem;
			margin: 0;
			padding: 0;
			list-style: none;
		}

		li {
			display: flex;
			flex-wrap: wrap;
			gap: 0 0.75rem;
		}

		.detail {
			opacity: 0.75;
		}
	}

	.quiet {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.875rem;

		&.note {
			margin-top: 0.75rem;
		}
	}

	.more {
		margin: 0;
		padding: 0.5rem 1rem;
		border-top: 0.1rem solid var(--border-divider);
		color: var(--text-secondary);
		font-size: 0.75rem;
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
	.figure {
		display: inline-flex;
		align-items: center;
		gap: 0.75rem;
		max-width: 100%;
	}

	.list {
		display: inline-flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.25rem;
	}

	.tone-warning {
		color: var(--warning);
	}

	.tone-critical {
		color: var(--error);
	}
</style>
