<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->
<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';

	import { t } from '$lib/i18n.svelte';
	import { api, type InstanceRow } from '$lib/api';
	import { fmtBytes } from '$lib/format';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import OverviewBar from '$lib/components/OverviewBar.svelte';
	import OverviewCell from '$lib/components/OverviewCell.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import SegmentedControl from '$lib/components/SegmentedControl.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import Tabs from '$lib/components/Tabs.svelte';
	import type { DistributionSegment } from '$lib/components/distribution';
	import { instanceTabPath } from '$lib/components/instancetabs';
	import { METRICS_RANGES, type MetricsRange } from '$shared/metricsrange';
	import { tpsTone, type RowTrends } from '../instances/details';
	import FleetEvents from './FleetEvents.svelte';
	import FleetMachines from './FleetMachines.svelte';
	import FleetOverview from './FleetOverview.svelte';
	import {
		FLEET_TABS,
		MB,
		fleetHref,
		fleetReasons,
		fleetRowActions,
		parseFleetRange,
		playersOnline,
		type DaemonRow,
		type FleetTab
	} from './fleet';

	/**
	 * The cluster at a glance: a strip of what is running, who is playing and
	 * how each machine is loaded, then three tabs. Overview is what needs
	 * attention, every instance's figures and the fleet as charts; Events is
	 * every instance's and machine's history; Machines is the hosts. The window
	 * (`?range=`) is the page's, kept across the tabs (`?tab=`).
	 */

	let rows = $state.raw<InstanceRow[]>([]);
	let trends = $state.raw<Record<string, RowTrends>>({});
	let daemons = $state.raw<DaemonRow[]>([]);
	let loading = $state(true);
	let failure = $state('');
	let lastUpdated: number | null = $state(null);
	let selected = $state(new Set<string>());

	let overviewTab = $state<FleetOverview>();
	let eventsTab = $state<FleetEvents>();
	let machinesTab = $state<FleetMachines>();

	const tab: FleetTab = $derived.by(() => {
		const asked = page.url.searchParams.get('tab') ?? '';

		return (FLEET_TABS as readonly string[]).includes(asked)
			? (asked as FleetTab)
			: 'overview';
	});

	const range = $derived(parseFleetRange(page.url.searchParams.get('range')));

	/** Show another window, as a new entry in the history. */
	async function pickRange(next: MetricsRange): Promise<void> {
		await goto(fleetHref(tab, next), { noScroll: true, keepFocus: true });
	}

	async function refresh(): Promise<void> {
		try {
			const [list, machines] = await Promise.all([
				api('/instances?trends=1'),
				api('/daemons').catch(() => ({ daemons: [] }))
			]);

			rows = list.instances;
			trends = list.trends ?? {};
			daemons = machines.daemons;
			failure = '';
			lastUpdated = Date.now();
		} catch (err) {
			failure = (err as Error).message;
		}

		loading = false;
	}

	/** The refresh control's verb: the page's figures, then whatever the open tab reads on its own. */
	async function refreshAll(): Promise<void> {
		await Promise.all([
			refresh(),
			overviewTab?.load(),
			eventsTab?.load(),
			machinesTab?.load()
		]);
	}

	onMount(() => {
		void refresh();
	});

	// -- the fleet strip ------------------------------------------------------------

	const managed = $derived(rows.filter((row) => !row.external));
	const running = $derived(managed.filter((row) => row.state === 'running'));
	const reasons = $derived(fleetReasons(managed, trends));
	const online = $derived(playersOnline(managed));

	const slowest = $derived.by(() => {
		const measured = running.filter((row) => row.tps !== null);

		return measured.length === 0
			? null
			: measured.reduce((worst, row) => (row.tps! < worst.tps! ? row : worst));
	});

	const stateSegments: DistributionSegment[] = $derived([
		{ key: 'running', label: t('web.status.running'), count: running.length, color: 'var(--success)' },
		{
			key: 'busy',
			label: t('web.fleet.changing'),
			count: managed.filter((row) => row.state !== 'running' && row.state !== 'stopped').length,
			color: 'var(--warning)'
		},
		{ key: 'stopped', label: t('web.status.stopped'), count: managed.filter((row) => row.state === 'stopped').length, color: 'var(--text-disabled)' }
	]);

	function loadColor(percent: number): string {
		return percent >= 85
			? 'var(--error)'
			: percent >= 65
				? 'var(--warning)'
				: 'var(--success)';
	}

	// -- header ---------------------------------------------------------------------

	const picked = $derived(tab === 'overview' ? (managed.find((row) => selected.has(row.name)) ?? null) : null);

	const rangeOptions = $derived(METRICS_RANGES.map((id) => ({ id, label: t(`web.monitor.ranges.${id}`) })));

	const tabs = $derived(
		FLEET_TABS.map((id) => ({
			id,
			label: id === 'events'
				? t('web.events.title')
				: t(`web.fleet.tab.${id}`),
			href: fleetHref(id, range)
		}))
	);
</script>

<svelte:head><title>{t('web.nav.monitoring')} | Luna Console</title></svelte:head>

<PageHeader title={t('web.nav.monitoring')} count={loading ? undefined : managed.length} info={t('web.guide.monitoring')}>
	{#snippet actions()}
		<div class="bar">
			<RefreshControl onrefresh={refreshAll} {lastUpdated} {loading} storageKey="monitoring" />
			<SegmentedControl
				label={t('web.monitor.range')}
				value={range}
				options={rangeOptions}
				size="small"
				onchange={(id) => void pickRange(id as MetricsRange)}
			/>
			<Dropdown
				label={t('web.common.actions')}
				disabled={!picked}
				title={picked ? undefined : t('web.fleet.pickInstance')}
				header={picked?.name}
				menu={picked ? fleetRowActions(picked) : []}
			/>
		</div>
	{/snippet}
</PageHeader>

{#if failure}
	<div class="failure">
		<Flash kind="error">{t('web.instances.refreshFailed')}: {failure}</Flash>
	</div>
{/if}

<OverviewBar title={t('web.fleet.title')}>
	<OverviewCell label={t('web.fleet.instances')} segments={loading ? undefined : stateSegments} segmentsEmpty={t('web.fleet.noInstances')}>
		{#if loading}
			<span class="dim">–</span>
		{/if}
	</OverviewCell>
	<OverviewCell label={t('web.fleet.playersOnline')}>
		{#if loading}
			<span class="dim">–</span>
		{:else}
			<span class="figure">{online}</span>
		{/if}
	</OverviewCell>
	<OverviewCell label={t('web.fleet.worstTps')}>
		{#if !slowest}
			<span class="dim">–</span>
		{:else}
			{@const tone = tpsTone(slowest.tps!)}
			<span class="figure" class:warn={tone === 'warning'} class:bad={tone === 'critical'}>{slowest.tps!.toFixed(2)}</span>
			{#if tone !== 'good'}
				<a class="where" href={instanceTabPath(slowest.name, 'monitoring')}>{slowest.name}</a>
			{/if}
		{/if}
	</OverviewCell>
	<OverviewCell label={t('web.monitor.attention')}>
		{#if loading}
			<span class="dim">–</span>
		{:else if reasons.length === 0}
			<StatusBadge state="passed" label={t('web.fleet.allClear')} />
		{:else}
			<StatusBadge
				state={reasons.some((reason) => reason.severity === 'critical') ? 'failed' : 'warning'}
				label={t('web.fleet.attentionCount', { count: String(reasons.length) })}
				detail={reasons.map((reason) => ({
					state: reason.severity === 'critical' ? 'failed' : 'warning',
					label: `${reason.instance}: ${reason.text}`,
					detail: reason.detail
				}))}
			/>
		{/if}
	</OverviewCell>
	{#each daemons as machine (machine.name)}
		{@const health = machine.health}
		{#if health && machine.state !== 'offline'}
			<OverviewCell
				label={machine.name}
				progress={Math.min(1, health.cpuPct / 100)}
				progressColor={loadColor(health.cpuPct)}
			>
				<span class="mono">{t('web.fleet.machineLoad', {
					cpu: health.cpuPct.toFixed(1),
					used: fmtBytes(health.memUsedMb * MB),
					total: fmtBytes(health.memTotalMb * MB)
				})}</span>
			</OverviewCell>
		{:else}
			<OverviewCell label={machine.name}>
				<StatusBadge state="stopped" label={t(`web.fleet.machineState.${machine.state}`)} />
			</OverviewCell>
		{/if}
	{/each}
</OverviewBar>

<Tabs {tabs} active={tab} />

<div class="tabbody">
	{#if tab === 'overview'}
		<FleetOverview bind:this={overviewTab} rows={managed} {trends} {reasons} {daemons} {range} {loading} bind:selected />
	{:else if tab === 'events'}
		<FleetEvents bind:this={eventsTab} {range} />
	{:else}
		<FleetMachines bind:this={machinesTab} {daemons} {loading} />
	{/if}
</div>

<style lang="scss">
	.bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: 0.5rem;
	}

	.failure {
		margin-bottom: 1rem;
	}

	.tabbody {
		padding-top: 1rem;
	}

	.figure {
		font-size: 1.25rem;
		font-weight: 700;
	}

	.where {
		margin-left: 0.5rem;
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
