<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import { fmtDateTime } from '$lib/format';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import { Notify } from '$lib/notifications.svelte';
	import {
		accountSearchHref,
		groupHref,
		iamAuditLabel,
		iamAuditTone,
		keyIamAudit,
		policyHref,
		type IamAuditRow
	} from '$lib/iam';

	/**
	 * The access management trail: every change to a policy, a group, a
	 * membership or an attachment, newest first, with who made it.
	 */

	/** Entries the screen asks for; the store keeps 2,000. */
	const LIMIT = 2000;

	let audit: IamAuditRow[] = $state([]);
	let loading = $state(false);
	let loaded = $state(false);
	let lastUpdated: number | null = $state(null);

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const data = await api<{ audit: IamAuditRow[] }>(`/iam/audit?limit=${LIMIT}`);

			audit = keyIamAudit(data.audit);
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

	const columns: Column[] = $derived([
		{ id: 'when', label: t('web.iam.colWhen'), sortable: true, width: 180 },
		{ id: 'action', label: t('web.iam.colAction'), sortable: true, width: 200 },
		{ id: 'actor', label: t('web.iam.colActor'), sortable: true, width: 160 },
		{ id: 'target', label: t('web.iam.colTarget'), sortable: true, width: 220 },
		{ id: 'detail', label: t('web.iam.colDetail') }
	]);

	const filters: TableFilterGroup<IamAuditRow>[] = $derived([
		{
			id: 'kind',
			label: t('web.iam.filterActivity'),
			options: [
				{ value: 'any', label: t('web.iam.anyActivity') },
				{ value: 'policies', label: t('web.iam.policyActivity'), match: (row) => row.action.startsWith('policy.') },
				{ value: 'groups', label: t('web.iam.groupActivity'), match: (row) => row.action.startsWith('group.') },
				{
					value: 'attachments',
					label: t('web.iam.attachmentActivity'),
					match: (row) => row.action === 'attach' || row.action === 'detach' || row.action.startsWith('inline.')
				}
			]
		}
	]);
</script>

<svelte:head><title>{t('web.iamActivity.title')} | Luna Console</title></svelte:head>

<PageHeader title={t('web.iamActivity.title')} count={audit.length} description={t('web.iamActivity.description')} info>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="iam-activity" />
	{/snippet}
</PageHeader>

<Panel flush>
	<ResourceTable
		tableId="iam-activity"
		loading={!loaded}
		initialSearch={page.url.searchParams.get('q') ?? ''}
		{columns}
		{filters}
		rows={audit}
		getId={(row) => row.key}
		searchValue={(row) => `${row.action} ${row.actor ?? ''} ${row.target ?? ''} ${row.detail ?? ''}`}
		searchPlaceholder={t('web.iam.searchActivity')}
		noun={t('web.iam.activityNoun')}
		sortValue={(row, col) =>
			col === 'when'
				? row.t
				: col === 'action'
					? row.action
					: col === 'actor'
						? (row.actor ?? '')
						: col === 'target'
							? (row.target ?? '')
							: null}
		defaultSort={{ col: 'when', dir: 'desc' }}
		emptyTitle={t('web.iam.noActivityTitle')}
		emptyText={t('web.iam.noActivityText')}
	>
		{#snippet cell(row, col)}
			{#if col === 'when'}
				<span class="dim">{fmtDateTime(row.t)}</span>
			{:else if col === 'action'}
				<StatusBadge state={iamAuditTone(row.action)} label={iamAuditLabel(row.action)} />
			{:else if col === 'actor'}
				<span class:dim={!row.actor}>{row.actor ?? t('web.iam.noActor')}</span>
			{:else if col === 'target'}
				{#if row.target?.startsWith('group ')}
					<a href={groupHref(row.target.slice(6))}>{row.target}</a>
				{:else if row.target && row.action.startsWith('policy.') && row.action !== 'policy.delete'}
					<a href={policyHref(row.target)}>{row.target}</a>
				{:else if row.target && (row.action === 'attach' || row.action === 'detach' || row.action.startsWith('inline.'))}
					<a href={accountSearchHref(row.target)}>{row.target}</a>
				{:else}
					<span class:dim={!row.target}>{row.target ?? '–'}</span>
				{/if}
			{:else if col === 'detail'}
				<span class="dim">{row.detail ?? '–'}</span>
			{/if}
		{/snippet}
	</ResourceTable>
</Panel>
