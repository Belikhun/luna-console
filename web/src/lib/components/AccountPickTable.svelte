<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { fmtDateTime } from '$lib/format';
	import ResourceTable from './ResourceTable.svelte';
	import AccountAvatar from './AccountAvatar.svelte';
	import type { Column } from './table';
	import type { AccountSummary } from '$core/accounts';
	import { resourceId } from '$shared/iam/resources';

	/**
	 * A table to pick console accounts (IAM users) from, keyed by id: AWS's
	 * "Add users to the group". Accounts already in the target are locked.
	 */
	let {
		accounts,
		selected = $bindable(new Set<string>()),
		locked,
		tableId,
		maxHeight = '26rem'
	}: {
		accounts: AccountSummary[];
		selected?: Set<string>;
		locked?: (account: AccountSummary) => boolean;
		tableId: string;
		maxHeight?: string;
	} = $props();

	const columns: Column[] = $derived([
		{ id: 'username', label: t('web.iamList.colUserName'), sortable: true, width: 220 },
		{ id: 'displayName', label: t('web.iamList.colDisplayName'), sortable: true, width: 200 },
		{ id: 'lastSignIn', label: t('web.iamList.colLastSignIn'), sortable: true, width: 180 },
		{ id: 'created', label: t('web.iamList.colCreated'), sortable: true, width: 180, hidden: true }
	]);
</script>

<ResourceTable
	{tableId}
	{columns}
	rows={accounts}
	getId={(row) => row.id}
	resourceId={(row) => resourceId('account', row.username)}
	searchValue={(row) => `${row.username} ${row.displayName} ${row.email}`}
	searchPlaceholder={t('web.iamList.searchUsers')}
	searchWidth="18rem"
	selectable="multi"
	bind:selected
	rowLocked={locked}
	rowDim={(row) => !row.enabled}
	paging
	pageSize={10}
	{maxHeight}
	noun={t('web.iamList.userNoun')}
	sortValue={(row, col) =>
		col === 'lastSignIn'
			? (row.lastSignInAt ?? 0)
			: col === 'created'
				? row.createdAt
				: null}
	emptyTitle={t('web.iamList.noUsers')}
>
	{#snippet cell(row, col)}
		{#if col === 'username'}
			<span class="who">
				<AccountAvatar account={row} size="1.25rem" />
				<a href="/console/accounts/{row.id}" target="_blank" rel="noopener">{row.username}</a>
			</span>
		{:else if col === 'displayName'}
			<span class:dim={!row.displayName}>{row.displayName || '–'}</span>
		{:else if col === 'lastSignIn'}
			<span class="dim">{row.lastSignInAt ? fmtDateTime(row.lastSignInAt) : t('web.accounts.never')}</span>
		{:else if col === 'created'}
			<span class="dim">{fmtDateTime(row.createdAt)}</span>
		{/if}
	{/snippet}
</ResourceTable>

<style lang="scss">
	.who {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}
</style>
