<script lang="ts">
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

	let ports: any[] = $state([]);
	let issues: any[] = $state([]);
	let pools: any[] = $state([]);
	let catalog: any[] = $state([]);
	let storedIds: string[] = $state([]);
	let consumers: Record<string, any[]> = $state({});
	let machines: any[] = $state([]);
	/** LAN addresses per machine, from the daemons view — the primary has no host in cluster.json */
	let lanAddresses: Record<string, string> = $state({});
	let busy = $state(false);
	let loaded = $state(false);
	let loading = $state(false);
	let lastUpdated: number | null = $state(null);

	const columns: Column[] = [
		{ id: 'bound', label: 'Bound', width: 140 },
		{ id: 'port', label: 'Port', sortable: true, width: 100, align: 'right' },
		{ id: 'protocol', label: 'Protocol', width: 100 },
		{ id: 'machine', label: 'Machine', sortable: true, width: 150 },
		{ id: 'owner', label: 'Owner', sortable: true },
		{ id: 'kind', label: 'Kind', sortable: true },
		{ id: 'pool', label: 'Pool', sortable: true, width: 120 },
		{ id: 'address', label: 'Address', width: 190 }
	];

	/** A machine key of `""` is the primary — its name lives in the daemons view. */
	function machineName(machine: string | null): string {
		if (machine === null) {
			return 'external';
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
			// the fleet view — matching them up is what gives every machine a real
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
			Notify.error('Could not load the port map', { detail: (err as Error).message });
		} finally {
			loading = false;
		}
	}

	onMount(refresh);

	async function fix(): Promise<void> {
		busy = true;

		const note = Notify.loading('Rewriting plugin port configuration…');

		try {
			const res = await post('/ports');
			const remaining = (res.issues ?? []).filter((issue: any) => issue.kind !== 'unchecked');

			note.set({
				level: remaining.length ? 'warning' : 'success',
				message: `Re-ensured ${res.ensured} allocation(s)`,
				detail: remaining.length ? `${remaining.length} issue(s) remain.` : '',
				closeable: true
			});

			issues = res.issues;

			await refresh();
		} catch (err) {
			note.set({
				level: 'error',
				message: 'Could not fix port configuration',
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

	/** A plugin port is labelled `plugin:<plugin>/<id>` — show just the allocation. */
	function kindLabel(kind: string): string {
		return kind.startsWith('plugin:') ? kind.slice(7) : kind;
	}

	const filters: TableFilterGroup<any>[] = $derived([
		{
			id: 'bound',
			label: 'Filter bind state',
			options: [
				{ value: 'any', label: 'Any bind state' },
				{ value: 'yes', label: 'Listening', match: (row) => row.listening === true },
				{ value: 'no', label: 'Not bound', match: (row) => row.listening === false },
				{
					value: 'unknown',
					label: 'Unknown',
					match: (row) => row.listening === null && row.kind !== 'external'
				}
			]
		},
		{
			id: 'protocol',
			label: 'Filter protocol',
			options: [
				{ value: 'any', label: 'Any protocol' },
				{ value: 'tcp', label: 'tcp', match: (row) => row.protocol === 'tcp' },
				{ value: 'udp', label: 'udp', match: (row) => row.protocol === 'udp' }
			]
		},
		{
			id: 'machine',
			label: 'Filter machine',
			options: [
				{ value: 'any', label: 'Any machine' },
				...machines.map((entry: any) => ({
					value: entry.machine || 'primary',
					label: entry.label,
					match: (row: any) => row.machine === entry.machine
				})),
				{ value: 'external', label: 'External', match: (row: any) => row.machine === null }
			]
		}
	]);

	function rowActions(row: any): ContextMenuItem[] {
		const lan = lanAddresses[row.machine] ?? null;

		return [
			{
				label: `Open ${row.owner}`,
				icon: 'server',
				action: () => goto(`/instances/${row.owner}`)
			},
			{
				label: 'Open its networking tab',
				icon: 'sitemap',
				action: () => goto(`/instances/${row.owner}?tab=network`)
			},
			{ separator: true },
			{
				label: 'Copy port',
				icon: 'copy',
				action: () => navigator.clipboard?.writeText(String(row.port))
			},
			{
				label: `Copy address (${row.address})`,
				icon: 'copy',
				action: () => navigator.clipboard?.writeText(row.address)
			},
			{
				label: lan ? `Copy LAN address (${lan}:${row.port})` : 'Copy LAN address',
				icon: 'globe',
				disabled: !lan,
				hint: lan ? undefined : 'no LAN address known for this machine',
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

	/** Segments of a pool's usage bar — allocated, held back, in flight, free. */
	function poolSegments(view: any): Array<{ key: string; label: string; count: number; color: string }> {
		return [
			{ key: 'used', label: 'allocated', count: view.used.length, color: 'var(--link)' },
			{ key: 'reserved', label: 'held back', count: view.reserved.length, color: 'var(--warning)' },
			{ key: 'pending', label: 'in flight', count: view.pending.length, color: 'var(--primary)' },
			{ key: 'free', label: 'free', count: view.free, color: 'var(--bg-track)' }
		];
	}
</script>

<svelte:head><title>Ports | Luna Console</title></svelte:head>

<PageHeader
	title="Ports"
	count={ports.length}
	description="The pool catalog every provision draws from, and every number the registry has handed out — game ports, plugin ports and the external servers the proxy routes to"
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="ports" />
		<Dropdown label="Actions" disabled={!one} menu={one ? rowActions(one) : []} />
		<Btn icon="wrench" loading={busy} onclick={fix}>Fix config drift</Btn>
		<Btn icon="pen" variant="primary" href="/network/pools">Edit pools</Btn>
	{/snippet}
</PageHeader>

{#if problems.length}
	<Flash kind="warning">
		<b>{problems.length} issue(s) found by the port audit:</b><br />
		{#each problems as issue}
			· [{issue.kind}] {issue.message}<br />
		{/each}
		{#each unchecked as issue}
			· {issue.message}<br />
		{/each}
	</Flash>
{:else if unchecked.length}
	<Flash kind="info">
		No port issues found on the machines luna could reach.<br />
		{#each unchecked as issue}
			· {issue.message}<br />
		{/each}
	</Flash>
{:else if loaded}
	<Flash kind="success">
		Port audit clean — no duplicates on any machine, no config drift, no velocity mismatches.
	</Flash>
{/if}

<Panel
	title="Port pools"
	count={catalog.length}
	description="A pool is a named range ports are acquired from: provisioning takes each backend's game port from “game”, and a plugin's port declaration names the pool its per-instance port comes from. Every machine serves every pool — only the numbers may differ per machine, because a port is only taken on the host that binds it."
>
	{#snippet actions()}
		<Btn variant="tool" icon="pen" title="Edit pools" href="/network/pools" />
	{/snippet}

	<div class="pools">
		{#each catalog as pool (pool.id)}
			<div class="pool">
				<div class="phd">
					<b>{pool.id}</b>
					{#if pool.label}<span class="plabel">{pool.label}</span>{/if}
					<span class="proto">{pool.protocol}</span>
					{#if !storedIds.includes(pool.id)}
						<span class="tag" title="the built-in default — customize it under Edit pools">
							default
						</span>
					{/if}
				</div>

				<div class="pconsumers" title="what acquires ports from this pool">
					{consumersLine(consumers, pool.id)}
				</div>

				<div class="pmachines">
					{#each usageOf(pool.id) as view (view.machine)}
						<div class="prow">
							<a class="mname" href="/machines/{machineName(view.machine)}">
								{machineName(view.machine)}
							</a>
							<span class="prange mono">{view.pool.range[0]}–{view.pool.range[1]}</span>
							{#if view.overridden}
								<span class="tag" title="this machine overrides the pool's range">override</span>
							{/if}
							<div class="pbar">
								<DistributionBar segments={poolSegments(view)} legend={false} />
							</div>
							<span class="pfree">
								{view.used.length}/{view.capacity} used ·
								{#if view.next === null}
									<b class="exhausted">exhausted</b>
								{:else}
									next <b class="mono">{view.next}</b>
								{/if}
							</span>
						</div>
					{/each}
				</div>
			</div>
		{/each}
	</div>

	{#if loaded && !catalog.length}
		<p class="none">No pools defined.</p>
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
		searchPlaceholder="Find a port by number, owner, machine or pool"
		{filters}
		selectable="single"
		bind:selected
		{rowActions}
		rowLabel={(row) => `${row.owner} · ${row.port}/${row.protocol}`}
		noun="port"
		sortValue={(row, col) => (col === 'machine' ? machineName(row.machine) : ((row as any)[col] ?? ''))}
		emptyTitle="No ports allocated"
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
						? 'Listening'
						: row.kind === 'external'
							? 'External'
							: row.listening === null
								? 'Unknown'
								: 'Not bound'}
				/>
			{:else if col === 'port'}
				<b class="mono">{row.port}</b>
			{:else if col === 'protocol'}
				{row.protocol}
			{:else if col === 'machine'}
				{#if row.machine === null}
					<span class="dim">external</span>
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
					<span class="dim" title="outside every pool on its machine">—</span>
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
