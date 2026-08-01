<script lang="ts">
	import { onMount } from 'svelte';
	import { api, post } from '$lib/api';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import type { Column } from '$lib/components/table';

	let ports: any[] = $state([]);
	let issues: any[] = $state([]);
	let busy = $state(false);
	let loaded = $state(false);

	const columns: Column[] = [
		{ id: 'bound', label: 'Bound', width: 140 },
		{ id: 'port', label: 'Port', sortable: true, width: 110, align: 'right' },
		{ id: 'protocol', label: 'Protocol', width: 110 },
		{ id: 'owner', label: 'Owner', sortable: true },
		{ id: 'kind', label: 'Kind', sortable: true }
	];

	async function refresh(): Promise<void> {
		const data = await api('/ports');

		ports = data.ports;
		issues = data.issues;
		loaded = true;
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
</script>

<svelte:head><title>Ports | MRDS Console</title></svelte:head>

<PageHeader
	title="Ports"
	count={ports.length}
	description="Cluster-wide port map — game ports, query, and plugin ports from the registry in cluster.json"
>
	{#snippet actions()}
		<Btn variant="icon" icon="sync" title="Refresh" onclick={refresh} />
		<Btn loading={busy} onclick={fix}>Fix config drift</Btn>
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
	<DataTable
		{columns}
		rows={ports}
		getId={(row) => `${row.protocol}:${row.port}:${row.owner}`}
		sortValue={(row, col) => (row as any)[col] ?? ''}
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
	</DataTable>
</Panel>
