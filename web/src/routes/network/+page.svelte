<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { api, post } from '$lib/api';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import DistributionBar from '$lib/components/DistributionBar.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { consumersLine } from '$lib/pools';
	import { goto } from '$app/navigation';
	import { instanceTabPath } from '$lib/components/instancetabs';

	let ports: any[] = $state([]);
	let issues: any[] = $state([]);
	let pools: any[] = $state([]);
	let catalog: any[] = $state([]);
	let storedIds: string[] = $state([]);
	let consumers: Record<string, any[]> = $state({});
	let machines: any[] = $state([]);
	/** LAN addresses per machine, from the daemons view; the primary has no host in cluster.json */
	let lanAddresses: Record<string, string> = $state({});
	let busy = $state(false);
	let loaded = $state(false);
	let loading = $state(false);
	let lastUpdated: number | null = $state(null);

	const columns: Column[] = $derived([
		{ id: 'bound', label: t('web.ports.colBound'), width: 140 },
		{ id: 'port', label: t('web.instances.colPort'), sortable: true, width: 100, align: 'right' },
		{ id: 'protocol', label: t('web.ports.colProtocol'), width: 100 },
		{ id: 'machine', label: t('web.instances.colMachine'), sortable: true, width: 150 },
		{ id: 'owner', label: t('web.ports.colOwner'), sortable: true },
		{ id: 'kind', label: t('web.cleanup.colKind'), sortable: true },
		{ id: 'pool', label: t('web.ports.colPool'), sortable: true, width: 120 },
		{ id: 'address', label: t('web.proxy.colAddress'), width: 190 }
	]);

	/** A machine key of `""` is the primary; its name lives in the daemons view. */
	function machineName(machine: string | null): string {
		if (machine === null) {
			return t('web.ports.external');
		}

		return machines.find((entry: any) => entry.machine === machine)?.label ?? machine;
	}

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const [data, fleet] = await Promise.all([api('/ports'), api('/daemons')]);

			ports = data.ports;
			issues = data.issues;
			pools = data.pools;
			catalog = data.catalog;
			storedIds = data.storedIds;
			consumers = data.consumers;

			// the primary's own key is "" in the registry but it is a named daemon in
			// the fleet view; matching them up is what gives every machine a real
			// name and a LAN address to copy
			const fleetRows = fleet.daemons ?? [];
			const primary = fleetRows.find((row: any) => row.mode === 'primary');
			const next: Record<string, string> = {};

			machines = data.machines.map((entry: any) => {
				const row =
					entry.machine === ''
						? primary
						: fleetRows.find((item: any) => item.name === entry.machine);

				next[entry.machine] = row?.addresses?.[0] ?? entry.host;

				return { ...entry, label: row?.name ?? entry.label };
			});

			lanAddresses = next;
			loaded = true;
			lastUpdated = Date.now();
		} catch (err) {
			Notify.error(t('web.ports.loadFailed'), { detail: (err as Error).message });
		} finally {
			loading = false;
		}
	}

	onMount(refresh);

	async function fix(): Promise<void> {
		busy = true;

		const note = Notify.loading(t('web.ports.rewriting'));

		try {
			const res = await post('/ports');
			const remaining = (res.issues ?? []).filter((issue: any) => issue.kind !== 'unchecked');

			note.set({
				level: remaining.length ? 'warning' : 'success',
				message: t('web.ports.reEnsured', { count: res.ensured }),
				detail: remaining.length ? t('web.ports.issuesRemain', { count: remaining.length }) : '',
				closeable: true
			});

			issues = res.issues;

			await refresh();
		} catch (err) {
			note.set({
				level: 'error',
				message: t('web.ports.fixFailed'),
				detail: (err as Error).message,
				closeable: true
			});
		}

		busy = false;
	}

	// an unreachable machine is a gap in coverage, not a finding: it is said out
	// loud so "clean" never means "we only looked at half the cluster", but it does
	// not colour the whole audit as a problem either
	const problems = $derived(issues.filter((issue: any) => issue.kind !== 'unchecked'));
	const unchecked = $derived(issues.filter((issue: any) => issue.kind === 'unchecked'));

	/** A plugin port is labelled `plugin:<plugin>/<id>`; show just the allocation. */
	function kindLabel(kind: string): string {
		return kind.startsWith('plugin:') ? kind.slice(7) : kind;
	}

	const filters: TableFilterGroup<any>[] = $derived([
		{
			id: 'bound',
			label: t('web.ports.filterBind'),
			options: [
				{ value: 'any', label: t('web.ports.anyBind') },
				{ value: 'yes', label: t('web.ports.listening'), match: (row) => row.listening === true },
				{ value: 'no', label: t('web.ports.notBound'), match: (row) => row.listening === false },
				{
					value: 'unknown',
					label: t('web.ports.unknown'),
					match: (row) => row.listening === null && row.kind !== 'external'
				}
			]
		},
		{
			id: 'protocol',
			label: t('web.ports.filterProtocol'),
			options: [
				{ value: 'any', label: t('web.ports.anyProtocol') },
				{ value: 'tcp', label: t('web.ports.tcp'), match: (row) => row.protocol === 'tcp' },
				{ value: 'udp', label: t('web.ports.udp'), match: (row) => row.protocol === 'udp' }
			]
		},
		{
			id: 'machine',
			label: t('web.ports.filterMachine'),
			options: [
				{ value: 'any', label: t('web.ports.anyMachine') },
				...machines.map((entry: any) => ({
					value: entry.machine || 'primary',
					label: entry.label,
					match: (row: any) => row.machine === entry.machine
				})),
				{ value: 'external', label: t('web.instances.external'), match: (row: any) => row.machine === null }
			]
		}
	]);

	function rowActions(row: any): ContextMenuItem[] {
		const lan = lanAddresses[row.machine] ?? null;

		return [
			{
				label: t('web.cleanup.openInstance', { name: row.owner }),
				icon: 'server',
				action: () => goto(`/instances/${row.owner}`)
			},
			{
				label: t('web.ports.openNetworking'),
				icon: 'sitemap',
				action: () => goto(instanceTabPath(row.owner, 'network'))
			},
			{ separator: true },
			{
				label: t('web.ports.copyPort'),
				icon: 'copy',
				action: () => navigator.clipboard?.writeText(String(row.port))
			},
			{
				label: t('web.ports.copyAddressWith', { address: row.address }),
				icon: 'copy',
				action: () => navigator.clipboard?.writeText(row.address)
			},
			{
				label: lan ? t('web.ports.copyLanWith', { address: `${lan}:${row.port}` }) : t('web.ports.copyLan'),
				icon: 'globe',
				disabled: !lan,
				hint: lan ? undefined : t('web.ports.noLanKnown'),
				action: () => navigator.clipboard?.writeText(`${lan}:${row.port}`)
			}
		];
	}

	let selected: Set<string> = $state(new Set());

	/** The row the header's Actions dropdown acts on. */
	const one = $derived(
		ports.find((row: any) => selected.has(`${row.protocol}:${row.port}:${row.owner}`))
	);

	/** One pool's usage rows, one per machine, in the machines' own order. */
	function usageOf(poolId: string): any[] {
		return machines
			.map((entry: any) =>
				pools.find((view: any) => view.pool.id === poolId && view.machine === entry.machine)
			)
			.filter(Boolean);
	}

	/** Segments of a pool's usage bar; allocated, held back, in flight, free. */
	function poolSegments(view: any): Array<{ key: string; label: string; count: number; color: string }> {
		return [
			{ key: 'used', label: t('web.ports.segAllocated'), count: view.used.length, color: 'var(--link)' },
			{ key: 'reserved', label: t('web.ports.segHeldBack'), count: view.reserved.length, color: 'var(--warning)' },
			{ key: 'pending', label: t('web.ports.segInFlight'), count: view.pending.length, color: 'var(--primary)' },
			{ key: 'free', label: t('web.ports.segFree'), count: view.free, color: 'var(--bg-track)' }
		];
	}
</script>

<svelte:head><title>{t('web.nav.ports')} | Luna Console</title></svelte:head>

<PageHeader
	title={t('web.nav.ports')}
	count={ports.length}
	description={t('web.ports.pageDescription')}
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="ports" />
		<Dropdown label={t('web.common.actions')} disabled={!one} menu={one ? rowActions(one) : []} />
		<Btn icon="wrench" loading={busy} onclick={fix}>{t('web.ports.fixDrift')}</Btn>
		<Btn icon="pen" variant="primary" href="/network/pools">{t('web.ports.editPools')}</Btn>
	{/snippet}
</PageHeader>

{#if problems.length}
	<Flash kind="warning">
		<b>{t('web.ports.auditIssues', { count: problems.length })}</b><br />
		{#each problems as issue}
			· [{issue.kind}] {issue.message}<br />
		{/each}
		{#each unchecked as issue}
			· {issue.message}<br />
		{/each}
	</Flash>
{:else if unchecked.length}
	<Flash kind="info">
		{t('web.ports.noIssuesReachable')}<br />
		{#each unchecked as issue}
			· {issue.message}<br />
		{/each}
	</Flash>
{:else if loaded}
	<Flash kind="success">
		{t('web.ports.auditClean')}
	</Flash>
{/if}

<Panel
	title={t('web.ports.poolsTitle')}
	count={catalog.length}
	description={t('web.ports.poolsDescription')}
>
	{#snippet actions()}
		<Btn variant="tool" icon="pen" title={t('web.ports.editPools')} href="/network/pools" />
	{/snippet}

	<div class="pools">
		{#each catalog as pool (pool.id)}
			<div class="pool">
				<div class="phd">
					<b>{pool.id}</b>
					{#if pool.label}<span class="plabel">{pool.label}</span>{/if}
					<span class="proto">{pool.protocol}</span>
					{#if !storedIds.includes(pool.id)}
						<span class="tag" title={t('web.ports.defaultPoolHint')}>
							{t('web.ports.defaultTag')}
						</span>
					{/if}
				</div>

				<div class="pconsumers" title={t('web.ports.consumersTitle')}>
					{consumersLine(consumers, pool.id)}
				</div>

				<div class="pmachines">
					{#each usageOf(pool.id) as view (view.machine)}
						<div class="prow">
							<a class="mname" href="/machines/{machineName(view.machine)}">
								{machineName(view.machine)}
							</a>
							<span class="prange mono">{view.pool.range[0]}-{view.pool.range[1]}</span>
							{#if view.overridden}
								<span class="tag" title={t('web.ports.overrideHint')}>{t('web.ports.overrideTag')}</span>
							{/if}
							<div class="pbar">
								<DistributionBar segments={poolSegments(view)} legend={false} />
							</div>
							<span class="pfree">
								{t('web.ports.usedOf', { used: view.used.length, capacity: view.capacity })} ·
								{#if view.next === null}
									<b class="exhausted">{t('web.ports.exhausted')}</b>
								{:else}
									{t('web.ports.next')} <b class="mono">{view.next}</b>
								{/if}
							</span>
						</div>
					{/each}
				</div>
			</div>
		{/each}
	</div>

	{#if loaded && !catalog.length}
		<p class="none">{t('web.ports.noPools')}</p>
	{/if}
</Panel>

<div class="gap"></div>

<Panel flush>
	<ResourceTable
		tableId="ports"
		initialSearch={page.url.searchParams.get('q') ?? ''}
		{columns}
		rows={ports}
		getId={(row) => `${row.protocol}:${row.port}:${row.owner}`}
		searchValue={(row) =>
			`${row.port} ${row.protocol} ${row.owner} ${kindLabel(row.kind)} ${row.pool ?? ''} ${machineName(row.machine)} ${row.address}`}
		searchPlaceholder={t('web.ports.searchPlaceholder')}
		{filters}
		selectable="single"
		bind:selected
		{rowActions}
		rowLabel={(row) => `${row.owner} · ${row.port}/${row.protocol}`}
		noun={t('web.ports.noun')}
		sortValue={(row, col) => (col === 'machine' ? machineName(row.machine) : ((row as any)[col] ?? ''))}
		emptyTitle={t('web.ports.emptyTitle')}
	>
		{#snippet cell(row, col)}
			{#if col === 'bound'}
				<StatusBadge
					state={row.listening === true
						? 'ok'
						: row.kind === 'external'
							? 'external'
							: row.listening === null
								? 'unknown'
								: 'stopped'}
					label={row.listening === true
						? t('web.ports.listening')
						: row.kind === 'external'
							? t('web.instances.external')
							: row.listening === null
								? t('web.ports.unknown')
								: t('web.ports.notBound')}
				/>
			{:else if col === 'port'}
				<b class="mono">{row.port}</b>
			{:else if col === 'protocol'}
				{row.protocol}
			{:else if col === 'machine'}
				{#if row.machine === null}
					<span class="dim">{t('web.ports.external')}</span>
				{:else}
					{machineName(row.machine)}
				{/if}
			{:else if col === 'owner'}
				<a href="/instances/{row.owner}">{row.owner}</a>
			{:else if col === 'kind'}
				{kindLabel(row.kind)}
			{:else if col === 'pool'}
				{#if row.pool}
					{row.pool}
				{:else}
					<span class="dim" title={t('web.ports.outsidePools')}>—</span>
				{/if}
			{:else if col === 'address'}
				<span class="mono">{row.address}</span>
			{/if}
		{/snippet}
	</ResourceTable>
</Panel>

<style lang="scss">
	// panels carry no outer margin of their own; the page provides the rhythm,
	// exactly as the machine detail screen does
	.gap {
		height: 1rem;
	}

	.pools {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(24rem, 1fr));
		gap: 0.75rem;

		@include below($bp-medium) {
			grid-template-columns: 1fr;
		}
	}

	.pool {
		background: var(--bg-panel-raised);
		border: 0.1rem solid var(--border-divider);
		border-radius: var(--radius-input);
		padding: 0.625rem 0.75rem;
	}

	.phd {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;

		b {
			color: var(--text-heading);
		}

		.plabel {
			color: var(--text-secondary);
			font-size: 0.75rem;
			@include ellipsis;
		}

		.proto {
			margin-left: auto;
			color: var(--text-secondary);
			font-size: 0.75rem;
		}
	}

	.pconsumers {
		color: var(--text-secondary);
		font-size: 0.75rem;
		margin: 0.125rem 0 0.5rem;
		@include ellipsis;
	}

	.tag {
		border: 0.1rem solid var(--border-divider);
		border-radius: var(--radius-input);
		padding: 0 0.25rem;
		color: var(--text-secondary);
		font-size: 0.625rem;
		text-transform: uppercase;
		white-space: nowrap;
	}

	.prow {
		display: flex;
		align-items: center;
		gap: 0.5rem;

		& + .prow {
			margin-top: 0.375rem;
		}
	}

	.mname {
		width: 8.5rem;
		font-size: 0.875rem;
		@include ellipsis;
	}

	.prange {
		color: var(--text-secondary);
		font-size: 0.75rem;
		white-space: nowrap;
	}

	// the bar is the row's flexible middle; keep it from collapsing entirely
	.pbar {
		flex: 1;
		min-width: 3rem;
	}

	.pfree {
		color: var(--text-secondary);
		font-size: 0.75rem;
		white-space: nowrap;

		.exhausted {
			color: var(--warning);
		}
	}

	.none {
		color: var(--text-secondary);
		font-size: 0.875rem;
	}

	.dim {
		color: var(--text-disabled);
	}
</style>
