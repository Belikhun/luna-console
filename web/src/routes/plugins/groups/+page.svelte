<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { api } from '$lib/api';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import type { Column } from '$lib/components/table';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import { Notify } from '$lib/notifications.svelte';

	interface GroupInfo {
		name: string;
		description: string;
		builtin: boolean;
		plugins: string[];
		usedBy: string[];
	}

	let groups: GroupInfo[] = $state([]);
	let loading = $state(true);
	let lastUpdated: number | null = $state(null);

	async function refresh(): Promise<void> {
		loading = true;

		try {
			groups = (await api('/plugins/groups')).groups;
			lastUpdated = Date.now();
		} catch (err) {
			Notify.error('Could not load plugin groups', { detail: (err as Error).message });
		}

		loading = false;
	}

	onMount(() => {
		void refresh();
	});

	const columns: Column[] = [
		{ id: 'name', label: 'Group', sortable: true, width: 200 },
		{ id: 'count', label: 'Plugins', width: 90, align: 'right' },
		{ id: 'plugins', label: 'Members' },
		{ id: 'usedBy', label: 'Used by', width: 260 },
		{ id: 'description', label: 'Description' }
	];
</script>

<svelte:head><title>Plugin groups | MRDS Console</title></svelte:head>

<PageHeader
	title="Plugin groups"
	count={groups.length}
	description="Sets of plugins applied to instances as a unit. Every instance gets the default group; editing a group redeploys it everywhere it is used."
	info
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="plugin-groups" />
		<Btn variant="primary" icon="layerGroup" onclick={() => goto('/plugins/groups/new')}>
			Create group
		</Btn>
	{/snippet}
</PageHeader>

<Panel flush>
	<DataTable
		{columns}
		rows={groups}
		getId={(group) => group.name}
		onRowClick={(group) => goto(`/plugins/groups/${group.name}`)}
		emptyTitle="No groups yet"
		emptyText="Create one to apply a set of plugins to instances as a unit."
	>
		{#snippet cell(group, col)}
			{#if col === 'name'}
				<a href="/plugins/groups/{group.name}" onclick={(event) => event.stopPropagation()}>
					<b>{group.name}</b>
				</a>
				{#if group.builtin}<StatusBadge state="ok" label="builtin" />{/if}
			{:else if col === 'count'}
				{group.plugins.length}
			{:else if col === 'plugins'}
				<span class="dim">{group.plugins.join(', ')}</span>
			{:else if col === 'usedBy'}
				{group.usedBy.join(', ') || '–'}
			{:else if col === 'description'}
				<span class="dim">{group.description || '–'}</span>
			{/if}
		{/snippet}
	</DataTable>
</Panel>
