<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { fmtDateTime } from '$lib/format';
	import ResourceTable from './ResourceTable.svelte';
	import type { Column } from './table';
	import { groupHref, type GroupRow } from '$lib/iam';
	import { resourceId } from '$shared/iam/resources';

	/**
	 * A table to pick user groups from: AWS's "Add user to group" list. Groups
	 * the account is already in are locked, not hidden.
	 */
	let {
		groups,
		selected = $bindable(new Set<string>()),
		locked,
		tableId,
		maxHeight = '26rem'
	}: {
		groups: GroupRow[];
		selected?: Set<string>;
		/** groups the account is already a member of */
		locked?: (group: GroupRow) => boolean;
		tableId: string;
		maxHeight?: string;
	} = $props();

	const columns: Column[] = $derived([
		{ id: 'name', label: t('web.iamList.colGroupName'), sortable: true, width: 220 },
		{ id: 'users', label: t('web.iamList.colUsers'), sortable: true, width: 100 },
		{ id: 'policies', label: t('web.iamList.colAttachedPolicies') },
		{ id: 'created', label: t('web.iamList.colCreated'), sortable: true, width: 180, hidden: true }
	]);
</script>

<ResourceTable
	{tableId}
	{columns}
	rows={groups}
	getId={(row) => row.name}
	resourceId={(row) => resourceId('group', row.name)}
	searchValue={(row) => `${row.name} ${row.description} ${row.policies.join(' ')}`}
	searchPlaceholder={t('web.iamList.searchGroups')}
	searchWidth="18rem"
	selectable="multi"
	bind:selected
	rowLocked={locked}
	paging
	pageSize={10}
	{maxHeight}
	noun={t('web.iam.groupNoun')}
	sortValue={(row, col) =>
		col === 'users'
			? row.members.length
			: col === 'created'
				? row.createdAt
				: null}
	emptyTitle={t('web.iam.noGroupsTitle')}
	emptyText={t('web.iam.noGroupsText')}
>
	{#snippet cell(row, col)}
		{#if col === 'name'}
			<a href={groupHref(row.name)} target="_blank" rel="noopener">{row.name}</a>
		{:else if col === 'users'}
			<span class="mono">{row.members.length}</span>
		{:else if col === 'policies'}
			<span class:dim={row.policies.length + row.inline.length === 0}>
				{[...row.policies, ...row.inline.map((inline) => inline.name)].join(', ') || '–'}
			</span>
		{:else if col === 'created'}
			<span class="dim">{fmtDateTime(row.createdAt)}</span>
		{/if}
	{/snippet}
</ResourceTable>
