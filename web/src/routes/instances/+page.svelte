<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { instanceTabPath } from '$lib/components/instancetabs';
	import { api, type InstanceRow } from '$lib/api';
	import type { DistributionSegment } from '$lib/components/distribution';
	import { fmtDuration, cpuCeiling, fmtCpuPct } from '$lib/format';
	import { SOFTWARE_IDS, traitsOf } from '$core/software';
	import { parseMemoryMb } from '$core/memory';
	import SoftwareLabel from '$lib/components/SoftwareLabel.svelte';
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
	import DistributionBar from '$lib/components/DistributionBar.svelte';
	import ScheduleQuickModal from '$lib/components/ScheduleQuickModal.svelte';
	import DeleteInstanceModal from '$lib/components/DeleteInstanceModal.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import { instanceStateJob, type StateAction } from '$lib/instancejobs';
	import { onJobFlash } from '$lib/jobflash';

	type Row = InstanceRow & { externalOnly?: boolean };

	let rows: InstanceRow[] = $state([]);

	// the softwares present in the cluster right now, in the traits table's order
	const usedSoftware = $derived(
		SOFTWARE_IDS.filter((software) => rows.some((row) => row.software === software))
	);
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
	let deleteOpen = $state(false);
	let deleteTarget = $state('');
	/** name of the primary daemon; what "no owner" means in the registry */
	let hostName = $state('');

	/** Open the quick one-shot scheduler for the given instances. */
	function openScheduler(targets: string[]): void {
		if (!targets.length) {
			return;
		}

		scheduleTargets = targets;
		scheduleOpen = true;
	}

	/**
	 * Confirm a delete here rather than on the instance's own page; asking a
	 * question must not navigate away from the table the user is working in.
	 */
	function askDelete(target: string): void {
		deleteTarget = target;
		deleteOpen = true;
	}

	// external servers have a name and an address and nothing else; they are
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

	/**
	 * States whose instance still owns a live screen session, so stopping and
	 * restarting apply. An auto-restarting one is between JVMs, not down.
	 */
	const UP_STATES = ['running', 'starting', 'auto-restarting'];

	const selRows = $derived(rows.filter((row) => selected.has(row.name)));
	const anyStopped = $derived(selRows.some((row) => row.state === 'stopped'));
	const anyUp = $derived(
		selRows.some((row) => UP_STATES.includes(row.state ?? ''))
	);

	const filters: TableFilterGroup<Row>[] = $derived([
		{
			id: 'state',
			label: t('web.instances.filterState'),
			options: [
				{ value: 'any', label: t('web.instances.anyState') },
				{ value: 'running', label: t('web.instances.running'), match: (row) => row.state === 'running' },
				{ value: 'stopped', label: t('web.instances.stopped'), match: (row) => row.state === 'stopped' },
				{
					value: 'transitioning',
					label: t('web.instances.transitioning'),
					match: (row) =>
						row.state === 'starting' ||
						row.state === 'stopping' ||
						row.state === 'restarting' ||
						row.state === 'auto-restarting' ||
						row.state === 'provisioning' ||
						row.state === 'deleting'
				},
				{
					value: 'unhealthy',
					label: t('web.instances.failingChecks'),
					match: (row) => !!row.checks?.some((check) => check.ok === false)
				}
			]
		},
		{
			id: 'kind',
			label: t('web.instances.filterType'),
			options: [
				{ value: 'any', label: t('web.instances.anyType') },
				// one chip per software the cluster actually runs; listing all ten
				// when nine of them are unused is a filter nobody can use
				...usedSoftware.map((software) => ({
					value: software,
					label: t(traitsOf(software).label),
					match: (row: InstanceRow) => row.software === software
				})),
				{ value: 'external', label: t('web.instances.externalServers'), match: (row) => !!row.externalOnly }
			]
		}
	]);

	const columns: Column[] = $derived([
		{ id: 'name', label: t('web.common.name'), sortable: true, minWidth: 100 },
		{ id: 'state', label: t('web.instances.colState'), sortable: true },
		{ id: 'checks', label: t('web.instances.colChecks') },
		{ id: 'machine', label: t('web.instances.colMachine'), sortable: true },
		{ id: 'software', label: t('web.instances.colSoftware'), sortable: true },
		{ id: 'version', label: t('web.groups.colVersion'), sortable: true },
		{ id: 'port', label: t('web.instances.colPort'), sortable: true },
		{ id: 'memory', label: t('web.instances.colMemory') },
		{ id: 'cpu', label: 'CPU', sortable: true },
		{ id: 'rss', label: t('web.instances.colRss'), sortable: true },
		{ id: 'tps', label: 'TPS', sortable: true, width: 80, align: 'right' },
		// heap duplicates what Mem (RSS) already conveys at a glance, and thirteen
		// visible columns overflow the table; it is one gear-click away instead
		{ id: 'heap', label: t('web.instances.colHeap'), sortable: true, hidden: true },
		{ id: 'uptime', label: t('web.instances.colUptime'), sortable: true },
		{ id: 'players', label: t('web.instances.colPlayers'), sortable: true },
		{ id: 'profile', label: t('web.instances.colProfile'), hidden: true },
		{ id: 'pid', label: t('web.instances.colPid'), hidden: true }
	]);

	function sortValue(row: Row, col: string): string | number | null {
		switch (col) {
			case 'name':
				return row.name;

			// externals have no state, and sort last
			case 'state':
				return row.state ?? 'zz';

			case 'machine':
				return row.externalOnly ? 'zz' : (row.daemon ?? hostName);

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
			Notify.error(t('web.instances.refreshFailed'), { detail: (err as Error).message });
		}

		loading = false;
	}

	onMount(() => {
		void refresh();

		// the primary daemon's name is what a row with no owner belongs to
		void api('/host')
			.then((host) => (hostName = host.name ?? ''))
			.catch(() => {});

		// jobs this page did not start; a create finishing after the launch page
		// navigated here, a card's "Start now"; still change the table
		return onJobFlash(() => void refresh());
	});

	async function stateAction(action: StateAction): Promise<void> {
		// only act on rows the action can actually apply to
		const targets = selRows.filter((row) =>
			action === 'start' ? row.state === 'stopped' : UP_STATES.includes(row.state ?? '')
		);

		if (!targets.length) {
			return;
		}

		// one flash card per instance, each following its own job live
		await Promise.all(targets.map((target) => instanceStateJob(target.name, action)));

		await refresh();
	}

	/** Heap ceiling in MB, or 0 when the configured string cannot be read. */
	function heapMb(memory: string | undefined): number {
		return parseMemoryMb(memory) ?? 0;
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

	/** An instance's verbs; the row menu and the toolbar's Actions button. */
	function rowActions(row: Row): ContextMenuItem[] {
		const up = UP_STATES.includes(row.state ?? '');

		// a mid-provision instance has no directory or registry entry to act on yet
		const busy = row.state === 'provisioning' || row.state === 'deleting';
		const busyHint = busy ? `${row.name} is still ${row.state}` : undefined;

		return [
			{
				label: t('web.instances.connectConsole'),
				icon: 'code',
				disabled: busy,
				hint: busyHint,
				action: () => goto(`/instances/${row.name}/console`)
			},
			{
				label: t('web.instances.viewDetails'),
				icon: 'circleInfo',
				disabled: busy,
				hint: busyHint,
				action: () => goto(`/instances/${row.name}`)
			},
			{ separator: true },
			{
				label: t('web.instances.startInstance'),
				icon: 'play',
				disabled: row.state !== 'stopped',
				hint: row.state !== 'stopped' ? t('web.instances.alreadyState', { name: row.name, state: row.state ?? '' }) : undefined,
				action: () => stateAction('start')
			},
			{
				label: t('web.instances.stopInstance'),
				icon: 'stop',
				disabled: !up,
				hint: !up ? `${row.name} is not running` : undefined,
				action: () => stateAction('stop')
			},
			{
				label: t('web.instances.restartInstance'),
				icon: 'rotate',
				disabled: !up,
				hint: !up ? `${row.name} is not running` : undefined,
				action: () => stateAction('restart')
			},
			{
				label: t('web.instances.scheduleAction'),
				icon: 'clock',
				disabled: busy,
				hint: busyHint,
				action: () => openScheduler([row.name])
			},
			{ separator: true },
			{
				label: t('web.instances.manage'),
				icon: 'sliders',
				disabled: busy,
				hint: busyHint,
				submenu: [
					{
						label: t('web.nav.plugins'),
						icon: 'plug',
						action: () => goto(instanceTabPath(row.name, 'plugins'))
					},
					{
						label: t('web.instances.configuration'),
						icon: 'sliders',
						action: () => goto(instanceTabPath(row.name, 'config'))
					},
					{
						label: t('web.instances.networking'),
						icon: 'sitemap',
						action: () => goto(instanceTabPath(row.name, 'network'))
					},
					{
						label: t('web.instances.logs'),
						icon: 'scroll',
						action: () => goto(instanceTabPath(row.name, 'logs'))
					}
				]
			},
			{
				label: t('web.instances.copyAddress'),
				icon: 'copy',
				// the daemon resolves this to the owning machine's host; an external
				// server advertises its own, and a mid-provision row has none yet
				disabled: !(row.address ?? row.external),
				hint: (row.address ?? row.external) ? undefined : t('web.instances.noAddressYet'),
				action: () => navigator.clipboard?.writeText(row.address ?? row.external ?? '')
			},
			{ separator: true },
			{
				label: t('web.instances.deleteInstance'),
				icon: 'trash',
				color: 'danger',
				disabled: row.state !== 'stopped' || row.name === 'proxy',
				hint:
					row.name === 'proxy'
						? t('web.instances.proxyUndeletable')
						: row.state !== 'stopped'
							? t('web.instances.stopFirst')
							: undefined,
				action: () => askDelete(row.name)
			}
		];
	}

	/**
	 * A tick's budget at 20 TPS. The bar is scaled to it rather than to the worst
	 * sample, so a healthy server reads as a quarter-full bar every time instead of
	 * as whatever its own peak happened to be.
	 */
	const TICK_BUDGET_MS = 50;

	/**
	 * Entities split by whether they are ticked.
	 *
	 * The split is the useful part: non-ticking entities are nearly free, so a total
	 * on its own cannot tell a heavy farm from a warehouse full of item frames.
	 */
	const entitySegments: DistributionSegment[] = $derived.by(() => {
		if (!one) {
			return [];
		}

		const segments: DistributionSegment[] = [];

		if (one.tickingEntities != null) {
			segments.push({
				key: 'ticking',
				label: t('web.instances.tickingEntities'),
				count: one.tickingEntities,
				color: 'var(--warning)'
			});
		}

		if (one.nonTickingEntities != null) {
			segments.push({
				key: 'nonticking',
				label: t('web.instances.nonTickingEntities'),
				count: one.nonTickingEntities,
				color: 'var(--link)'
			});
		}

		return segments;
	});

	/**
	 * How stale the heartbeat figures are, ms.
	 *
	 * Null when the plugin has never reported: an absent heartbeat and a very old
	 * one mean different things, and both differ from "reported a second ago".
	 */
	const telemetryAge = $derived(one?.lastHeartbeatMs ? Date.now() - one.lastHeartbeatMs : null);

	const detailCells: InfoCell[] = $derived.by(() => {
		if (!one) {
			return [];
		}

		return [
			{ id: 'state', label: t('web.instances.colState') },
			// what the proxy thinks, which is what a player actually meets; a running
			// backend held in maintenance is invisible in the state above
			{
				label: t('web.instances.networkStatus'),
				value: one.lunaStatus || t('web.instances.notReporting')
			},
			{ label: t('web.instances.colSoftware'), value: `${one.software} ${one.mcVersion ?? ''}` },
			{
				label: t('web.instances.colMachine'),
				value: one.daemon ?? hostName,
				href: (one.daemon ?? hostName) ? `/machines/${one.daemon ?? hostName}` : undefined
			},
			{ label: t('web.instances.gameAddress'), value: one.address, copyable: true, style: 'mono' },
			{
				label: t('web.instances.colPlayers'),
				value: one.players ? `${one.players.online}/${one.players.max}` : null
			},
			{ label: t('web.instances.colUptime'), value: fmtDuration(one.uptimeMs) },
			{ label: t('web.instances.memoryHeap'), value: one.memory },
			{ label: t('web.instances.colProfile'), value: one.profile },
			{
				label: t('web.instances.cpuCores'),
				value: one.cpuCores === null ? null : String(one.cpuCores)
			},
			{ label: t('web.instances.colPid'), value: one.javaPid },
			// how old the figures below are: a stale heartbeat is why a panel shows a
			// healthy 20 TPS for a server that stopped answering minutes ago
			{
				label: t('web.instances.telemetry'),
				value:
					telemetryAge === null
						? t('web.instances.notReporting')
						: t('web.instances.agoOf', { age: fmtDuration(telemetryAge) })
			},
			{
				label: t('web.instances.protocol'),
				value: one.pingVersion
			},
			{ label: t('web.instances.directory'), value: one.dir, copyable: true, style: 'mono' }
		];
	});

	const networkCells: InfoCell[] = $derived.by(() => {
		if (!one) {
			return [];
		}

		const registration = one.proxy?.register
			? t('web.instances.registered')
			: one.name === 'proxy'
				? t('web.instances.isTheProxy')
				: t('web.instances.notRegistered');

		const forcedHosts = one.proxy?.forcedHosts?.length
			? [{ label: t('web.instances.forcedHosts'), value: one.proxy.forcedHosts.join(', ') }]
			: [];

		return [
			{ label: t('web.instances.gamePort'), value: `tcp/${one.port}`, style: 'mono' },
			...Object.entries(one.ports).map(([key, port]) => ({
				label: key,
				value: String(port),
				style: 'mono' as const
			})),
			{ label: t('web.instances.proxyRegistration'), value: registration },
			...forcedHosts
		];
	});
</script>

<svelte:head><title>{t('web.nav.instancesList')} | Luna Console</title></svelte:head>

<div class="split-view">
	<div class="main-col">
		<PageHeader
			title={t('web.nav.instancesList')}
			count="{selected.size ? `${selected.size}/` : ''}{allRows.length}"
			info
		>
			{#snippet actions()}
				<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="instances" />
				<Btn disabled={!one} onclick={() => one && goto(`/instances/${one.name}/console`)}>{t('web.instances.connect')}</Btn>
				<Dropdown
					label={t('web.instances.colState')}
					disabled={selected.size === 0}
					items={[
						{
							label: t('web.instances.startInstance'), icon: 'play', disabled: !anyStopped,
							action: () => stateAction('start')
						},
						{
							label: t('web.instances.stopInstance'), icon: 'stop', disabled: !anyUp,
							action: () => stateAction('stop')
						},
						{
							label: t('web.instances.restartInstance'), icon: 'rotate', disabled: !anyUp,
							action: () => stateAction('restart')
						},
						{ divider: true, label: '' },
						{
							label: t('web.instances.scheduleAction'), icon: 'clock',
							action: () => openScheduler(selRows.map((row) => row.name))
						}
					]}
				/>
				<!-- the selection's verbs are the row's verbs; one declaration, two
				     places to reach it (here and the row's context menu) -->
				<Dropdown label={t('web.common.actions')} disabled={!one} menu={one ? rowActions(one) : []} />
				<SplitButton
					label={t('web.nav.launchInstance')}
					onclick={() => goto('/instances/launch')}
					items={[
						{
							label: t('web.instances.launchWizard'), icon: 'rocket',
							action: () => goto('/instances/launch')
						},
						{ label: t('web.instances.cloneSelected'), icon: 'copy', disabled: true }
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
					`${row.name} ${row.state ?? 'external'} ${row.software ?? ''} ${row.mcVersion ?? ''} ${row.port ?? row.external ?? ''} ${row.daemon ?? hostName}`}
				searchPlaceholder={t('web.instances.searchPlaceholder')}
				selectable="multi"
				bind:selected
				{rowActions}
				rowLabel={(row) => row.name}
				noun={t('web.instances.noun')}
				{sortValue}
				rowLocked={(row) => !!row.externalOnly}
				{filters}
				pageSize={25}
				emptyTitle={t('web.instances.emptyTitle')}
				emptyText={t('web.instances.emptyText')}
			>
				{#snippet cell(row, col)}
					{#if row.externalOnly}
						{#if col === 'name'}
							{row.name}
						{:else if col === 'state'}
							<StatusBadge state="external" label={t('web.instances.external')} />
						{:else if col === 'checks'}
							<!-- externals run elsewhere, so LunaCore's heartbeat is the only
							     thing that can say whether they are actually up -->
							{#if !row.lunaStatus}
								<span class="dim">–</span>
							{:else if row.lunaStatus === 'ONLINE'}
								<StatusBadge
									state="passed"
									label={t('web.instances.heartbeatOk')}
									detail={[
										{
											state: 'passed', label: t('web.instances.lunaHeartbeat'),
											detail: `${(row.tps ?? 0).toFixed(2)} TPS · ${row.players?.online ?? 0}/${row.players?.max ?? 0} players`
										}
									]}
								/>
							{:else}
								<StatusBadge
									state="warning"
									label={t('web.instances.noHeartbeat')}
									detail={[
										{
											state: 'failed', label: t('web.instances.lunaHeartbeat'), detail: t('web.instances.noHeartbeatDetail')
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
						<!-- paused refines running rather than replacing it: verbs and
						     filters still treat the instance as up -->
						<StatusBadge state={row.paused && row.state === 'running' ? 'paused' : row.state} />
					{:else if col === 'checks'}
						{#if row.state === 'stopped'}
							<span class="dim">–</span>
						{:else}
							{@const passed = row.checks.filter((check) => check.ok).length}
							<StatusBadge
								state={passed === row.checks.length ? 'passed' : 'warning'}
								label={t('web.instances.checksPassed', { passed, total: row.checks.length })}
								detail={row.checks.map((check) => ({
									state: check.ok === undefined ? 'pending' : check.ok ? 'passed' : 'failed',
									label: check.name, detail: check.detail
								}))}
							/>
						{/if}
					{:else if col === 'machine'}
						{@const machine = row.daemon ?? hostName}
						{#if machine}
							<a href="/machines/{machine}" onclick={(event) => event.stopPropagation()}>
								{machine}
							</a>
						{:else}
							<span class="dim">–</span>
						{/if}
					{:else if col === 'software'}
						<SoftwareLabel software={row.software} short />
					{:else if col === 'version'}
						{row.mcVersion ?? '–'}
					{:else if col === 'port'}
						{#if row.port == null}
							<span class="dim">–</span>
						{:else}
							<span class="mono">:{row.port}</span>
						{/if}
					{:else if col === 'memory'}
						{row.memory}
					{:else if col === 'cpu'}
						{#if row.cpu == null}
							<span class="dim">–</span>
						{:else}
							<ProgressBar
								compact
								value={row.cpu}
								max={cpuCeiling(row.cpuCores)}
								color="auto"
								right={fmtCpuPct(row.cpu)}
							/>
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
			<div class="hint dim">{t('web.instances.selectHint')}</div>
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
					{ id: 'details', label: t('web.instances.details') },
					{ id: 'checks', label: t('web.instances.statusChecks') },
					{ id: 'network', label: t('web.instances.networking') }
				]}
				bind:active={detailTab}
			/>
			<div class="detailbody">
				{#if detailTab === 'details'}
					{#if one.state === 'running'}
						<div class="meters">
							<ProgressBar
								left={t('web.instances.cpuUtilization')}
								value={one.cpu ?? 0}
								max={cpuCeiling(one.cpuCores)}
								color="auto"
								right={fmtCpuPct(one.cpu ?? 0)}
							/>
							<ProgressBar
								left={t('web.instances.residentMemory')}
								value={one.rssMb ?? 0}
								max={hostMemMb || heapMb(one.memory) || one.rssMb || 1}
								color="auto"
								right={t('web.instances.gbOfGb', { used: ((one.rssMb ?? 0) / 1024).toFixed(1), total: ((hostMemMb || 0) / 1024).toFixed(0) })}
							/>
							{#if one.tps != null}
								<ProgressBar
									left={t('web.instances.tickRate')}
									value={one.tps}
									max={20}
									color={tpsTone(one.tps)}
									right={t('web.instances.tpsOf20', { tps: one.tps.toFixed(2) })}
								/>
							{/if}
							{#if one.heapUsedMb != null && one.heapMaxMb != null}
								<ProgressBar
									left={t('web.instances.jvmHeap')}
									value={one.heapUsedMb}
									max={one.heapMaxMb}
									color="auto"
									right={t('web.instances.gbOfGb', { used: (one.heapUsedMb / 1024).toFixed(1), total: (one.heapMaxMb / 1024).toFixed(1) })}
								/>
							{/if}
							<!-- the figure TPS stops being able to express: TPS floors at 20 while
							     tick duration keeps climbing, so a server at 20 TPS and 45 ms is
							     already one bad chunk away from stuttering -->
							{#if one.msptMean != null}
								<ProgressBar
									left={t('web.instances.tickDuration')}
									value={one.msptMean}
									max={TICK_BUDGET_MS}
									color={one.msptMean <= 25 ? 'success' : one.msptMean <= 40 ? 'warning' : 'danger'}
									right={t('web.instances.msMeanMax', {
										mean: one.msptMean.toFixed(1),
										max: one.msptMax == null ? '–' : one.msptMax.toFixed(1)
									})}
								/>
							{/if}
						</div>

						{#if entitySegments.length > 0 || one.chunks != null}
							<div class="worldload">
								<div class="loadhead">
									{t('web.instances.worldLoad')}
									{#if one.chunks != null}
										<span class="dim">
											{t('web.instances.chunksLoaded', { count: one.chunks.toLocaleString() })}
										</span>
									{/if}
									{#if one.worlds.length > 0}
										<span class="dim">
											{t('web.instances.worldCount', { count: String(one.worlds.length) })}
										</span>
									{/if}
								</div>
								{#if entitySegments.length > 0}
									<DistributionBar
										segments={entitySegments}
										empty={t('web.instances.noEntities')}
									/>
								{/if}
							</div>
						{/if}
					{/if}
					<InfoGrid
						cells={detailCells}
						columns={panelLocation === 'right' ? [2, 2, 1] : [4, 3, 2]}
					>
						{#snippet custom(cell)}
							{#if cell.id === 'state'}<StatusBadge state={one.state} />{/if}
						{/snippet}
					</InfoGrid>
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

<DeleteInstanceModal
	bind:open={deleteOpen}
	name={deleteTarget}
	ondeleted={(target) => {
		// the row reads "deleting" until the job finishes and then disappears;
		// drop it from the selection so the detail panel is not left holding it
		selected = new Set([...selected].filter((id) => id !== target));

		void refresh();
	}}
/>

<style lang="scss">
	// first in the tab: the live figures are what changes and what the panel is
	// opened for, so the identity grid sits under them rather than above
	.meters {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(14rem, 20rem));
		gap: 1rem 2rem;
		margin-bottom: 1.25rem;
	}

	.worldload {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		margin-bottom: 1.25rem;
		padding-bottom: 1.25rem;
		border-bottom: 0.1rem solid var(--border-divider);
	}

	.loadhead {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.75rem;
		font-size: 0.75rem;
		font-weight: 700;
		color: var(--text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.05rem;

		// the counts beside the heading are data, not part of the label
		.dim {
			font-weight: 400;
			text-transform: none;
			letter-spacing: normal;
		}
	}

	.hint {
		margin-top: 1rem;
		text-align: center;
		font-size: 0.875rem;
	}

	// TPS is only meaningful against 20; the colour carries that, the number alone doesn't
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
