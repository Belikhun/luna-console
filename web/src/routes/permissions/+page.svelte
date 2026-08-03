<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { api, post, del } from '$lib/api';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import type { Column } from '$lib/components/table';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * LuckPerms group management. This screen is the roster — weight-ordered,
	 * with create and delete; opening a group goes to its edit wizard
	 * (/permissions/<name>), where meta, parents and nodes are edited together
	 * and saved in one pass. Everything goes through the LuckPerms API on the
	 * proxy and is pushed to all backends over its messaging service.
	 */

	interface GroupSummary {
		name: string;
		displayName: string;
		weight: number;
		prefix: string;
		suffix: string;
		parents: string[];
		nodeCount: number;
		memberCount: number;
	}

	let groups: GroupSummary[] = $state([]);
	let available = $state(true);
	let problem = $state('');
	let loading = $state(true);
	let lastUpdated: number | null = $state(null);

	let selected: Set<string> = $state(new Set());

	// create dialog
	let createOpen = $state(false);
	let createName = $state('');
	let createWeight = $state('');
	let createDisplay = $state('');

	// delete dialog
	let deleteOpen = $state(false);
	let deleteTarget = $state('');

	async function refresh(): Promise<void> {
		try {
			const data = await api('/permissions/groups');

			available = data.available !== false;
			problem = available ? '' : (data.error ?? 'LuckPerms is unreachable');
			groups = data.groups ?? [];
			lastUpdated = Date.now();
		} catch (err) {
			available = false;
			problem = (err as Error).message;
		}

		loading = false;
	}

	onMount(() => {
		void refresh();
	});

	const columns: Column[] = [
		{ id: 'name', label: 'Group', sortable: true, minWidth: 160 },
		{ id: 'weight', label: 'Weight', sortable: true, width: 100, align: 'right' },
		{ id: 'prefix', label: 'Prefix' },
		{ id: 'parents', label: 'Inherits from' },
		{ id: 'nodes', label: 'Nodes', sortable: true, width: 90, align: 'right' },
		{ id: 'members', label: 'Members', sortable: true, width: 110, align: 'right' }
	];

	function sortValue(group: GroupSummary, col: string): string | number | null {
		switch (col) {
			case 'name':
				return group.name;

			case 'weight':
				return group.weight;

			case 'nodes':
				return group.nodeCount;

			case 'members':
				return group.memberCount;

			default:
				return null;
		}
	}

	function rowActions(group: GroupSummary): ContextMenuItem[] {
		return [
			{
				label: 'View group',
				icon: 'key',
				action: () => goto(`/permissions/${encodeURIComponent(group.name)}`)
			},
			{
				label: 'Edit group',
				icon: 'pen',
				action: () => goto(`/permissions/${encodeURIComponent(group.name)}/edit`)
			},
			{
				label: 'Copy name',
				icon: 'copy',
				action: () => void copy(group.name)
			},
			{ separator: true },
			{
				label: 'Delete group',
				icon: 'trash',
				color: 'danger',
				disabled: group.name === 'default',
				hint: group.name === 'default' ? 'LuckPerms requires it' : undefined,
				action: () => {
					deleteTarget = group.name;
					deleteOpen = true;
				}
			}
		];
	}

	async function copy(text: string): Promise<void> {
		const { copyText } = await import('$lib/clipboard');

		await copyText(text);
	}

	async function act(run: () => Promise<any>, pending: string, done: string): Promise<void> {
		const note = Notify.loading(pending);

		try {
			const result = await run();

			if (result?.ok === false) {
				throw new Error(result.error ?? 'LuckPerms refused the change');
			}

			note.set({ level: 'success', message: done, closeable: true });
		} catch (err) {
			note.set({ level: 'error', message: pending, detail: (err as Error).message, closeable: true });
		}
	}

	async function doCreate(): Promise<void> {
		const name = createName.trim().toLowerCase();

		createOpen = false;

		if (!name) {
			return;
		}

		await act(
			() =>
				post('/permissions/groups', {
					name,
					...(createWeight ? { weight: Number(createWeight) } : {}),
					...(createDisplay ? { displayName: createDisplay } : {})
				}),
			`Creating group ${name}…`,
			`Group ${name} created`
		);

		createName = '';
		createWeight = '';
		createDisplay = '';

		// straight into the wizard: a fresh group has no nodes yet
		await goto(`/permissions/${encodeURIComponent(name)}/edit`);
	}

	async function doDelete(): Promise<void> {
		const name = deleteTarget;

		deleteOpen = false;

		await act(
			() => del(`/permissions/groups/${encodeURIComponent(name)}`),
			`Deleting group ${name}…`,
			`Group ${name} deleted`
		);

		selected = new Set();
		await refresh();
	}
</script>

<svelte:head><title>Permission groups | Luna Console</title></svelte:head>

<PageHeader
	title="Permission groups"
	count={groups.length}
	info
	description="LuckPerms groups across the whole network — one shared database, changes pushed to every server"
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="permissions" />
		<Btn variant="primary" icon="plus" onclick={() => (createOpen = true)}>New group</Btn>
	{/snippet}
</PageHeader>

{#if !available}
	<Flash kind="warning">
		<b>LuckPerms is not answering:</b> {problem}. The proxy may be stopped, LuckPerms may be
		missing, or LunaCore is running a build without the permissions API.
	</Flash>
{/if}

<div class="body">
	<Panel flush>
		<ResourceTable
			tableId="permission-groups"
			initialSearch={page.url.searchParams.get('q') ?? ''}
			{columns}
			rows={groups}
			getId={(group) => group.name}
			searchValue={(group) => `${group.name} ${group.displayName} ${group.prefix}`}
			searchPlaceholder="Find group"
			selectable="single"
			bind:selected
			{rowActions}
			rowLabel={(group) => group.name}
			onRowClick={(group) => goto(`/permissions/${encodeURIComponent(group.name)}`)}
			noun="group"
			{sortValue}
			pageSize={25}
			emptyTitle="No groups"
			emptyText="LuckPerms always has at least the default group — if nothing shows, the proxy is not answering."
		>
			{#snippet cell(group, col)}
				{#if col === 'name'}
					<a href="/permissions/{encodeURIComponent(group.name)}"><b>{group.name}</b></a>
					{#if group.displayName && group.displayName !== group.name}
						<span class="dim">({group.displayName})</span>
					{/if}
				{:else if col === 'weight'}
					{group.weight}
				{:else if col === 'prefix'}
					{#if group.prefix}
						<span class="mono">{group.prefix}</span>
					{:else}
						<span class="dim">–</span>
					{/if}
				{:else if col === 'parents'}
					{#if group.parents.length > 0}
						{group.parents.join(', ')}
					{:else}
						<span class="dim">–</span>
					{/if}
				{:else if col === 'nodes'}
					{group.nodeCount}
				{:else if col === 'members'}
					{group.memberCount}
				{/if}
			{/snippet}
		</ResourceTable>
	</Panel>
</div>

<Modal title="New permission group" bind:open={createOpen}>
	<label class="field">
		<span class="lbl">Name</span>
		<span class="hint">Lowercase; this is the LuckPerms group id</span>
		<input class="input" bind:value={createName} placeholder="e.g. moderator" />
	</label>
	<label class="field">
		<span class="lbl">Weight</span>
		<span class="hint">Higher weight wins when a player has several groups</span>
		<input class="input" type="number" bind:value={createWeight} placeholder="0" />
	</label>
	<label class="field">
		<span class="lbl">Display name</span>
		<input class="input" bind:value={createDisplay} placeholder="optional" />
	</label>
	{#snippet footer()}
		<Btn onclick={() => (createOpen = false)}>Cancel</Btn>
		<Btn variant="primary" disabled={!createName.trim()} onclick={doCreate}>Create</Btn>
	{/snippet}
</Modal>

<Modal title="Delete group {deleteTarget}" bind:open={deleteOpen}>
	<p>
		The group is removed from LuckPerms on every server. Players holding it lose the
		membership; their other groups stay.
	</p>
	{#snippet footer()}
		<Btn onclick={() => (deleteOpen = false)}>Cancel</Btn>
		<Btn variant="danger" onclick={doDelete}>Delete</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.body {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		margin-top: 1rem;
	}
</style>
