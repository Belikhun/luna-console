<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { api } from '$lib/api';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import type { Column } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { Notify } from '$lib/notifications.svelte';

	interface GroupInfo {
		name: string;
		description: string;
		builtin: boolean;
		plugins: string[];
		respacks: string[];
		datapacks: string[];
		usedBy: string[];
	}

	let groups: GroupInfo[] = $state([]);
	let loading = $state(true);
	let lastUpdated: number | null = $state(null);

	async function refresh(): Promise<void> {
		loading = true;

		try {
			groups = (await api('/addons/groups')).groups;
			lastUpdated = Date.now();
		} catch (err) {
			Notify.error(t('web.addonGroups.loadFailed'), { detail: (err as Error).message });
		}

		loading = false;
	}

	onMount(() => {
		void refresh();
	});

	const columns: Column[] = $derived([
		{ id: 'name', label: t('web.addonGroups.colGroup'), sortable: true, width: 200 },
		{ id: 'count', label: t('web.addonGroups.colAddons'), width: 200 },
		{ id: 'plugins', label: t('web.addonGroups.colMembers') },
		{ id: 'usedBy', label: t('web.addonGroups.colUsedBy'), width: 240 },
		{ id: 'description', label: t('web.env.colDescription') }
	]);

	/** Every member of a group, in one flat list; search and the copy verb. */
	function members(group: GroupInfo): string[] {
		return [...group.plugins, ...group.respacks, ...group.datapacks];
	}

	function rowActions(group: GroupInfo): ContextMenuItem[] {
		return [
			{
				label: t('web.addonGroups.openGroup'),
				icon: 'layerGroup',
				action: () => goto(`/addons/groups/${group.name}`)
			},
			{
				label: t('web.addonGroups.addAddons'),
				icon: 'plus',
				action: () => goto(`/addons/groups/${group.name}?add=1`)
			},
			{ separator: true },
			{
				label: t('web.addonGroups.copyMembers'),
				icon: 'copy',
				disabled: members(group).length === 0,
				action: () => navigator.clipboard?.writeText(members(group).join(', '))
			}
		];
	}

	let selected: Set<string> = $state(new Set());

	/** The row the header's Actions dropdown acts on. */
	const one = $derived(groups.find((row: any) => selected.has(row.name)));
</script>

<svelte:head><title>{t('web.nav.addonGroups')} | Luna Console</title></svelte:head>

<PageHeader
	title={t('web.nav.addonGroups')}
	count={groups.length}
	description={t('web.addonGroups.pageDescription')}
	info
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="addon-groups" />
		<Dropdown label={t('web.common.actions')} disabled={!one} menu={one ? rowActions(one) : []} />
		<Btn variant="primary" icon="layerGroup" onclick={() => goto('/addons/groups/new')}>
			{t('web.addonGroups.createGroup')}
		</Btn>
	{/snippet}
</PageHeader>

<Panel flush>
	<ResourceTable
		tableId="plugin-groups"
		{columns}
		rows={groups}
		getId={(group) => group.name}
		searchValue={(group) =>
			`${group.name} ${group.description} ${members(group).join(' ')} ${group.usedBy.join(' ')}`}
		searchPlaceholder={t('web.addonGroups.searchPlaceholder')}
		selectable="single"
		bind:selected
		{rowActions}
		rowLabel={(group) => group.name}
		noun={t('web.addonGroups.noun')}
		onRowClick={(group) => goto(`/addons/groups/${group.name}`)}
		emptyTitle={t('web.addonGroups.emptyTitle')}
		emptyText={t('web.addonGroups.emptyText')}
	>
		{#snippet cell(group, col)}
			{#if col === 'name'}
				<a href="/addons/groups/{group.name}" onclick={(event) => event.stopPropagation()}>
					<b>{group.name}</b>
				</a>
				{#if group.builtin}<StatusBadge state="ok" label={t('web.addonGroups.builtin')} />{/if}
			{:else if col === 'count'}
				<span class="kinds">
					<span class="kind"><Icon name="plug" size="0.75rem" />{group.plugins.length}</span>
					<span class="kind" class:zero={!group.respacks.length}>
						<Icon name="image" size="0.75rem" />{group.respacks.length}
					</span>
					<span class="kind" class:zero={!group.datapacks.length}>
						<Icon name="box" size="0.75rem" />{group.datapacks.length}
					</span>
				</span>
			{:else if col === 'plugins'}
				<span class="dim">{members(group).join(', ')}</span>
			{:else if col === 'usedBy'}
				{group.usedBy.join(', ') || '–'}
			{:else if col === 'description'}
				<span class="dim">{group.description || '–'}</span>
			{/if}
		{/snippet}
	</ResourceTable>
</Panel>

<style lang="scss">
	// three counts in one cell: plugins, resource packs, data packs
	.kinds {
		display: inline-flex;
		gap: 0.75rem;
	}

	.kind {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		color: var(--text);

		&.zero {
			color: var(--text-disabled);
		}
	}
</style>
