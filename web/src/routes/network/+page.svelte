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
	import { Notify } from '$lib/notifications.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { goto } from '$app/navigation';

	let ports: any[] = $state([]);
	let issues: any[] = $state([]);
	let busy = $state(false);
	let loaded = $state(false);
	let loading = $state(false);
	let lastUpdated: number | null = $state(null);

	const columns: Column[] = [
		{ id: 'bound', label: 'Bound', width: 140 },
		{ id: 'port', label: 'Port', sortable: true, width: 110, align: 'right' },
		{ id: 'protocol', label: 'Protocol', width: 110 },
		{ id: 'owner', label: 'Owner', sortable: true },
		{ id: 'kind', label: 'Kind', sortable: true }
	];

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const data = await api('/ports');

			ports = data.ports;
			issues = data.issues;
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

			note.set({
				level: res.issues.length ? 'warning' : 'success',
				message: `Re-ensured ${res.ensured} allocation(s)`,
				detail: res.issues.length ? `${res.issues.length} issue(s) remain.` : '',
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

	/** A plugin port is labelled `plugin:<plugin>/<id>` — show just the allocation. */
	function kindLabel(kind: string): string {
		return kind.startsWith('plugin:') ? kind.slice(7) : kind;
	}

	const filters: TableFilterGroup<any>[] = [
		{
			id: 'bound',
			label: 'Filter bind state',
			options: [
				{ value: 'any', label: 'Any bind state' },
				{ value: 'yes', label: 'Listening', match: (row) => !!row.listening },
				{
					value: 'no',
					label: 'Not bound',
					match: (row) => !row.listening && row.kind !== 'external'
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
		}
	];

	function rowActions(row: any): ContextMenuItem[] {
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
				label: 'Copy address',
				icon: 'copy',
				action: () => navigator.clipboard?.writeText(`10.0.0.10:${row.port}`)
			}
		];
	}

	let selected: Set<string> = $state(new Set());

	/** The row the header's Actions dropdown acts on. */
	const one = $derived(ports.find((row: any) => selected.has(`${row.protocol}:${row.port}:${row.owner}`)));
</script>

<svelte:head><title>Ports | Luna Console</title></svelte:head>

<PageHeader
	title="Ports"
	count={ports.length}
	description="Cluster-wide port map — game ports, query, and plugin ports from the registry in cluster.json"
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="ports" />
		<Dropdown label="Actions" disabled={!one} menu={one ? rowActions(one) : []} />
		<Btn icon="wrench" variant="primary" loading={busy} onclick={fix}>Fix config drift</Btn>
	{/snippet}
</PageHeader>

{#if issues.length}
	<Flash kind="warning">
		<b>{issues.length} issue(s) found by the port audit:</b><br />
		{#each issues as issue}
			· [{issue.kind}] {issue.message}<br />
		{/each}
	</Flash>
{:else if loaded}
	<Flash kind="success">Port audit clean — no duplicates, drift, or velocity mismatches.</Flash>
{/if}

<Panel flush>
	<ResourceTable
		tableId="ports"
		initialSearch={page.url.searchParams.get('q') ?? ''}
		{columns}
		rows={ports}
		getId={(row) => `${row.protocol}:${row.port}:${row.owner}`}
		searchValue={(row) => `${row.port} ${row.protocol} ${row.owner} ${kindLabel(row.kind)}`}
		searchPlaceholder="Find a port by number, owner or kind"
		{filters}
		selectable="single"
		bind:selected
		{rowActions}
		rowLabel={(row) => `${row.owner} · ${row.port}/${row.protocol}`}
		noun="port"
		sortValue={(row, col) => (row as any)[col] ?? ''}
		emptyTitle="No ports allocated"
	>
		{#snippet cell(row, col)}
			{#if col === 'bound'}
				<StatusBadge
					state={row.listening ? 'ok' : row.kind === 'external' ? 'external' : 'stopped'}
					label={row.listening ? 'Listening' : row.kind === 'external' ? 'External' : 'Not bound'}
				/>
			{:else if col === 'port'}
				<b class="mono">{row.port}</b>
			{:else if col === 'protocol'}
				{row.protocol}
			{:else if col === 'owner'}
				<a href="/instances/{row.owner}">{row.owner}</a>
			{:else if col === 'kind'}
				{kindLabel(row.kind)}
			{/if}
		{/snippet}
	</ResourceTable>
</Panel>
