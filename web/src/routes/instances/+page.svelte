<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { api, post, type InstanceRow } from '$lib/api';
	import { fmtDuration } from '$lib/format';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Tabs from '$lib/components/Tabs.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import SearchInput from '$lib/components/SearchInput.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import SplitButton from '$lib/components/SplitButton.svelte';
	import DetailPanel from '$lib/components/DetailPanel.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import type { InfoCell } from '$lib/components/grid';
	import ContextMenu from '$lib/components/ContextMenu.svelte';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import ProgressBar from '$lib/components/ProgressBar.svelte';
	import ScheduleQuickModal from '$lib/components/ScheduleQuickModal.svelte';
	import { Notify } from '$lib/notifications.svelte';

	type Row = InstanceRow & { externalOnly?: boolean };

	let rows: InstanceRow[] = $state([]);
	/** Externals run on another machine, so LunaCore's heartbeat is all we know of them. */
	let externals: Array<{
		name: string;
		external: string;
		lunaStatus: string | null;
		players: { online: number; max: number } | null;
		tps: number | null;
		heapUsedMb: number | null;
		heapMaxMb: number | null;
		uptimeMs: number | null;
	}> = $state([]);
	let hostMemMb = $state(0);
	let selected: Set<string> = $state(new Set());
	let loading = $state(true);
	let detailTab = $state('details');
	let panelLocation: 'bottom' | 'right' = $state('bottom');
	let panelSize = $state(42);
	let lastUpdated: number | null = $state(null);
	let scheduleOpen = $state(false);
	let scheduleTargets: string[] = $state([]);

	/** Open the quick one-shot scheduler for the given instances. */
	function openScheduler(targets: string[]): void {
		if (!targets.length) {
			return;
		}

		scheduleTargets = targets;
		scheduleOpen = true;
	}

	// external servers have a name and an address and nothing else — they are
	// listed for completeness and rendered dimmed
	const allRows: Row[] = $derived([
		...rows,
		...externals.map(
			(entry) =>
				({
					name: entry.name,
					external: entry.external,
					externalOnly: true,
					// heartbeat-derived metrics; everything else stays blank for externals
					players: entry.players,
					tps: entry.tps,
					heapUsedMb: entry.heapUsedMb,
					heapMaxMb: entry.heapMaxMb,
					uptimeMs: entry.uptimeMs,
					lunaStatus: entry.lunaStatus
				}) as unknown as Row
		)
	]);

	const one = $derived(
		selected.size === 1 ? rows.find((row) => selected.has(row.name)) : undefined
	);

	const selRows = $derived(rows.filter((row) => selected.has(row.name)));
	const anyStopped = $derived(selRows.some((row) => row.state === 'stopped'));
	const anyUp = $derived(
		selRows.some((row) => row.state === 'running' || row.state === 'starting')
	);

	const filters: TableFilterGroup<Row>[] = [
		{
			id: 'state',
			label: 'Filter instance state',
			options: [
				{ value: 'any', label: 'Any state' },
				{ value: 'running', label: 'Running', match: (row) => row.state === 'running' },
				{ value: 'stopped', label: 'Stopped', match: (row) => row.state === 'stopped' },
				{
					value: 'transitioning',
					label: 'Starting or stopping',
					match: (row) =>
						row.state === 'starting' || row.state === 'stopping' || row.state === 'restarting'
				},
				{
					value: 'unhealthy',
					label: 'Failing status checks',
					match: (row) => !!row.checks?.some((check) => check.ok === false)
				}
			]
		},
		{
			id: 'kind',
			label: 'Filter instance type',
			options: [
				{ value: 'any', label: 'Any type' },
				{ value: 'paper', label: 'Paper backends', match: (row) => row.software === 'paper' },
				{
					value: 'velocity',
					label: 'Velocity proxy',
					match: (row) => row.software === 'velocity'
				},
				{ value: 'external', label: 'External servers', match: (row) => !!row.externalOnly }
			]
		}
	];

	const columns: Column[] = [
		{ id: 'name', label: 'Name', sortable: true, minWidth: 100 },
		{ id: 'state', label: 'Instance state', sortable: true },
		{ id: 'checks', label: 'Status check' },
		{ id: 'software', label: 'Software', sortable: true },
		{ id: 'version', label: 'Version', sortable: true },
		{ id: 'port', label: 'Port', sortable: true },
		{ id: 'memory', label: 'Memory' },
		{ id: 'cpu', label: 'CPU', sortable: true },
		{ id: 'rss', label: 'Mem (RSS)', sortable: true },
		{ id: 'tps', label: 'TPS', sortable: true, width: 80, align: 'right' },
		// heap duplicates what Mem (RSS) already conveys at a glance, and thirteen
		// visible columns overflow the table — it is one gear-click away instead
		{ id: 'heap', label: 'Heap', sortable: true, hidden: true },
		{ id: 'uptime', label: 'Uptime', sortable: true },
		{ id: 'players', label: 'Players', sortable: true },
		{ id: 'profile', label: 'Java profile', hidden: true },
		{ id: 'pid', label: 'Java PID', hidden: true }
	];

	function sortValue(row: Row, col: string): string | number | null {
		switch (col) {
			case 'name':
				return row.name;

			// externals have no state, and sort last
			case 'state':
				return row.state ?? 'zz';

			case 'software':
				return row.software;

			case 'version':
				return row.mcVersion ?? '';

			case 'port':
				return row.port ?? 0;

			// a missing metric sorts below zero rather than alongside it
			case 'cpu':
				return row.cpu ?? -1;

			case 'rss':
				return row.rssMb ?? -1;

			case 'tps':
				return row.tps ?? -1;

			case 'heap':
				return row.heapUsedMb ?? -1;

			case 'uptime':
				return row.uptimeMs ?? -1;

			case 'players':
				return row.players?.online ?? -1;

			default:
				return null;
		}
	}

	async function refresh(): Promise<void> {
		try {
			const data = await api('/instances');

			rows = data.instances;
			externals = data.externals;
			hostMemMb = data.hostMemMb ?? 0;
			lastUpdated = Date.now();
		} catch (err) {
			Notify.error('Could not refresh instances', { detail: (err as Error).message });
		}

		loading = false;
	}

	onMount(() => {
		void refresh();
	});

	const PAST_TENSE = { start: 'started', stop: 'stopped', restart: 'restarted' };

	async function stateAction(action: 'start' | 'stop' | 'restart'): Promise<void> {
		// only act on rows the action can actually apply to
		const targets = selRows.filter((row) =>
			action === 'start'
				? row.state === 'stopped'
				: row.state === 'running' || row.state === 'starting'
		);

		if (!targets.length) {
			return;
		}

		const names = targets.map((target) => target.name).join(', ');
		const note = Notify.loading(`Sending ${action} to ${names}…`);
		const failures: string[] = [];

		await Promise.all(
			targets.map((target) =>
				post(`/instances/${target.name}/state`, { action }).catch((err) =>
					failures.push(`${target.name}: ${err.message}`)
				)
			)
		);

		if (failures.length) {
			note.set({
				level: 'error',
				message: `Could not ${action} ${failures.length} instance(s)`,
				detail: failures.join(' · '),
				closeable: true
			});
		} else {
			note.set({
				level: 'success',
				message: `${names} ${PAST_TENSE[action]}`,
				closeable: true
			});
		}

		await refresh();
	}

	/** Heap ceiling in MB, parsed from the configured "4G"/"512M" memory string. */
	function heapMb(memory: string | undefined): number {
		if (!memory) {
			return 0;
		}

		const parsed = /^(\d+(?:\.\d+)?)\s*([gGmM])/.exec(memory);

		if (!parsed) {
			return 0;
		}

		return parsed[2]?.toLowerCase() === 'g' ? Number(parsed[1]) * 1024 : Number(parsed[1]);
	}

	/** Tick-rate band: 20 is the ceiling, below 15 the server is visibly lagging. */
	function tpsClass(tps: number): string {
		if (tps >= 19) {
			return 'good';
		}

		return tps >= 15 ? 'fair' : 'poor';
	}

	/**
	 * Tone for the tick-rate bar. It cannot use `color="auto"`: that reads a full bar
	 * as danger, which is right for CPU and heap but exactly backwards for TPS, where
	 * a full bar is a healthy server.
	 */
	function tpsTone(tps: number): 'success' | 'warning' | 'danger' {
		if (tps >= 19) {
			return 'success';
		}

		return tps >= 15 ? 'warning' : 'danger';
	}

	/** An instance's verbs — the row menu and the toolbar's Actions button. */
	function rowActions(row: Row): ContextMenuItem[] {
		const up = row.state === 'running' || row.state === 'starting';

		return [
			{
				label: 'Connect to console',
				icon: 'code',
				action: () => goto(`/instances/${row.name}/console`)
			},
			{
				label: 'View details',
				icon: 'circleInfo',
				action: () => goto(`/instances/${row.name}`)
			},
			{ separator: true },
			{
				label: 'Start instance',
				icon: 'play',
				disabled: row.state !== 'stopped',
				hint: row.state !== 'stopped' ? `${row.name} is already ${row.state}` : undefined,
				action: () => stateAction('start')
			},
			{
				label: 'Stop instance',
				icon: 'stop',
				disabled: !up,
				hint: !up ? `${row.name} is not running` : undefined,
				action: () => stateAction('stop')
			},
			{
				label: 'Restart instance',
				icon: 'rotate',
				disabled: !up,
				hint: !up ? `${row.name} is not running` : undefined,
				action: () => stateAction('restart')
			},
			{
				label: 'Schedule an action…',
				icon: 'clock',
				action: () => openScheduler([row.name])
			},
			{ separator: true },
			{
				label: 'Manage',
				icon: 'sliders',
				submenu: [
					{
						label: 'Plugins',
						icon: 'plug',
						action: () => goto(`/instances/${row.name}?tab=plugins`)
					},
					{
						label: 'Configuration',
						icon: 'sliders',
						action: () => goto(`/instances/${row.name}?tab=config`)
					},
					{
						label: 'Networking',
						icon: 'sitemap',
						action: () => goto(`/instances/${row.name}?tab=network`)
					},
					{
						label: 'Logs',
						icon: 'scroll',
						action: () => goto(`/instances/${row.name}?tab=logs`)
					}
				]
			},
			{
				label: 'Copy game address',
				icon: 'copy',
				action: () => navigator.clipboard?.writeText(`10.0.0.10:${row.port}`)
			},
			{ separator: true },
			{
				label: 'Delete instance',
				icon: 'trash',
				color: 'danger',
				disabled: row.state !== 'stopped' || row.name === 'proxy',
				hint:
					row.name === 'proxy'
						? 'the proxy is the cluster entrypoint and cannot be deleted'
						: row.state !== 'stopped'
							? 'stop the instance first'
							: undefined,
				action: () => goto(`/instances/${row.name}?tab=config&delete=1`)
			}
		];
	}

	const detailCells: InfoCell[] = $derived.by(() => {
		if (!one) {
			return [];
		}

		return [
			{ id: 'state', label: 'Instance state' },
			{ label: 'Software', value: `${one.software} ${one.mcVersion ?? ''}` },
			{ label: 'Game address', value: `127.0.0.1:${one.port}`, copyable: true, style: 'mono' },
			{ label: 'Memory (heap)', value: one.memory },
			{ label: 'Java profile', value: one.profile },
			{ label: 'Java PID', value: one.javaPid },
			{ label: 'Uptime', value: fmtDuration(one.uptimeMs) },
			{
				label: 'Players',
				value: one.players ? `${one.players.online}/${one.players.max}` : null
			},
			{ label: 'Directory', value: one.dir, copyable: true, style: 'mono' }
		];
	});

	const networkCells: InfoCell[] = $derived.by(() => {
		if (!one) {
			return [];
		}

		const registration = one.proxy?.register
			? 'registered'
			: one.name === 'proxy'
				? '(is the proxy)'
				: 'not registered';

		const forcedHosts = one.proxy?.forcedHosts?.length
			? [{ label: 'Forced hosts', value: one.proxy.forcedHosts.join(', ') }]
			: [];

		return [
			{ label: 'Game port', value: `tcp/${one.port}`, style: 'mono' },
			...Object.entries(one.ports).map(([key, port]) => ({
				label: key,
				value: String(port),
				style: 'mono' as const
			})),
			{ label: 'Proxy registration', value: registration },
			...forcedHosts
		];
	});
</script>

<svelte:head><title>Instances | Luna Console</title></svelte:head>

<div class="split-view">
	<div class="main-col">
		<PageHeader
			title="Instances"
			count="{selected.size ? `${selected.size}/` : ''}{allRows.length}"
			info
		>
			{#snippet actions()}
				<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="instances" />
				<Btn disabled={!one} onclick={() => one && goto(`/instances/${one.name}/console`)}>Connect</Btn>
				<Dropdown
					label="Instance state"
					disabled={selected.size === 0}
					items={[
						{
							label: 'Start instance',
							icon: 'play',
							disabled: !anyStopped,
							action: () => stateAction('start')
						},
						{
							label: 'Stop instance',
							icon: 'stop',
							disabled: !anyUp,
							action: () => stateAction('stop')
						},
						{
							label: 'Restart instance',
							icon: 'rotate',
							disabled: !anyUp,
							action: () => stateAction('restart')
						},
						{ divider: true, label: '' },
						{
							label: 'Schedule an action…',
							icon: 'clock',
							action: () => openScheduler(selRows.map((row) => row.name))
						}
					]}
				/>
				<!-- the selection's verbs are the row's verbs — one declaration, two
				     places to reach it (here and the row's context menu) -->
				<Dropdown label="Actions" disabled={!one} menu={one ? rowActions(one) : []} />
				<SplitButton
					label="Launch instance"
					onclick={() => goto('/instances/launch')}
					items={[
						{
							label: 'Launch instance (wizard)',
							icon: 'rocket',
							action: () => goto('/instances/launch')
						},
						{ label: 'Clone selected instance', icon: 'copy', disabled: true }
					]}
				/>
			{/snippet}
		</PageHeader>

		<Panel flush>
			<ResourceTable
				tableId="instances"
				{columns}
				rows={allRows}
				getId={(row) => row.name}
				searchValue={(row) =>
					`${row.name} ${row.state ?? 'external'} ${row.software ?? ''} ${row.mcVersion ?? ''} ${row.port ?? row.external ?? ''} ${row.daemon ?? 'primary'}`}
				searchPlaceholder="Find instance by name, state or version"
				selectable="multi"
				bind:selected
				{rowActions}
				rowLabel={(row) => row.name}
				noun="instance"
				{sortValue}
				rowDim={(row) => !!row.externalOnly}
				{filters}
				pageSize={25}
				emptyTitle="No instances registered"
				emptyText="Launch one to get started."
			>
				{#snippet cell(row, col)}
					{#if row.externalOnly}
						{#if col === 'name'}
							{row.name}
						{:else if col === 'state'}
							<StatusBadge state="external" label="External" />
						{:else if col === 'checks'}
							<!-- externals run elsewhere, so LunaCore's heartbeat is the only
							     thing that can say whether they are actually up -->
							{#if !row.lunaStatus}
								<span class="dim">–</span>
							{:else if row.lunaStatus === 'ONLINE'}
								<StatusBadge
									state="passed"
									label="Heartbeat ok"
									detail={[
										{
											state: 'passed',
											label: 'LunaCore heartbeat',
											detail: `${(row.tps ?? 0).toFixed(2)} TPS · ${row.players?.online ?? 0}/${row.players?.max ?? 0} players`
										}
									]}
								/>
							{:else}
								<StatusBadge
									state="warning"
									label="No heartbeat"
									detail={[
										{
											state: 'failed',
											label: 'LunaCore heartbeat',
											detail: 'not reporting to the proxy — the server is down or unreachable'
										}
									]}
								/>
							{/if}
						{:else if col === 'port'}
							<span class="mono">{row.external}</span>
						{:else if col === 'players'}
							{row.players ? `${row.players.online}/${row.players.max}` : '–'}
						{:else if col === 'tps'}
							{#if row.tps == null}
								<span class="dim">–</span>
							{:else}
								<span class="tps {tpsClass(row.tps)}">{row.tps.toFixed(2)}</span>
							{/if}
						{:else if col === 'heap'}
							{#if row.heapUsedMb == null || row.heapMaxMb == null}
								<span class="dim">–</span>
							{:else}
								<ProgressBar
									compact
									value={row.heapUsedMb}
									max={row.heapMaxMb}
									color="auto"
									right="{(row.heapUsedMb / 1024).toFixed(1)} GB"
								/>
							{/if}
						{:else if col === 'uptime'}
							{row.uptimeMs == null ? '–' : fmtDuration(row.uptimeMs)}
						{:else}
							<span class="dim">–</span>
						{/if}
					{:else if col === 'name'}
						<!-- the row itself is clickable, so the link must not double-fire -->
						<a href="/instances/{row.name}" onclick={(event) => event.stopPropagation()}>
							{row.name}
						</a>
					{:else if col === 'state'}
						<StatusBadge state={row.state} />
					{:else if col === 'checks'}
						{#if row.state === 'stopped'}
							<span class="dim">–</span>
						{:else}
							{@const passed = row.checks.filter((check) => check.ok).length}
							<StatusBadge
								state={passed === row.checks.length ? 'passed' : 'warning'}
								label="{passed}/{row.checks.length} checks passed"
								detail={row.checks.map((check) => ({
									state: check.ok === undefined ? 'pending' : check.ok ? 'passed' : 'failed',
									label: check.name,
									detail: check.detail
								}))}
							/>
						{/if}
					{:else if col === 'software'}
						{row.software}
					{:else if col === 'version'}
						{row.mcVersion ?? '–'}
					{:else if col === 'port'}
						<span class="mono">:{row.port}</span>
					{:else if col === 'memory'}
						{row.memory}
					{:else if col === 'cpu'}
						{#if row.cpu == null}
							<span class="dim">–</span>
						{:else}
							<ProgressBar compact value={row.cpu} color="auto" right="{row.cpu}%" />
						{/if}
					{:else if col === 'rss'}
						{#if row.rssMb == null}
							<span class="dim">–</span>
						{:else}
							<ProgressBar
								compact
								value={row.rssMb}
								max={hostMemMb || heapMb(row.memory) || row.rssMb}
								color="auto"
								right="{(row.rssMb / 1024).toFixed(1)} GB"
							/>
						{/if}
					{:else if col === 'tps'}
						{#if row.tps == null}
							<span class="dim">–</span>
						{:else}
							<span class="tps {tpsClass(row.tps)}">{row.tps.toFixed(2)}</span>
						{/if}
					{:else if col === 'heap'}
						{#if row.heapUsedMb == null || row.heapMaxMb == null}
							<span class="dim">–</span>
						{:else}
							<ProgressBar
								compact
								value={row.heapUsedMb}
								max={row.heapMaxMb}
								color="auto"
								right="{(row.heapUsedMb / 1024).toFixed(1)} GB"
							/>
						{/if}
					{:else if col === 'uptime'}
						{fmtDuration(row.uptimeMs)}
					{:else if col === 'players'}
						{row.players ? `${row.players.online}/${row.players.max}` : '–'}
					{:else if col === 'profile'}
						{row.profile}
					{:else if col === 'pid'}
						{row.javaPid ?? '–'}
					{/if}
				{/snippet}
			</ResourceTable>
		</Panel>

		{#if !one}
			<div class="hint dim">Select an instance to see its details in the split panel.</div>
		{/if}
	</div>

	{#if one}
		<DetailPanel
			title={one.name}
			subtitle="({one.software}{one.mcVersion ? ` ${one.mcVersion}` : ''})"
			href="/instances/{one.name}"
			bind:location={panelLocation}
			bind:size={panelSize}
			onclose={() => (selected = new Set())}
		>
			{#snippet actions()}
				<StatusBadge state={one.state} />
			{/snippet}
			<Tabs
				tabs={[
					{ id: 'details', label: 'Details' },
					{ id: 'checks', label: 'Status checks' },
					{ id: 'network', label: 'Networking' }
				]}
				bind:active={detailTab}
			/>
			<div class="detailbody">
				{#if detailTab === 'details'}
					<InfoGrid
						cells={detailCells}
						columns={panelLocation === 'right' ? [2, 2, 1] : [4, 3, 2]}
					>
						{#snippet custom(cell)}
							{#if cell.id === 'state'}<StatusBadge state={one.state} />{/if}
						{/snippet}
					</InfoGrid>
					{#if one.state === 'running'}
						<div class="meters">
							<ProgressBar left="CPU utilization" value={one.cpu ?? 0} color="auto" />
							<ProgressBar
								left="Resident memory"
								value={one.rssMb ?? 0}
								max={hostMemMb || heapMb(one.memory) || one.rssMb || 1}
								color="auto"
								right="{((one.rssMb ?? 0) / 1024).toFixed(1)} GB of {((hostMemMb || 0) / 1024).toFixed(0)} GB"
							/>
							{#if one.tps != null}
								<ProgressBar
									left="Tick rate"
									value={one.tps}
									max={20}
									color={tpsTone(one.tps)}
									right="{one.tps.toFixed(2)} of 20 TPS"
								/>
							{/if}
							{#if one.heapUsedMb != null && one.heapMaxMb != null}
								<ProgressBar
									left="JVM heap"
									value={one.heapUsedMb}
									max={one.heapMaxMb}
									color="auto"
									right="{(one.heapUsedMb / 1024).toFixed(1)} GB of {(one.heapMaxMb / 1024).toFixed(1)} GB"
								/>
							{/if}
						</div>
					{/if}
				{:else if detailTab === 'checks'}
					{#each one.checks as check}
						<div class="checkrow">
							<StatusBadge
								state={check.ok === undefined ? 'unknown' : check.ok ? 'passed' : 'failed'}
							/>
							<b>{check.name}</b>
							<span class="dim">{check.detail}</span>
						</div>
					{/each}
				{:else}
					<InfoGrid
						cells={networkCells}
						columns={panelLocation === 'right' ? [2, 2, 1] : [4, 3, 2]}
					/>
				{/if}
			</div>
		</DetailPanel>
	{/if}
</div>


<ScheduleQuickModal bind:open={scheduleOpen} instances={scheduleTargets} />

<style lang="scss">
	.meters {
		display: grid;
		grid-template-columns: repeat(2, minmax(12rem, 20rem));
		gap: 1rem 2rem;
		margin-top: 1.25rem;
		padding-top: 1rem;
		border-top: 0.1rem solid var(--border-divider);
	}
	.hint {
		margin-top: 1rem;
		text-align: center;
		font-size: 0.875rem;
	}

	// TPS is only meaningful against 20 — the colour carries that, the number alone doesn't
	.tps {
		font-variant-numeric: tabular-nums;

		&.good {
			color: var(--success);
		}

		&.fair {
			color: var(--warning);
		}

		&.poor {
			color: var(--error);
		}
	}

	// a min-height keeps the panel from resizing as tabs change
	.detailbody {
		padding-top: 1rem;
		min-height: 7.5rem;
	}

	.checkrow {
		display: flex;
		gap: 0.875rem;
		align-items: baseline;
		padding: 0.5rem 0;
		border-bottom: 0.1rem solid var(--border-divider);

		&:last-child {
			border-bottom: none;
		}
	}
</style>
