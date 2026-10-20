<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, del } from '$lib/api';
	import { fmtDateTime } from '$lib/format';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { Authz } from '$lib/authz.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import { groupHref, notifyEach, runEach, type GroupRow } from '$lib/iam';
	import { resourceId } from '$shared/iam/resources';
	import { withCopyResourceId } from '$lib/resourceid';

	/**
	 * User groups, AWS's list: each group with how many accounts it holds,
	 * whether it carries any permissions, and when it was made.
	 */

	let groups: GroupRow[] = $state([]);
	let loading = $state(false);
	let loaded = $state(false);
	let lastUpdated: number | null = $state(null);
	let selected: Set<string> = $state(new Set());
	let deleteOpen = $state(false);
	let deleteRows: GroupRow[] = $state([]);

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const data = await api<{ groups: GroupRow[] }>('/iam/groups');

			groups = data.groups;
			lastUpdated = Date.now();
		} catch (err) {
			Notify.error(t('web.iam.loadFailed'), { detail: (err as Error).message });
		} finally {
			loading = false;
			loaded = true;
		}
	}

	onMount(() => {
		void refresh();
	});

	const picked = $derived(groups.filter((row) => selected.has(row.name)));

	function denied(action: string): string {
		return Authz.can(action)
			? ''
			: t('web.common.notAllowed', { action });
	}

	function hasPermissions(row: GroupRow): boolean {
		return row.policies.length + row.inline.length > 0;
	}

	function askDelete(rows: GroupRow[]): void {
		if (rows.length === 0) {
			return;
		}

		deleteRows = rows;
		deleteOpen = true;
	}

	async function deleteConfirmed(): Promise<void> {
		const outcome = await runEach(
			deleteRows,
			(row) => del(`/iam/groups/${encodeURIComponent(row.name)}`),
			(row) => row.name
		);

		selected = new Set();
		notifyEach(outcome, t('web.iamList.groupsDeleted', { count: outcome.done }), t('web.iamList.groupsDeleteFailed'));
		await refresh();
	}

	function groupActions(rows: GroupRow[]): ContextMenuItem[] {
		const one = rows.length === 1 ? rows[0] : undefined;
		const pickOne = t('web.iam.pickOne');
		const deleteReason = rows.length === 0 ? t('web.iamList.pickGroups') : denied('iam:DeleteGroup');

		return [
			{
				label: t('web.iamList.viewDetails'),
				icon: 'circleInfo',
				disabled: !one,
				hint: one ? undefined : pickOne,
				action: () => goto(groupHref(one!.name))
			},
			{
				label: t('web.iamList.addUsers'),
				icon: 'userPlus',
				disabled: !one,
				hint: one ? undefined : pickOne,
				action: () => goto(`${groupHref(one!.name)}?tab=users&add=1`)
			},
			{
				label: t('web.iamList.attachPolicies'),
				icon: 'link',
				disabled: !one,
				hint: one ? undefined : pickOne,
				action: () => goto(`${groupHref(one!.name)}?tab=permissions`)
			},
			{ separator: true },
			{
				label: t('web.iamList.deleteGroups', { count: rows.length }),
				icon: 'trash',
				color: 'danger',
				disabled: !!deleteReason,
				hint: deleteReason || undefined,
				action: () => askDelete(rows)
			}
		];
	}

	function rowActions(row: GroupRow): ContextMenuItem[] {
		return groupActions(selected.has(row.name) && picked.length > 1 ? picked : [row]);
	}

	const headerMenu = $derived(
		withCopyResourceId(groupActions(picked), picked.map((row) => resourceId('group', row.name)))
	);
	const deleteReason = $derived(picked.length === 0 ? t('web.iamList.pickGroups') : denied('iam:DeleteGroup'));

	const columns: Column[] = $derived([
		{ id: 'name', label: t('web.iamList.colGroupName'), sortable: true, width: 260 },
		{ id: 'users', label: t('web.iamList.colUsers'), sortable: true, width: 110 },
		{ id: 'permissions', label: t('web.iamList.colPermissions'), sortable: true, width: 160 },
		{ id: 'created', label: t('web.iamList.colCreationTime'), sortable: true, width: 200 },
		{ id: 'description', label: t('web.iamList.colDescription'), hidden: true }
	]);

	const filters: TableFilterGroup<GroupRow>[] = $derived([
		{
			id: 'permissions',
			label: t('web.iamList.filterPermissions'),
			options: [
				{ value: 'any', label: t('web.iamList.anyPermissions') },
				{ value: 'defined', label: t('web.iamList.permissionsDefined'), match: (row) => hasPermissions(row) },
				{ value: 'none', label: t('web.iamList.permissionsNotDefined'), match: (row) => !hasPermissions(row) }
			]
		}
	]);
</script>

<svelte:head><title>{t('web.iamList.groupsTitle')} | Luna Console</title></svelte:head>

<PageHeader title={t('web.iamList.groupsTitle')} count={groups.length} description={t('web.iamList.groupsDescription')} info>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="iam-groups" />
		<Dropdown label={t('web.common.actions')} disabled={picked.length === 0} menu={headerMenu} />
		<Btn icon="trash" disabled={!!deleteReason} title={deleteReason || undefined} onclick={() => askDelete(picked)}>
			{t('web.common.delete')}
		</Btn>
		<Btn
			variant="primary"
			icon="plus"
			href="/console/iam/groups/new"
			disabled={!!denied('iam:CreateGroup')}
			title={denied('iam:CreateGroup') || undefined}
		>
			{t('web.iamList.createGroup')}
		</Btn>
	{/snippet}
</PageHeader>

<Panel flush>
	<ResourceTable
		tableId="iam-groups"
		loading={!loaded}
		initialSearch={page.url.searchParams.get('q') ?? ''}
		{columns}
		{filters}
		rows={groups}
		getId={(row) => row.name}
		searchValue={(row) => `${row.name} ${row.description} ${row.members.map((member) => member.username).join(' ')}`}
		searchPlaceholder={t('web.iamList.searchGroups')}
		selectable="multi"
		bind:selected
		{rowActions}
		rowLabel={(row) => row.name}
		resourceId={(row) => resourceId('group', row.name)}
		noun={t('web.iam.groupNoun')}
		sortValue={(row, col) =>
			col === 'users'
				? row.members.length
				: col === 'permissions'
					? (hasPermissions(row) ? 1 : 0)
					: col === 'created'
						? row.createdAt
						: null}
		emptyTitle={t('web.iam.noGroupsTitle')}
		emptyText={t('web.iam.noGroupsText')}
	>
		{#snippet cell(row, col)}
			{#if col === 'name'}
				<a href={groupHref(row.name)}>{row.name}</a>
			{:else if col === 'users'}
				<span class="mono">{row.members.length}</span>
			{:else if col === 'permissions'}
				{#if hasPermissions(row)}
					<StatusBadge state="ok" label={t('web.iamList.permissionsDefined')} />
				{:else}
					<StatusBadge state="stopped" label={t('web.iamList.permissionsNotDefined')} />
				{/if}
			{:else if col === 'created'}
				<span class="dim">{fmtDateTime(row.createdAt)}</span>
			{:else if col === 'description'}
				<span class="dim">{row.description || '–'}</span>
			{/if}
		{/snippet}
	</ResourceTable>
</Panel>

<ConfirmModal
	bind:open={deleteOpen}
	title={t('web.iam.deleteGroupTitle', { count: deleteRows.length })}
	lead={t('web.iam.deleteGroupLead', { names: deleteRows.map((row) => row.name).join(', ') })}
	notes={[t('web.iam.deleteGroupNote')]}
	confirmLabel={t('web.common.delete')}
	onconfirm={() => void deleteConfirmed()}
/>
