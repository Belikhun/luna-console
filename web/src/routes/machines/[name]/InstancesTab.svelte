<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->
<script lang="ts">
	import { goto } from '$app/navigation';

	import { t } from '$lib/i18n.svelte';
	import { fmtBytes, fmtCpuPct } from '$lib/format';
	import MiniSpark from '$lib/components/MiniSpark.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import ScreenLink from '$lib/components/ScreenLink.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { menuGroups, type ContextMenuItem } from '$lib/components/contextmenu';
	import { instanceTabPath } from '$lib/components/instancetabs';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import type { DaemonRow, HealthSample, ReachResult } from '$client/daemon';
	import { resourceId } from '$shared/iam/resources';
	import { MB, sparkSeries } from '../machines';

	/**
	 * A machine's Instances tab: every instance it runs with its state, the
	 * processor time and memory it takes beside their last hour, and whether
	 * the primary can reach its port.
	 */
	let {
		row,
		history
	}: {
		row: DaemonRow;
		/** The machine's sampled hour, oldest first */
		history: HealthSample[];
	} = $props();

	interface InstanceLine {
		name: string;
		state: string;
		cpu: number | null;
		rssMb: number | null;
		reach: ReachResult | null;
	}

	const health = $derived(row.health);

	const lines: InstanceLine[] = $derived(
		row.instances.map((name) => ({
			name,
			state: health?.states[name] ?? 'unknown',
			cpu: health?.instanceCpu?.[name] ?? null,
			rssMb: health?.instanceRssMb[name] ?? null,
			reach: row.reach?.find((result) => result.instance === name) ?? null
		}))
	);

	// the primary probes the machines it routes to; its own instances are local
	// to the proxy, so there is no probe to report on its own screen
	const probed = $derived(row.reach !== null);

	const columns: Column[] = $derived([
		{ id: 'name', label: t('web.events.col.instance'), minWidth: 160, sortable: true },
		{ id: 'state', label: t('web.common.state'), width: 160, sortable: true },
		{ id: 'cpu', label: t('web.machines.colCpu'), width: 170, align: 'right', sortable: true },
		{ id: 'memory', label: t('web.fleet.memory'), width: 180, align: 'right', sortable: true },
		{ id: 'share', label: t('web.machineDetail.colShare'), width: 130, align: 'right', sortable: true },
		...(probed
			? [{ id: 'reach', label: t('web.machineDetail.colReach'), minWidth: 220, sortable: true }]
			: [])
	]);

	const filters: TableFilterGroup<InstanceLine>[] = $derived([
		{
			id: 'state',
			label: t('web.machines.filterState'),
			options: [
				{ value: 'any', label: t('web.machines.anyState') },
				{ value: 'running', label: t('web.status.running'), match: (line) => line.state === 'running' },
				{ value: 'stopped', label: t('web.status.stopped'), match: (line) => line.state === 'stopped' },
				...(probed
					? [{ value: 'unreachable', label: t('web.machineDetail.noAnswer'), match: (line: InstanceLine) => line.reach?.ok === false }]
					: [])
			]
		}
	]);

	function memoryShare(line: InstanceLine): number | null {
		return line.rssMb !== null && health && health.memTotalMb > 0
			? (line.rssMb / health.memTotalMb) * 100
			: null;
	}

	function sortValue(line: InstanceLine, col: string): string | number | null {
		switch (col) {
			case 'name':
				return line.name;

			case 'state':
				return line.state;

			case 'cpu':
				return line.cpu ?? -1;

			case 'memory':
			case 'share':
				return line.rssMb ?? -1;

			case 'reach':
				return line.reach === null
					? 2
					: line.reach.ok
						? 1
						: 0;

			default:
				return null;
		}
	}

	function rowActions(line: InstanceLine): ContextMenuItem[] {
		const stopped = line.state === 'stopped';

		return menuGroups([
			{
				label: t('web.fleet.openInstance'),
				icon: 'server',
				action: () => goto(`/instances/${encodeURIComponent(line.name)}`)
			},
			{
				label: t('web.instances.glance.open'),
				icon: 'chartLine',
				action: () => goto(instanceTabPath(line.name, 'monitoring'))
			},
			{
				label: t('web.fleet.openLogs'),
				icon: 'fileLines',
				action: () => goto(instanceTabPath(line.name, 'logs'))
			},
			{
				label: t('web.fleet.openConsole'),
				icon: 'terminal',
				disabled: stopped,
				hint: stopped ? t('web.instances.glance.notRunning') : undefined,
				action: () => goto(`/instances/${encodeURIComponent(line.name)}/console`)
			}
		]);
	}
</script>

<Panel title={t('web.machineDetail.instancesOn', { name: row.name })} count={lines.length} flush>
	<ResourceTable
		tableId="daemon-instances"
		{columns}
		rows={lines}
		getId={(line) => line.name}
		searchValue={(line) => `${line.name} ${line.state} ${line.reach?.address ?? ''}`}
		searchPlaceholder={t('web.fleet.searchInstances')}
		searchWidth="18rem"
		{filters}
		{rowActions}
		rowLabel={(line) => line.name}
		resourceId={(line) => resourceId('instance', line.name)}
		noun={t('web.machineDetail.instanceNoun')}
		pageSize={15}
		{sortValue}
		defaultSort={{ col: 'memory', dir: 'desc' }}
		rowDim={(line) => line.state === 'stopped'}
		emptyTitle={t('web.machineDetail.noInstances')}
		emptyText={t('web.machineDetail.noInstancesHint')}
	>
		{#snippet cell(line, col)}
			{#if col === 'name'}
				<ScreenLink href="/instances/{encodeURIComponent(line.name)}">{line.name}</ScreenLink>
			{:else if col === 'state'}
				<StatusBadge state={line.state} />
			{:else if col === 'cpu'}
				{#if line.cpu === null}
					<span class="dim">–</span>
				{:else}
					{@const series = sparkSeries(history, 'cpu', 'percent', (sample) => sample.instanceCpu?.[line.name])}
					<span class="chartcell">
						<span class="figure mono">{fmtCpuPct(line.cpu)}</span>
						<span class="strip">
							{#if series}
								<MiniSpark {series} label={t('web.machines.colCpu')} width={4} height={1.5} formatValue={fmtCpuPct} />
							{/if}
						</span>
					</span>
				{/if}
			{:else if col === 'memory'}
				{#if line.rssMb === null}
					<span class="dim">–</span>
				{:else}
					{@const series = sparkSeries(history, 'memory', 'bytes', (sample) =>
						sample.instanceRssMb?.[line.name] === undefined
							? null
							: sample.instanceRssMb[line.name]! * MB
					)}
					<span class="chartcell">
						<span class="figure wide mono">{fmtBytes(line.rssMb * MB)}</span>
						<span class="strip">
							{#if series}
								<MiniSpark
									{series}
									label={t('web.fleet.memory')}
									width={4}
									height={1.5}
									ceiling={health ? health.memTotalMb * MB : undefined}
								/>
							{/if}
						</span>
					</span>
				{/if}
			{:else if col === 'share'}
				{@const share = memoryShare(line)}
				{#if share === null}
					<span class="dim">–</span>
				{:else}
					<span class="mono">{share.toFixed(1)}%</span>
				{/if}
			{:else if col === 'reach'}
				{#if line.reach}
					<span class="reach">
						<StatusBadge
							state={line.reach.ok ? 'passed' : 'failed'}
							label={line.reach.ok ? t('web.machineDetail.answering') : t('web.machineDetail.noAnswer')}
						/>
						<span class="dim mono">{line.reach.address}</span>
					</span>
				{:else}
					<span class="dim">{t('web.machineDetail.notProbed')}</span>
				{/if}
			{/if}
		{/snippet}
	</ResourceTable>
</Panel>

<style lang="scss">
	// a figure and its last hour; the figure sits in a fixed slot, right-aligned,
	// so every row's chart starts on the same edge
	.chartcell {
		display: inline-flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.5rem;
		max-width: 100%;

		// widest value is "1600%"
		.figure {
			min-width: 6ch;
			text-align: right;
			font-variant-numeric: tabular-nums;

			// widest value is "10.24 GB"
			&.wide {
				min-width: 8ch;
			}
		}

		.strip {
			display: inline-flex;
			align-items: center;
			width: 4rem;
		}
	}

	.reach {
		display: inline-flex;
		align-items: center;
		gap: 0.75rem;
	}
</style>
