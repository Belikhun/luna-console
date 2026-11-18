<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';

	import { t, tSplit } from '$lib/i18n.svelte';
	import { api, del, post } from '$lib/api';
	import { fmtBytes, fmtDuration } from '$lib/format';
	import Btn from '$lib/components/Btn.svelte';
	import CellStack from '$lib/components/CellStack.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import DateTime from '$lib/components/DateTime.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import MiniSpark from '$lib/components/MiniSpark.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import OverviewBar from '$lib/components/OverviewBar.svelte';
	import OverviewCell from '$lib/components/OverviewCell.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import ProgressBar from '$lib/components/ProgressBar.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import ScreenLink from '$lib/components/ScreenLink.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import { jobFlash } from '$lib/jobflash';
	import { checksFailed, checksPassed, diskPct, latencyTone, linkBadge, memPct, swapPct } from '$lib/daemons';
	import { withCopyResourceId } from '$lib/resourceid';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import type { DistributionSegment } from '$lib/components/distribution';
	import { menuGroups, type ContextMenuItem } from '$lib/components/contextmenu';
	import type { DaemonRow, HealthSample, UpgradeResult } from '$client/daemon';
	import { resourceId } from '$shared/iam/resources';
	import {
		MB,
		checkRows,
		checksLabel,
		checksState,
		instanceSegments,
		machineHref,
		removeRefusal,
		roleLabel,
		runningCount,
		shareColor,
		sparkSeries,
		upgradeRefusal
	} from './machines';

	/**
	 * Every machine of the cluster: a strip of how the fleet stands, then a row
	 * per machine with its state, its checks, what runs there and how loaded it
	 * is, each load figure beside its last hour.
	 */

	let daemons = $state.raw<DaemonRow[]>([]);
	let histories = $state.raw<Record<string, HealthSample[]>>({});
	let loaded = $state(false);
	let loading = $state(false);
	let failure = $state('');
	let lastUpdated: number | null = $state(null);
	let selected: Set<string> = $state(new Set());

	let joinOpen = $state(false);
	let removeTarget: DaemonRow | undefined = $state();
	let removeOpen = $state(false);
	let upgradeOpen = $state(false);
	let upgrading = $state(false);
	let upgradeTargets: DaemonRow[] = $state([]);

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const data = await api('/daemons');

			daemons = data.daemons;
			failure = '';
			lastUpdated = Date.now();

			await loadHistories(data.daemons);
		} catch (err) {
			failure = (err as Error).message;
		} finally {
			loading = false;
			loaded = true;
		}
	}

	/** Each connected machine's sampled hour, for the small charts; a machine that does not answer keeps the hour it had. */
	async function loadHistories(rows: DaemonRow[]): Promise<void> {
		const connected = rows.filter((row) => row.state !== 'offline');
		const next: Record<string, HealthSample[]> = {};

		await Promise.all(
			connected.map(async (row) => {
				try {
					const detail = await api(`/daemons/${encodeURIComponent(row.name)}`);

					next[row.name] = detail.history ?? [];
				} catch {
					const kept = histories[row.name];

					if (kept) {
						next[row.name] = kept;
					}
				}
			})
		);

		histories = next;
	}

	onMount(() => {
		void refresh();
	});

	// -- the fleet strip --------------------------------------------------------------

	const connected = $derived(daemons.filter((row) => row.state !== 'offline'));
	const primary = $derived(daemons.find((row) => row.mode === 'primary'));
	const behind = $derived(daemons.filter((row) => row.outdated));

	const stateSegments: DistributionSegment[] = $derived([
		{
			key: 'online',
			label: t('web.fleet.machineState.online'),
			count: daemons.filter((row) => row.state === 'online' && checksFailed(row) === 0).length,
			color: 'var(--success)'
		},
		{
			key: 'degraded',
			label: t('web.machines.degraded'),
			count: daemons.filter((row) => row.state === 'online' && checksFailed(row) > 0).length,
			color: 'var(--warning)'
		},
		{
			key: 'quarantined',
			label: t('web.fleet.machineState.quarantined'),
			count: daemons.filter((row) => row.state === 'quarantined').length,
			color: 'var(--error)'
		},
		{
			key: 'offline',
			label: t('web.fleet.machineState.offline'),
			count: daemons.filter((row) => row.state === 'offline').length,
			color: 'var(--text-disabled)'
		}
	]);

	const checkTotals = $derived({
		total: daemons.reduce((sum, row) => sum + row.checks.length, 0),
		passed: daemons.reduce((sum, row) => sum + checksPassed(row), 0),
		failed: daemons.reduce((sum, row) => sum + checksFailed(row), 0)
	});

	const memoryTotals = $derived({
		used: connected.reduce((sum, row) => sum + (row.health?.memUsedMb ?? 0), 0),
		total: connected.reduce((sum, row) => sum + (row.health?.memTotalMb ?? 0), 0)
	});

	// -- the table --------------------------------------------------------------------

	const filters: TableFilterGroup<DaemonRow>[] = $derived([
		{
			id: 'state',
			label: t('web.machines.filterState'),
			options: [
				{ value: 'any', label: t('web.machines.anyState') },
				{ value: 'online', label: t('web.fleet.machineState.online'), match: (row) => row.online },
				{
					value: 'offline',
					label: t('web.fleet.machineState.offline'),
					match: (row) => row.state === 'offline'
				},
				{
					value: 'quarantined',
					label: t('web.fleet.machineState.quarantined'),
					match: (row) => row.state === 'quarantined'
				},
				{
					value: 'degraded',
					label: t('web.machines.degraded'),
					match: (row) => row.online && checksFailed(row) > 0
				},
				{
					value: 'outdated',
					label: t('web.machines.behindPrimary'),
					match: (row) => row.outdated
				}
			]
		},
		{
			id: 'mode',
			label: t('web.machines.filterRole'),
			options: [
				{ value: 'any', label: t('web.machines.anyRole') },
				{ value: 'primary', label: t('web.fleet.primary'), match: (row) => row.mode === 'primary' },
				{ value: 'follower', label: t('web.fleet.follower'), match: (row) => row.mode === 'follower' }
			]
		}
	]);

	const columns: Column[] = $derived([
		{ id: 'name', label: t('web.instances.colMachine'), minWidth: 150, sortable: true },
		{ id: 'state', label: t('web.common.state'), width: 130, sortable: true },
		{ id: 'checks', label: t('web.machines.colChecks'), width: 150, sortable: true },
		{ id: 'instances', label: t('web.fleet.instances'), minWidth: 200, sortable: true },
		{ id: 'cpu', label: t('web.machines.colCpu'), width: 160, align: 'right', sortable: true },
		{ id: 'memory', label: t('web.fleet.memory'), width: 200, sortable: true },
		// hidden by default: most of the fleet runs without swap, and a column of
		// "no swap" cells costs width the memory and disk bars can use
		{ id: 'swap', label: t('web.fleet.swap'), width: 200, sortable: true, hidden: true },
		{ id: 'disk', label: t('web.fleet.disk'), width: 200, sortable: true },
		{ id: 'load', label: t('web.fleet.load'), width: 110, align: 'right', sortable: true, hidden: true },
		{ id: 'latency', label: t('web.fleet.latency'), width: 160, align: 'right', sortable: true },
		{ id: 'version', label: t('web.fleet.version'), width: 180, sortable: true },
		// hidden by default: a connected machine was seen a second ago, and one that
		// is not says when under its state
		{ id: 'seen', label: t('web.machines.colSeen'), width: 160, hidden: true },
		{ id: 'host', label: t('web.machines.colHost'), width: 150, hidden: true },
		{ id: 'uptime', label: t('web.fleet.hostUptime'), width: 130, sortable: true, hidden: true }
	]);

	/** How many instance names a row lists before sending the reader to the machine's own tab. */
	const NAMES_SHOWN = 4;

	/** The instances a row names: the running ones first, since they are what the machine is busy with. */
	function shownInstances(row: DaemonRow): string[] {
		const states = row.health?.states ?? {};
		const running = row.instances.filter((name) => states[name] === 'running');
		const rest = row.instances.filter((name) => states[name] !== 'running');

		return [...running, ...rest].slice(0, NAMES_SHOWN);
	}

	const lastSeen = $derived(tSplit('web.machines.lastSeenAt', 'time'));

	/** Sort keys for the columns that draw a bar or a chart rather than text. */
	function sortValue(row: DaemonRow, col: string): string | number | null {
		switch (col) {
			case 'name':
				return row.name;

			case 'state':
				return row.state;

			// trouble first, which is the reason to sort on this column
			case 'checks':
				return checksFailed(row) * 100 + (row.checks.length - checksPassed(row));

			case 'instances':
				return row.instances.length;

			case 'cpu':
				return row.health?.cpuPct ?? -1;

			case 'memory':
				return memPct(row.health) ?? -1;

			case 'swap':
				return swapPct(row.health) ?? -1;

			case 'disk':
				return diskPct(row.health) ?? -1;

			case 'load':
				return row.health?.load1 ?? -1;

			case 'latency':
				return row.latencyMs ?? -1;

			case 'version':
				return row.version ?? '';

			case 'uptime':
				return row.health?.uptimeSec ?? -1;

			default:
				return null;
		}
	}

	// -- verbs --------------------------------------------------------------------------

	const selRows = $derived(daemons.filter((row) => selected.has(row.name)));
	const outdatedRows = $derived(daemons.filter((row) => row.outdated && !upgradeRefusal(row)));

	/** The verbs of a selection: one machine's, or the bulk form over several. */
	function machineActions(rows: DaemonRow[]): ContextMenuItem[] {
		const only = rows.length === 1
			? rows[0]
			: undefined;

		const pickOne = only
			? undefined
			: t('web.machines.pickOne');

		const upgradable = rows.filter((row) => !upgradeRefusal(row));
		const removal = only
			? removeRefusal(only)
			: pickOne;

		const upgradeLabel = only
			? only.outdated
				? t('web.machines.upgradeDaemon')
				: t('web.machines.reinstallBuild')
			: t('web.machines.upgradeCount', { count: String(upgradable.length) });

		const upgradeHint = only
			? (upgradeRefusal(only) ?? only.quarantine ?? undefined)
			: upgradable.length === 0
				? t('web.machines.refusal.noneUpgradable')
				: undefined;

		return menuGroups(
			[
				{
					label: t('web.machines.openMachine'),
					icon: 'circleInfo',
					disabled: !only,
					hint: pickOne,
					action: () => goto(machineHref(only!.name))
				},
				{
					label: t('web.nav.monitoring'),
					icon: 'chartLine',
					disabled: !only,
					hint: pickOne,
					action: () => goto(machineHref(only!.name, 'monitoring'))
				},
				{
					label: t('web.events.title'),
					icon: 'clockRotateLeft',
					disabled: !only,
					hint: pickOne,
					action: () => goto(machineHref(only!.name, 'events'))
				}
			],
			[
				{
					label: upgradeLabel,
					icon: 'download',
					disabled: upgrading || upgradable.length === 0,
					hint: upgradeHint,
					action: () => askUpgrade(upgradable)
				}
			],
			[
				{
					id: 'copy-host',
					label: t('web.machines.copyRoutingHost'),
					icon: 'copy',
					disabled: !only?.host,
					hint: pickOne,
					action: () => navigator.clipboard?.writeText(only?.host ?? '')
				},
				{
					id: 'copy-addresses',
					label: t('web.machines.copyIpAddresses'),
					icon: 'copy',
					disabled: !only || only.addresses.length === 0,
					hint: pickOne,
					action: () => navigator.clipboard?.writeText(only?.addresses.join(', ') ?? '')
				}
			],
			[
				{
					label: t('web.machines.removeRegistration'),
					icon: 'trash',
					color: 'danger',
					disabled: !!removal,
					hint: removal,
					action: () => openRemove(only!)
				}
			]
		);
	}

	/** A right-clicked row inside the selection acts on the whole selection. */
	function rowActions(row: DaemonRow): ContextMenuItem[] {
		return selected.has(row.name) && selRows.length > 1
			? machineActions(selRows)
			: machineActions([row]);
	}

	function openRemove(row: DaemonRow): void {
		removeTarget = row;
		removeOpen = true;
	}

	async function remove(): Promise<void> {
		const target = removeTarget;

		if (!target) {
			return;
		}

		try {
			await del(`/daemons/${encodeURIComponent(target.name)}`);

			Notify.success(t('web.machines.removedRegistration', { name: target.name }));
			selected = new Set();

			await refresh();
		} catch (err) {
			Notify.error(t('web.machines.removeFailed'), { detail: (err as Error).message });
		}
	}

	/** Open the confirmation for a set of targets, ignoring an empty one. */
	function askUpgrade(targets: DaemonRow[]): void {
		if (targets.length === 0) {
			return;
		}

		upgradeTargets = targets;
		upgradeOpen = true;
	}

	/**
	 * Upgrade each target in turn, one job card each.
	 *
	 * Sequential on purpose: every one of these exits as it answers and comes
	 * back on the new build, and taking the whole fleet down at once would leave
	 * nothing serving while they restart.
	 */
	async function runUpgrade(): Promise<void> {
		const targets = upgradeTargets;

		upgrading = true;
		upgradeOpen = false;

		for (const [index, row] of targets.entries()) {
			await jobFlash({
				title: t('web.machines.upgradingOne', {
					name: row.name,
					index: index + 1,
					total: targets.length
				}),
				start: () =>
					post(`/daemons/${encodeURIComponent(row.name)}`, {
						action: 'upgrade',
						force: !row.outdated
					}),
				success: (result) => {
					const outcome = result as UpgradeResult;

					return {
						message: t('web.machines.upgraded', { name: row.name }),
						detail: `${outcome.from} → ${outcome.to} · ${outcome.origin}`
					};
				},
				failure: () => ({ message: t('web.machines.upgradeFailed', { name: row.name }) })
			});
		}

		upgrading = false;
		selected = new Set();

		await refresh();
	}

	// -- adding a follower --------------------------------------------------------------

	/** The daemon.json a new follower needs, filled in from this primary's row. */
	const joinConfig = $derived.by(() => {
		const listen = primary?.host ?? '0.0.0.0:8331';
		const port = listen.slice(listen.lastIndexOf(':') + 1);
		const address = `${primary?.addresses[0] ?? '10.0.0.10'}:${port}`;

		return JSON.stringify(
			{
				mode: 'follower',
				root: '/srv/luna',
				primary: { address },
				token: t('web.machines.join.tokenPlaceholder')
			},
			null,
			2
		);
	});

	const joinSave = $derived(tSplit('web.machines.join.stepSave', 'path'));
	const joinRun = $derived(tSplit('web.machines.join.stepRun', 'command'));
	const joinToken = $derived(tSplit('web.machines.join.token', 'command'));
</script>

<svelte:head><title>{t('web.machines.title')} | Luna Console</title></svelte:head>

<PageHeader
	title={t('web.machines.title')}
	count="{selected.size ? `${selected.size}/` : ''}{daemons.length}"
	description={t('web.machines.description')}
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="daemons" />
		<Dropdown
			label={t('web.common.actions')}
			disabled={selRows.length === 0}
			title={selRows.length === 0 ? t('web.machines.pickFirst') : undefined}
			header={selRows.length === 1 ? selRows[0]!.name : undefined}
			menu={selRows.length === 0
				? []
				: withCopyResourceId(
					machineActions(selRows),
					selRows.map((row) => resourceId('machine', row.name))
				)}
		/>
		<Btn
			icon="circleUp"
			disabled={upgrading || outdatedRows.length === 0}
			title={outdatedRows.length === 0 ? t('web.machines.noneOutdated') : undefined}
			onclick={() => askUpgrade(outdatedRows)}
		>
			{t('web.machines.upgradeOutdated', { count: String(outdatedRows.length) })}
		</Btn>
		<Btn variant="primary" icon="plus" onclick={() => (joinOpen = true)}>{t('web.machines.addFollower')}</Btn>
	{/snippet}
</PageHeader>

{#if failure}
	<Flash kind="error">{t('web.machines.loadFailed')}: {failure}</Flash>
{/if}

<OverviewBar title={t('web.fleet.title')}>
	<OverviewCell label={t('web.machines.title')} segments={loaded ? stateSegments : undefined} segmentsEmpty={t('web.fleet.noMachines')}>
		{#if !loaded}
			<span class="dim">–</span>
		{/if}
	</OverviewCell>
	<OverviewCell
		label={t('web.machines.colChecks')}
		progress={checkTotals.total ? checkTotals.passed / checkTotals.total : undefined}
		progressColor={checkTotals.failed ? 'var(--warning)' : 'var(--success)'}
	>
		{#if !loaded || checkTotals.total === 0}
			<span class="dim">–</span>
		{:else}
			<span>{t('web.machines.checksPassed', { passed: String(checkTotals.passed), total: String(checkTotals.total) })}</span>
			{#if checkTotals.failed > 0}
				<span class="bad">{t('web.machines.checksFailing', { count: String(checkTotals.failed) })}</span>
			{/if}
		{/if}
	</OverviewCell>
	<OverviewCell label={t('web.fleet.instances')} segments={loaded ? instanceSegments(daemons) : undefined} segmentsEmpty={t('web.fleet.noInstances')}>
		{#if !loaded}
			<span class="dim">–</span>
		{/if}
	</OverviewCell>
	<OverviewCell
		label={t('web.machines.memoryInUse')}
		progress={memoryTotals.total ? memoryTotals.used / memoryTotals.total : undefined}
		progressColor={memoryTotals.total ? shareColor(memoryTotals.used / memoryTotals.total) : undefined}
	>
		{#if memoryTotals.total === 0}
			<span class="dim">–</span>
		{:else}
			<span class="mono">{t('web.machines.usedOf', {
				used: fmtBytes(memoryTotals.used * MB),
				total: fmtBytes(memoryTotals.total * MB)
			})}</span>
		{/if}
	</OverviewCell>
	<OverviewCell label={t('web.fleet.version')}>
		{#if !primary}
			<span class="dim">–</span>
		{:else}
			<span class="mono">{primary.version ?? '–'}</span>
			{#if behind.length > 0}
				<StatusBadge
					state="warning"
					label={t('web.machines.behindCount', { count: String(behind.length) })}
					detail={behind.map((row) => `${row.name}: ${row.version ?? '–'}`)}
				/>
			{:else}
				<StatusBadge state="passed" label={t('web.machines.allCurrent')} />
			{/if}
		{/if}
	</OverviewCell>
</OverviewBar>

{#if loaded && !failure && daemons.length === 1}
	<Flash kind="info">{t('web.machines.noFollowers')}</Flash>
{/if}

<Panel flush>
	<ResourceTable
		tableId="daemons"
		{columns}
		rows={daemons}
		loading={!loaded}
		getId={(row) => row.name}
		searchValue={(row) =>
			`${row.name} ${row.mode} ${row.host ?? ''} ${row.addresses.join(' ')} ${row.instances.join(' ')} ${row.version ?? ''}`}
		searchPlaceholder={t('web.machines.search')}
		{filters}
		selectable="multi"
		bind:selected
		{rowActions}
		rowLabel={(row) => row.name}
		resourceId={(row) => resourceId('machine', row.name)}
		noun={t('web.fleet.machineNoun')}
		{sortValue}
		defaultSort={{ col: 'name' }}
		rowDim={(row) => row.state === 'offline'}
		onRowClick={(row) => goto(machineHref(row.name))}
		emptyTitle={t('web.fleet.noMachines')}
	>
		{#snippet cell(row, col)}
			{@const health = row.health}
			{@const history = histories[row.name]}
			{#if col === 'name'}
				<CellStack>
					{#snippet main()}
						<a href={machineHref(row.name)}><b>{row.name}</b></a>
					{/snippet}
					{#snippet sub()}
						{roleLabel(row)}
					{/snippet}
				</CellStack>
			{:else if col === 'state'}
				{@const badge = linkBadge(row)}
				<CellStack>
					{#snippet main()}
						<StatusBadge state={badge.state} label={badge.label} detail={row.quarantine ?? undefined} />
					{/snippet}
					{#snippet sub()}
						{#if row.state === 'offline' && row.lastSeen}
							{lastSeen.before}<DateTime at={row.lastSeen} />{lastSeen.after}
						{/if}
					{/snippet}
				</CellStack>
			{:else if col === 'checks'}
				{#if row.checks.length === 0}
					<span class="dim">–</span>
				{:else}
					<StatusBadge state={checksState(row)} label={checksLabel(row)} detail={checkRows(row)} />
				{/if}
			{:else if col === 'instances'}
				{#if row.instances.length === 0}
					<span class="dim">{t('web.common.none')}</span>
				{:else}
					<span class="owned">
						<span>
							{t('web.machines.runningOf', {
								running: String(runningCount(row)),
								total: String(row.instances.length)
							})}
						</span>
						<span class="names">
							{#each shownInstances(row) as name (name)}
								<ScreenLink href="/instances/{encodeURIComponent(name)}">{name}</ScreenLink>
							{/each}
							{#if row.instances.length > NAMES_SHOWN}
								<a href={machineHref(row.name, 'instances')}>
									{t('web.fleet.moreReasons', { count: String(row.instances.length - NAMES_SHOWN) })}
								</a>
							{/if}
						</span>
					</span>
				{/if}
			{:else if col === 'latency'}
				{#if row.latencyMs === null}
					<span class="dim">{row.mode === 'primary' ? t('web.machines.local') : '–'}</span>
				{:else}
					{@const series = sparkSeries(history, 'latency', 'ms', (sample) => sample.latencyMs)}
					<span class="chartcell">
						<span class="figure mono" data-tone={latencyTone(row.latencyMs)}>{Math.round(row.latencyMs)} ms</span>
						<span class="strip">
							{#if series}
								<MiniSpark {series} label={t('web.fleet.latency')} width={4} height={1.5} formatValue={(value) => `${Math.round(value)} ms`} />
							{/if}
						</span>
					</span>
				{/if}
			{:else if col === 'version'}
				<CellStack>
					{#snippet main()}
						<span class="mono">{row.version ?? '–'}</span>
						{#if row.outdated}
							<StatusBadge state="warning" label={t('web.machines.behind')} detail={t('web.machines.behindPrimary')} />
						{/if}
					{/snippet}
					{#snippet sub()}
						{#if row.protocol !== null}
							{t('web.machines.protocolOf', { protocol: String(row.protocol) })}
						{/if}
					{/snippet}
				</CellStack>
			{:else if col === 'seen'}
				{#if row.state === 'offline'}
					<DateTime at={row.lastSeen} empty={t('web.machines.neverSeen')} />
				{:else if row.lastBeatMs === null}
					<span class="dim">{t('web.machines.thisMachine')}</span>
				{:else}
					<span class="dim">{t('web.machines.beatAgo', { seconds: String(Math.round(row.lastBeatMs / 1000)) })}</span>
				{/if}
			{:else if col === 'host'}
				{#if row.host}
					<span class="mono">{row.host}</span>
				{:else}
					<span class="dim">–</span>
				{/if}
			{:else if !health}
				<span class="dim">–</span>
			{:else if col === 'cpu'}
				{@const series = sparkSeries(history, 'cpu', 'percent', (sample) => sample.cpuPct)}
				<span class="chartcell">
					<span class="figure mono">{health.cpuPct.toFixed(1)}%</span>
					<span class="strip">
						{#if series}
							<MiniSpark
								{series}
								label={t('web.machines.colCpu')}
								width={4}
								height={1.5}
								ceiling={100}
								tone={health.cpuPct >= 90 ? 'critical' : health.cpuPct >= 75 ? 'warning' : undefined}
							/>
						{/if}
					</span>
				</span>
			{:else if col === 'memory'}
				<ProgressBar
					compact
					transition={false}
					value={health.memUsedMb}
					max={health.memTotalMb}
					color="auto"
					right="{fmtBytes(health.memUsedMb * MB)} / {fmtBytes(health.memTotalMb * MB)}"
				/>
			{:else if col === 'swap'}
				{#if health.swapTotalMb}
					<ProgressBar
						compact
						transition={false}
						value={health.swapUsedMb ?? 0}
						max={health.swapTotalMb}
						color="auto"
						right="{fmtBytes((health.swapUsedMb ?? 0) * MB)} / {fmtBytes(health.swapTotalMb * MB)}"
					/>
				{:else}
					<span class="dim">{t('web.machines.noSwap')}</span>
				{/if}
			{:else if col === 'disk'}
				{#if health.diskTotalBytes > 0}
					<ProgressBar
						compact
						transition={false}
						value={health.diskUsedBytes}
						max={health.diskTotalBytes}
						color="auto"
						right="{fmtBytes(health.diskUsedBytes)} / {fmtBytes(health.diskTotalBytes)}"
					/>
				{:else}
					<span class="dim">–</span>
				{/if}
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

<Modal title={t('web.machines.join.title')} bind:open={joinOpen} wide>
	<ol class="steps">
		<li>{t('web.machines.join.stepInstall')}</li>
		<li>
			{joinSave.before}<code class="inline">/etc/luna/daemon.json</code>{joinSave.after}
			<pre class="code mono">{joinConfig}</pre>
		</li>
		<li>{joinRun.before}<code class="inline">luna daemon service install</code>{joinRun.after}</li>
	</ol>
	<p class="dim">
		{joinToken.before}<code class="inline">luna daemon token</code>{joinToken.after}
	</p>

	{#snippet footer()}
		<Btn onclick={() => (joinOpen = false)}>{t('web.common.close')}</Btn>
		<Btn variant="primary" icon="copy" onclick={() => navigator.clipboard?.writeText(joinConfig)}>
			{t('web.machines.join.copyConfig')}
		</Btn>
	{/snippet}
</Modal>

<ConfirmModal
	bind:open={removeOpen}
	title={t('web.machines.removeTitle', { name: removeTarget?.name ?? '' })}
	lead={t('web.machines.removeLead', { name: removeTarget?.name ?? '' })}
	notes={[t('web.machines.removeNote')]}
	confirmLabel={t('web.common.remove')}
	onconfirm={() => void remove()}
/>

<Modal title={t('web.machines.upgradeTitle', { count: String(upgradeTargets.length) })} bind:open={upgradeOpen}>
	<p>{t('web.machines.upgradeLead')}</p>
	<ul class="targets">
		{#each upgradeTargets as target (target.name)}
			<li>
				<b>{target.name}</b>
				<span class="mono dim">{target.version ?? t('web.machines.unknownBuild')}</span>
				{#if !target.outdated}
					<span class="dim">{t('web.machines.reinstallNote')}</span>
				{/if}
			</li>
		{/each}
	</ul>

	{#snippet footer()}
		<Btn onclick={() => (upgradeOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="primary" icon="download" loading={upgrading} onclick={runUpgrade}>
			{t('web.machines.upgrade')}
		</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	// a figure and its last hour; the figure sits in a fixed slot, right-aligned,
	// so every row's chart starts on the same edge
	.chartcell {
		display: inline-flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.5rem;
		max-width: 100%;

		// widest value is "100.0%"
		.figure {
			min-width: 6ch;
			text-align: right;
			font-variant-numeric: tabular-nums;

			&[data-tone='warning'] {
				color: var(--warning);
			}

			&[data-tone='danger'] {
				color: var(--error);
			}
		}

		.strip {
			display: inline-flex;
			align-items: center;
			width: 4rem;
		}
	}

	// how many run, then the first few by name, wrapping so none is cut off
	.owned {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
	}

	.names {
		display: flex;
		flex-wrap: wrap;
		gap: 0 0.625rem;
		font-size: 0.75rem;
		line-height: 1rem;
	}

	.steps {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin: 0;
		padding: 0 0 0 1.25rem;
	}

	.targets {
		margin: 0.75rem 0 0;
		padding: 0 0 0 1.25rem;
		font-size: 0.875rem;

		li {
			padding: 0.125rem 0;
		}
	}

	.code {
		margin: 0.5rem 0 0;
		padding: 0.75rem 1rem;
		border: 0.1rem solid var(--border-divider);
		border-radius: 0.5rem;
		background: var(--bg-terminal);
		font-size: 0.75rem;
		line-height: 1.6;
		white-space: pre-wrap;
	}

	.warn {
		color: var(--warning);
	}

	.bad {
		margin-left: 0.5rem;
		color: var(--error);
	}
</style>
