<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->
<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import ScreenLink from '$lib/components/ScreenLink.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { checksPassed } from '$lib/daemons';
	import type { Column } from '$lib/components/table';
	import type { DaemonRow } from '$client/daemon';
	import { checkState } from '../machines';

	/**
	 * A machine's Health checks tab: the checks the primary runs against it,
	 * beside whether the primary can reach each running instance's port.
	 */
	let {
		row
	}: {
		row: DaemonRow;
	} = $props();

	// null on the primary: its own instances are local to the proxy, so nothing is probed
	const probed = $derived(row.reach !== null);
	const reach = $derived(row.reach ?? []);
	const answering = $derived(reach.filter((probe) => probe.ok).length);

	const checkCols: Column[] = $derived([
		{ id: 'result', label: t('web.machineDetail.colResult'), width: 130 },
		{ id: 'name', label: t('web.machineDetail.colCheck'), width: 180 },
		{ id: 'detail', label: t('web.machineDetail.colDetail') }
	]);

	const reachCols: Column[] = $derived([
		{ id: 'result', label: t('web.machineDetail.colResult'), width: 150 },
		{ id: 'instance', label: t('web.events.col.instance') },
		{ id: 'address', label: t('web.machineDetail.colAddress') }
	]);
</script>

<div class="pair" class:single={!probed}>
	<Panel
		fill
		flush
		title={t('web.machineDetail.tab.checks')}
		count={row.checks.length ? `${checksPassed(row)}/${row.checks.length}` : undefined}
		info={t('web.machineDetail.checksInfo')}
	>
		<DataTable
			columns={checkCols}
			rows={row.checks}
			getId={(check) => check.name}
			emptyTitle={t('web.machineDetail.noChecks')}
		>
			{#snippet cell(check, col)}
				{#if col === 'result'}
					<StatusBadge state={checkState(check)} />
				{:else if col === 'name'}
					<b>{check.name}</b>
				{:else if col === 'detail'}
					<span class="dim">{check.detail}</span>
				{/if}
			{/snippet}
		</DataTable>
	</Panel>

	{#if probed}
		<Panel
			fill
			flush
			title={t('web.machineDetail.reachability')}
			count={reach.length ? `${answering}/${reach.length}` : undefined}
			info={t('web.machineDetail.reachabilityInfo')}
		>
			<DataTable
				columns={reachCols}
				rows={reach}
				getId={(probe) => probe.instance}
				emptyTitle={t('web.machineDetail.noProbes')}
				emptyText={t('web.machineDetail.noProbesHint')}
			>
				{#snippet cell(probe, col)}
					{#if col === 'result'}
						<StatusBadge
							state={probe.ok ? 'passed' : 'failed'}
							label={probe.ok ? t('web.machineDetail.answering') : t('web.machineDetail.noAnswer')}
						/>
					{:else if col === 'instance'}
						<ScreenLink href="/instances/{encodeURIComponent(probe.instance)}">{probe.instance}</ScreenLink>
					{:else if col === 'address'}
						<span class="mono">{probe.address}</span>
					{/if}
				{/snippet}
			</DataTable>
		</Panel>
	{/if}
</div>

<style lang="scss">
	// two across, level with each other; one under the other on a narrow screen
	.pair {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem;
		align-items: stretch;

		&.single {
			grid-template-columns: minmax(0, 1fr);
		}

		@include below($bp-medium) {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
