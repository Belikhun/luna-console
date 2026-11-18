<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->
<script lang="ts">
	import { untrack } from 'svelte';

	import { t } from '$lib/i18n.svelte';
	import { api } from '$lib/api';
	import { fmtBytes, fmtDuration } from '$lib/format';
	import CellStack from '$lib/components/CellStack.svelte';
	import ChartPanel from '$lib/components/ChartPanel.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import ProgressBar from '$lib/components/ProgressBar.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import TimeSeriesChart from '$lib/components/TimeSeriesChart.svelte';
	import { ChartGroup } from '$lib/components/chartgroup.svelte';
	import type { Series } from '$lib/components/chart';
	import type { Column } from '$lib/components/table';
	import { MB, machineRowActions, machineSeries, type DaemonRow, type MachineHealth } from './fleet';

	/**
	 * The Monitoring page's Machines tab: every machine of the cluster with its
	 * figures now, then their last hour side by side. A machine keeps one hour of
	 * its own samples in memory, so these charts stay on the hour whatever window
	 * the page is on.
	 */
	let {
		daemons,
		loading = false
	}: {
		daemons: DaemonRow[];
		/** The first read is still out */
		loading?: boolean;
	} = $props();

	let history = $state.raw<Record<string, MachineHealth[]>>({});
	let status = $state<'loading' | 'ready' | 'error'>('loading');
	let failure = $state('');

	const group = new ChartGroup();
	const reachable = $derived(daemons.filter((machine) => machine.state !== 'offline').map((machine) => machine.name));

	/** Read each reachable machine's sampled hour; the page's refresh calls this. */
	export async function load(): Promise<void> {
		const names = reachable;

		if (names.length === 0) {
			return;
		}

		let problem = '';

		const answers = await Promise.all(
			names.map((name) =>
				api(`/daemons/${encodeURIComponent(name)}`).catch((err: Error) => {
					problem = err.message;

					return null;
				})
			)
		);

		const next: Record<string, MachineHealth[]> = {};

		answers.forEach((answer, index) => {
			if (answer) {
				next[names[index]!] = answer.history ?? [];
			}
		});

		if (Object.keys(next).length === 0) {
			status = 'error';
			failure = problem;

			return;
		}

		history = next;
		status = 'ready';
	}

	// the hour is read once the machines are known, and again when one joins or leaves
	$effect(() => {
		void reachable.join(' ');
		untrack(() => void load());
	});

	const chartStatus = $derived(
		status === 'loading' && !loading && daemons.length > 0 && reachable.length === 0
			? 'ready'
			: status
	);

	const cpuSeries = $derived(machineSeries(history, 'percent', (sample) => sample.cpuPct));
	const memorySeries = $derived(
		machineSeries(history, 'percent', (sample) => (sample.memTotalMb > 0 ? (sample.memUsedMb / sample.memTotalMb) * 100 : null))
	);
	const loadSeries = $derived(
		machineSeries(history, 'percent', (sample) => (sample.cpuCores > 0 ? (sample.load1 / sample.cpuCores) * 100 : null))
	);
	const instanceSeries = $derived(
		machineSeries(history, 'bytes', (sample) => (sample.instancesRssMb === undefined ? null : sample.instancesRssMb * MB))
	);

	const window = $derived.by(() => {
		const moments = Object.values(history).flatMap((samples) => [samples[0]?.t, samples.at(-1)?.t]).filter((at): at is number => at !== undefined);

		return moments.length === 0
			? { from: undefined, to: undefined }
			: { from: Math.min(...moments), to: Math.max(...moments) };
	});

	const columns: Column[] = $derived([
		{ id: 'name', label: t('web.instances.colMachine'), sortable: true, minWidth: 140 },
		{ id: 'state', label: t('web.common.state'), sortable: true, width: 130 },
		{ id: 'cpu', label: 'CPU', width: 190, sortable: true },
		{ id: 'memory', label: t('web.fleet.memory'), width: 220, sortable: true },
		{ id: 'swap', label: t('web.fleet.swap'), width: 200, sortable: true, hidden: true },
		{ id: 'disk', label: t('web.fleet.disk'), width: 220, sortable: true },
		{ id: 'load', label: t('web.fleet.load'), width: 110, align: 'right', sortable: true },
		{ id: 'instances', label: t('web.fleet.instances'), width: 150, align: 'right', sortable: true },
		{ id: 'latency', label: t('web.fleet.latency'), width: 110, align: 'right', sortable: true },
		{ id: 'uptime', label: t('web.fleet.hostUptime'), width: 130, sortable: true },
		{ id: 'version', label: t('web.fleet.version'), width: 160, sortable: true, hidden: true }
	]);

	function share(used: number | undefined, total: number | undefined): number {
		return used !== undefined && total
			? used / total
			: -1;
	}

	function sortValue(machine: DaemonRow, col: string): string | number | null {
		const health = machine.health;

		switch (col) {
			case 'name':
				return machine.name;

			case 'state':
				return machine.state;

			case 'cpu':
				return health?.cpuPct ?? -1;

			case 'memory':
				return share(health?.memUsedMb, health?.memTotalMb);

			case 'swap':
				return share(health?.swapUsedMb, health?.swapTotalMb);

			case 'disk':
				return share(health?.diskUsedBytes, health?.diskTotalBytes);

			case 'load':
				return health?.load1 ?? -1;

			case 'instances':
				return machine.instances.length;

			case 'latency':
				return machine.latencyMs ?? -1;

			case 'uptime':
				return health?.uptimeSec ?? -1;

			case 'version':
				return machine.version ?? '';

			default:
				return null;
		}
	}

	function percent(value: number): string {
		return `${value.toFixed(1)}%`;
	}
</script>

{#snippet chart(title: string, series: Series[], options: { info?: string; max?: number; format?: (value: number) => string })}
	<ChartPanel
		{title}
		description={t('web.instances.glance.lastHour')}
		info={options.info}
		status={chartStatus === 'ready' && series.length === 0 ? 'empty' : chartStatus}
		emptyTitle={t('web.monitoring.empty.noSamples')}
		emptyText={t('web.fleet.machinesEmptyHint')}
		error={failure}
		onretry={() => void load()}
		height={11}
	>
		<TimeSeriesChart
			{series}
			label={title}
			from={window.from}
			to={window.to}
			height={11}
			max={options.max}
			formatValue={options.format}
			{group}
		/>
	</ChartPanel>
{/snippet}

<div class="machines">
	<Panel title={t('web.fleet.tab.machines')} count={daemons.length} flush>
		<ResourceTable
			tableId="monitoring-machines"
			{columns}
			rows={daemons}
			getId={(machine) => machine.name}
			selectable="none"
			paging={false}
			searchable={false}
			loading={loading && daemons.length === 0}
			rowActions={machineRowActions}
			rowLabel={(machine) => machine.name}
			{sortValue}
			defaultSort={{ col: 'name' }}
			noun={t('web.fleet.machineNoun')}
			emptyTitle={t('web.fleet.noMachines')}
			rowDim={(machine) => machine.state === 'offline'}
		>
			{#snippet cell(machine, col)}
				{@const health = machine.health}
				{#if col === 'name'}
					<CellStack>
						{#snippet main()}
							<a href="/machines/{encodeURIComponent(machine.name)}">{machine.name}</a>
						{/snippet}
						{#snippet sub()}
							{machine.mode === 'primary' ? t('web.fleet.primary') : t('web.fleet.follower')}
						{/snippet}
					</CellStack>
				{:else if col === 'state'}
					<StatusBadge
						state={machine.state === 'online' ? 'passed' : machine.state === 'quarantined' ? 'warning' : 'stopped'}
						label={t(`web.fleet.machineState.${machine.state}`)}
					/>
				{:else if col === 'instances'}
					<span class="mono">{machine.instances.length}</span>
				{:else if col === 'latency'}
					{#if machine.latencyMs == null}
						<span class="dim">–</span>
					{:else}
						<span class="mono">{Math.round(machine.latencyMs)} ms</span>
					{/if}
				{:else if col === 'version'}
					<span class="mono">{machine.version ?? '–'}</span>
				{:else if !health}
					<span class="dim">–</span>
				{:else if col === 'cpu'}
					<ProgressBar compact value={health.cpuPct} max={100} color="auto" right={percent(health.cpuPct)} />
				{:else if col === 'memory'}
					<ProgressBar
						compact
						value={health.memUsedMb}
						max={health.memTotalMb}
						color="auto"
						right="{fmtBytes(health.memUsedMb * MB)} / {fmtBytes(health.memTotalMb * MB)}"
					/>
				{:else if col === 'swap'}
					{#if !health.swapTotalMb}
						<span class="dim">–</span>
					{:else}
						<ProgressBar
							compact
							value={health.swapUsedMb ?? 0}
							max={health.swapTotalMb}
							color="auto"
							right="{fmtBytes((health.swapUsedMb ?? 0) * MB)} / {fmtBytes(health.swapTotalMb * MB)}"
						/>
					{/if}
				{:else if col === 'disk'}
					<ProgressBar
						compact
						value={health.diskUsedBytes}
						max={health.diskTotalBytes}
						color="auto"
						right="{fmtBytes(health.diskUsedBytes)} / {fmtBytes(health.diskTotalBytes)}"
					/>
				{:else if col === 'load'}
					<CellStack align="right">
						{#snippet main()}
							<span class="mono" class:warn={health.load1 > health.cpuCores}>{health.load1.toFixed(2)}</span>
						{/snippet}
						{#snippet sub()}
							{t('web.instances.detail.ofCores', { cores: String(health.cpuCores) })}
						{/snippet}
					</CellStack>
				{:else if col === 'uptime'}
					{fmtDuration(health.uptimeSec * 1000)}
				{/if}
			{/snippet}
		</ResourceTable>
	</Panel>

	<div class="charts">
		{@render chart(t('web.fleet.machineCpuChart'), cpuSeries, { max: 100, format: percent })}
		{@render chart(t('web.fleet.machineMemoryChart'), memorySeries, { max: 100, format: percent })}
		{@render chart(t('web.fleet.machineLoadChart'), loadSeries, { info: t('web.fleet.machineLoadInfo'), format: percent })}
		{@render chart(t('web.fleet.machineInstancesChart'), instanceSeries, {})}
	</div>
</div>

<style lang="scss">
	.machines {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.charts {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem;

		@include below($bp-medium) {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.dim {
		color: var(--text-secondary);
	}

	.warn {
		color: var(--warning);
	}
</style>
