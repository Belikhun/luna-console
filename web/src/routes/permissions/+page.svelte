<script lang="ts">
	import { t } from '$lib/i18n.svelte';
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
	 * LuckPerms group management. This screen is the roster; weight-ordered,
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

	const columns: Column[] = $derived([
		{ id: 'name', label: t('web.perms.group2'), sortable: true, minWidth: 160 },
		{ id: 'weight', label: t('web.perms.weight'), sortable: true, width: 100, align: 'right' },
		{ id: 'prefix', label: t('web.perms.prefix') },
		{ id: 'parents', label: t('web.perms.inheritsFrom') },
		{ id: 'nodes', label: t('web.perms.nodes'), sortable: true, width: 90, align: 'right' },
		{ id: 'members', label: t('web.perms.members'), sortable: true, width: 110, align: 'right' }
	]);

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
				label: t('web.perms.viewGroup'),
				icon: 'key',
				action: () => goto(`/permissions/${encodeURIComponent(group.name)}`)
			},
			{
				label: t('web.perms.editGroup'),
				icon: 'pen',
				action: () => goto(`/permissions/${encodeURIComponent(group.name)}/edit`)
			},
			{
				label: t('web.perms.copyName'),
				icon: 'copy',
				action: () => void copy(group.name)
			},
			{ separator: true },
			{
				label: t('web.perms.deleteGroup'),
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
			t('web.perms.creatingGroup', { name }),
			t('web.perms.groupCreated', { name })
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
			t('web.perms.deletingGroup', { name }),
			t('web.perms.groupDeleted', { name })
		);

		selected = new Set();
		await refresh();
	}
</script>

<svelte:head><title>{t('web.perms.permissionGroupsLunaConsole')}</title></svelte:head>

<PageHeader
	title={t('web.perms.permissionGroups')}
	count={groups.length}
	info
	description={t('web.perms.luckpermsGroupsAcrossTheWhole')}
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="permissions" />
		<Btn variant="primary" icon="plus" onclick={() => (createOpen = true)}>{t('web.perms.newGroup')}</Btn>
	{/snippet}
</PageHeader>

{#if !available}
	<Flash kind="warning">
		<b>{t('web.perms.luckpermsIsNotAnswering')}</b> {problem}. The proxy may be stopped, LuckPerms may be
		{t('web.perms.missingOrLunacoreIs')}
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
			searchPlaceholder={t('web.perms.findGroup')}
			selectable="single"
			bind:selected
			{rowActions}
			rowLabel={(group) => group.name}
			onRowClick={(group) => goto(`/permissions/${encodeURIComponent(group.name)}`)}
			noun={t('web.perms.group')}
			{sortValue}
			pageSize={25}
			emptyTitle={t('web.perms.noGroups')}
			emptyText={t('web.perms.luckpermsAlwaysHasAtLeast')}
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

<Modal title={t('web.perms.newPermissionGroup')} bind:open={createOpen}>
	<label class="field">
		<span class="lbl">{t('web.perms.name')}</span>
		<span class="hint">{t('web.perms.lowercaseThisIsThe')}</span>
		<input class="input" bind:value={createName} placeholder={t('web.perms.eGModerator')} />
	</label>
	<label class="field">
		<span class="lbl">{t('web.perms.weight')}</span>
		<span class="hint">{t('web.perms.higherWeightWinsWhen')}</span>
		<input class="input" type="number" bind:value={createWeight} placeholder="0" />
	</label>
	<label class="field">
		<span class="lbl">{t('web.perms.displayName')}</span>
		<input class="input" bind:value={createDisplay} placeholder={t('web.perms.optional')} />
	</label>
	{#snippet footer()}
		<Btn onclick={() => (createOpen = false)}>{t('web.perms.cancel')}</Btn>
		<Btn variant="primary" disabled={!createName.trim()} onclick={doCreate}>{t('web.perms.create')}</Btn>
	{/snippet}
</Modal>

<Modal title="Delete group {deleteTarget}" bind:open={deleteOpen}>
	<p>
		{t('web.perms.theGroupIsRemoved')}
	</p>
	{#snippet footer()}
		<Btn onclick={() => (deleteOpen = false)}>{t('web.perms.cancel')}</Btn>
		<Btn variant="danger" onclick={doDelete}>{t('web.perms.delete')}</Btn>
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
