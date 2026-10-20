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
	import Tabs from '$lib/components/Tabs.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import OverviewBar from '$lib/components/OverviewBar.svelte';
	import OverviewCell from '$lib/components/OverviewCell.svelte';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { Notify } from '$lib/notifications.svelte';
	import {
		accountSearchHref,
		attachedCount,
		groupHref,
		iamAuditLabel,
		iamAuditTone,
		keyIamAudit,
		policyDeleteReason,
		policyHref,
		policyKindLabel,
		type GroupRow,
		type IamAuditRow,
		type PolicyRow
	} from './iam';

	/**
	 * Permissions: the policies that say what an account may do, the groups
	 * those policies are attached to, and what was done to both. One subject read
	 * three ways, like the Accounts screen, so three tabs rather than three screens.
	 */

	let policies: PolicyRow[] = $state([]);
	let groups: GroupRow[] = $state([]);
	let audit: IamAuditRow[] = $state([]);

	let loading = $state(false);
	let loaded = $state(false);
	let lastUpdated: number | null = $state(null);
	let tab = $state(page.url.searchParams.get('tab') ?? 'policies');
	let selectedPolicies: Set<string> = $state(new Set());
	let selectedGroups: Set<string> = $state(new Set());

	let deletePoliciesOpen = $state(false);
	let deletePolicyRows: PolicyRow[] = $state([]);
	let deleteGroupsOpen = $state(false);
	let deleteGroupRows: GroupRow[] = $state([]);

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const [policyData, groupData, auditData] = await Promise.all([
				api('/iam/policies'),
				api('/iam/groups'),
				api('/iam/audit?limit=500')
			]);

			policies = policyData.policies;
			groups = groupData.groups;
			audit = keyIamAudit(auditData.audit);
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

	const pickedPolicies = $derived(policies.filter((row) => selectedPolicies.has(row.name)));
	const pickedGroups = $derived(groups.filter((row) => selectedGroups.has(row.name)));

	const counts = $derived({
		builtin: policies.filter((row) => row.builtin).length,
		managed: policies.filter((row) => !row.builtin).length,
		members: groups.reduce((sum, group) => sum + group.members.length, 0)
	});

	async function runBulk<T extends { name: string }>(
		rows: T[],
		verb: string,
		run: (row: T) => Promise<unknown>
	): Promise<void> {
		if (rows.length === 0) {
			return;
		}

		const failed: string[] = [];

		for (const row of rows) {
			try {
				await run(row);
			} catch (err) {
				failed.push(`${row.name}: ${(err as Error).message}`);
			}
		}

		const done = rows.length - failed.length;

		if (failed.length === 0) {
			Notify.success(t('web.iam.bulkDone', { verb, count: done }));
		} else if (done === 0) {
			Notify.error(t('web.iam.bulkFailed', { verb }), { detail: failed.join('\n') });
		} else {
			Notify.warning(t('web.iam.bulkPartial', { verb, done, failed: failed.length }), {
				detail: failed.join('\n')
			});
		}

		await refresh();
	}

	function removePolicies(rows: PolicyRow[]): void {
		if (rows.length === 0) {
			return;
		}

		deletePolicyRows = rows;
		deletePoliciesOpen = true;
	}

	async function removePoliciesConfirmed(): Promise<void> {
		await runBulk(deletePolicyRows, t('web.iam.verbDelete'), (row) => del(`/iam/policies/${encodeURIComponent(row.name)}`));
	}

	function removeGroups(rows: GroupRow[]): void {
		if (rows.length === 0) {
			return;
		}

		deleteGroupRows = rows;
		deleteGroupsOpen = true;
	}

	async function removeGroupsConfirmed(): Promise<void> {
		await runBulk(deleteGroupRows, t('web.iam.verbDelete'), (row) => del(`/iam/groups/${encodeURIComponent(row.name)}`));
	}

	function policyActions(rows: PolicyRow[]): ContextMenuItem[] {
		const one = rows.length === 1 ? rows[0] : undefined;
		const deletable = rows.filter((row) => !policyDeleteReason(row));

		const deleteHint = one
			? policyDeleteReason(one) || undefined
			: deletable.length === 0
				? t('web.iam.noneDeletable')
				: undefined;

		return [
			{
				label: t('web.iam.openPolicy'),
				icon: 'circleInfo',
				disabled: !one,
				hint: one ? undefined : t('web.iam.pickOne'),
				action: () => goto(policyHref(one!.name))
			},
			{
				label: t('web.iam.viewDocument'),
				icon: 'fileLines',
				disabled: !one,
				hint: one ? undefined : t('web.iam.pickOne'),
				action: () => goto(`${policyHref(one!.name)}?tab=document`)
			},
			{ separator: true },
			{
				label: t('web.iam.deletePolicyAction', { count: deletable.length }),
				icon: 'trash',
				color: 'danger',
				disabled: deletable.length === 0,
				hint: deleteHint,
				action: () => removePolicies(deletable)
			}
		];
	}

	function policyRowActions(row: PolicyRow): ContextMenuItem[] {
		return policyActions(selectedPolicies.has(row.name) && pickedPolicies.length > 1 ? pickedPolicies : [row]);
	}

	function groupActions(rows: GroupRow[]): ContextMenuItem[] {
		const one = rows.length === 1 ? rows[0] : undefined;

		return [
			{
				label: t('web.iam.openGroup'),
				icon: 'circleInfo',
				disabled: !one,
				hint: one ? undefined : t('web.iam.pickOne'),
				action: () => goto(groupHref(one!.name))
			},
			{
				label: t('web.iam.viewMembers'),
				icon: 'users',
				disabled: !one,
				hint: one ? undefined : t('web.iam.pickOne'),
				action: () => goto(`${groupHref(one!.name)}?tab=members`)
			},
			{ separator: true },
			{
				label: t('web.iam.deleteGroupAction', { count: rows.length }),
				icon: 'trash',
				color: 'danger',
				disabled: rows.length === 0,
				action: () => removeGroups(rows)
			}
		];
	}

	function groupRowActions(row: GroupRow): ContextMenuItem[] {
		return groupActions(selectedGroups.has(row.name) && pickedGroups.length > 1 ? pickedGroups : [row]);
	}

	const headerMenu = $derived(
		tab === 'groups'
			? groupActions(pickedGroups)
			: policyActions(pickedPolicies)
	);

	const headerDisabled = $derived(
		tab === 'activity' || (tab === 'groups' ? pickedGroups.length === 0 : pickedPolicies.length === 0)
	);

	const policyColumns: Column[] = $derived([
		{ id: 'name', label: t('web.iam.colName'), sortable: true, width: 220 },
		{ id: 'kind', label: t('web.iam.colKind'), sortable: true, width: 120 },
		{ id: 'description', label: t('web.iam.colDescription') },
		{ id: 'statements', label: t('web.iam.colStatements'), sortable: true, width: 110 },
		{ id: 'attached', label: t('web.iam.colAttachedTo'), sortable: true, width: 200 },
		{ id: 'created', label: t('web.iam.colCreated'), sortable: true, width: 180, hidden: true },
		{ id: 'updated', label: t('web.iam.colUpdated'), sortable: true, width: 180 }
	]);

	const policyFilters: TableFilterGroup<PolicyRow>[] = $derived([
		{
			id: 'kind',
			label: t('web.iam.filterKind'),
			options: [
				{ value: 'any', label: t('web.iam.anyKind') },
				{ value: 'managed', label: t('web.iam.managed'), match: (row) => !row.builtin },
				{ value: 'builtin', label: t('web.iam.builtin'), match: (row) => row.builtin }
			]
		},
		{
			id: 'attached',
			label: t('web.iam.filterAttached'),
			options: [
				{ value: 'any', label: t('web.iam.anyAttachment') },
				{ value: 'attached', label: t('web.iam.attachedSomewhere'), match: (row) => attachedCount(row) > 0 },
				{ value: 'unattached', label: t('web.iam.attachedNowhere'), match: (row) => attachedCount(row) === 0 }
			]
		}
	]);

	const groupColumns: Column[] = $derived([
		{ id: 'name', label: t('web.iam.colName'), sortable: true, width: 220 },
		{ id: 'description', label: t('web.iam.colDescription') },
		{ id: 'members', label: t('web.iam.colMembers'), sortable: true, width: 110 },
		{ id: 'policies', label: t('web.iam.colPolicies'), sortable: true, width: 110 },
		{ id: 'created', label: t('web.iam.colCreated'), sortable: true, width: 180 },
		{ id: 'updated', label: t('web.iam.colUpdated'), sortable: true, width: 180, hidden: true }
	]);

	const auditColumns: Column[] = $derived([
		{ id: 'when', label: t('web.iam.colWhen'), sortable: true, width: 180 },
		{ id: 'action', label: t('web.iam.colAction'), sortable: true, width: 200 },
		{ id: 'actor', label: t('web.iam.colActor'), sortable: true, width: 160 },
		{ id: 'target', label: t('web.iam.colTarget'), sortable: true, width: 200 },
		{ id: 'detail', label: t('web.iam.colDetail') }
	]);

	const auditFilters: TableFilterGroup<IamAuditRow>[] = $derived([
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

	function policySort(row: PolicyRow, col: string): string | number | null {
		if (col === 'kind') {
			return row.builtin ? 0 : 1;
		}

		if (col === 'statements') {
			return row.document.Statement.length;
		}

		if (col === 'attached') {
			return attachedCount(row);
		}

		if (col === 'created') {
			return row.createdAt ?? 0;
		}

		if (col === 'updated') {
			return row.updatedAt ?? 0;
		}

		return null;
	}

	function groupSort(row: GroupRow, col: string): string | number | null {
		if (col === 'members') {
			return row.members.length;
		}

		if (col === 'policies') {
			return row.policies.length + row.inline.length;
		}

		if (col === 'created') {
			return row.createdAt;
		}

		if (col === 'updated') {
			return row.updatedAt;
		}

		return null;
	}
</script>

<svelte:head><title>{t('web.iam.title')} | Luna Console</title></svelte:head>

<PageHeader title={t('web.iam.title')} count={policies.length + groups.length} description={t('web.iam.pageDescription')} info>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="console-iam" />
		<Dropdown label={t('web.common.actions')} disabled={headerDisabled} menu={headerMenu} />
		<Btn variant={tab === 'groups' ? 'primary' : 'normal'} icon="users" href="/console/iam/groups/new">
			{t('web.iam.createGroup')}
		</Btn>
		<Btn variant={tab === 'groups' ? 'normal' : 'primary'} icon="plus" href="/console/iam/policies/new">
			{t('web.iam.createPolicy')}
		</Btn>
	{/snippet}
</PageHeader>

<OverviewBar title={t('web.iam.overview')}>
	<OverviewCell label={t('web.iam.overviewPolicies')}>
		{policies.length}
		<span class="dim">({t('web.iam.overviewPolicyKinds', { managed: counts.managed, builtin: counts.builtin })})</span>
	</OverviewCell>
	<OverviewCell label={t('web.iam.overviewGroups')}>{groups.length}</OverviewCell>
	<OverviewCell label={t('web.iam.overviewMemberships')}>{counts.members}</OverviewCell>
	<OverviewCell label={t('web.iam.overviewActivity')}>{audit.length}</OverviewCell>
</OverviewBar>

<Tabs
	tabs={[
		{ id: 'policies', label: t('web.iam.tabPolicies') },
		{ id: 'groups', label: t('web.iam.tabGroups') },
		{ id: 'activity', label: t('web.iam.tabActivity') }
	]}
	bind:active={tab}
/>

<div class="tabbody">
	{#if tab === 'policies'}
		<Panel flush>
			<ResourceTable
				tableId="console-iam-policies"
				loading={!loaded}
				initialSearch={page.url.searchParams.get('q') ?? ''}
				columns={policyColumns}
				filters={policyFilters}
				rows={policies}
				getId={(row) => row.name}
				searchValue={(row) => `${row.name} ${row.description}`}
				searchPlaceholder={t('web.iam.searchPolicies')}
				selectable="multi"
				bind:selected={selectedPolicies}
				rowActions={policyRowActions}
				rowLabel={(row) => row.name}
				noun={t('web.iam.policyNoun')}
				onRowClick={(row) => goto(policyHref(row.name))}
				sortValue={policySort}
				emptyTitle={t('web.iam.noPoliciesTitle')}
				emptyText={t('web.iam.noPoliciesText')}
			>
				{#snippet cell(row, col)}
					{#if col === 'name'}
						<a href={policyHref(row.name)}><b>{row.name}</b></a>
					{:else if col === 'kind'}
						<StatusBadge state={row.builtin ? 'info' : 'ok'} label={policyKindLabel(row)} />
					{:else if col === 'description'}
						<span class="dim text">{row.description || '–'}</span>
					{:else if col === 'statements'}
						<span class="mono">{row.document.Statement.length}</span>
					{:else if col === 'attached'}
						{#if attachedCount(row) === 0}
							<span class="dim">{t('web.iam.attachedNowhere')}</span>
						{:else}
							<span>
								{t('web.iam.attachedSummary', {
									accounts: row.attachedTo.accounts.length,
									groups: row.attachedTo.groups.length
								})}
							</span>
						{/if}
					{:else if col === 'created'}
						<span class:dim={!row.createdAt}>{row.createdAt ? fmtDateTime(row.createdAt) : '–'}</span>
					{:else if col === 'updated'}
						<span class:dim={!row.updatedAt}>{row.updatedAt ? fmtDateTime(row.updatedAt) : '–'}</span>
					{/if}
				{/snippet}
			</ResourceTable>
		</Panel>
	{:else if tab === 'groups'}
		<Panel flush>
			<ResourceTable
				tableId="console-iam-groups"
				loading={!loaded}
				columns={groupColumns}
				rows={groups}
				getId={(row) => row.name}
				searchValue={(row) => `${row.name} ${row.description} ${row.members.map((member) => member.username).join(' ')}`}
				searchPlaceholder={t('web.iam.searchGroups')}
				selectable="multi"
				bind:selected={selectedGroups}
				rowActions={groupRowActions}
				rowLabel={(row) => row.name}
				noun={t('web.iam.groupNoun')}
				onRowClick={(row) => goto(groupHref(row.name))}
				sortValue={groupSort}
				emptyTitle={t('web.iam.noGroupsTitle')}
				emptyText={t('web.iam.noGroupsText')}
			>
				{#snippet cell(row, col)}
					{#if col === 'name'}
						<a href={groupHref(row.name)}><b>{row.name}</b></a>
					{:else if col === 'description'}
						<span class="dim text">{row.description || '–'}</span>
					{:else if col === 'members'}
						<span class="mono">{row.members.length}</span>
					{:else if col === 'policies'}
						<span class="mono">{row.policies.length}</span>
						{#if row.inline.length}
							<span class="dim">· {t('web.iam.inlineShort', { count: row.inline.length })}</span>
						{/if}
					{:else if col === 'created'}
						<span class="dim">{fmtDateTime(row.createdAt)}</span>
					{:else if col === 'updated'}
						<span class="dim">{fmtDateTime(row.updatedAt)}</span>
					{/if}
				{/snippet}
			</ResourceTable>
		</Panel>
	{:else}
		<Panel flush>
			<ResourceTable
				tableId="console-iam-audit"
				loading={!loaded}
				columns={auditColumns}
				filters={auditFilters}
				rows={audit}
				getId={(row) => row.key}
				searchValue={(row) => `${row.action} ${row.actor ?? ''} ${row.target ?? ''} ${row.detail ?? ''}`}
				searchPlaceholder={t('web.iam.searchActivity')}
				noun={t('web.iam.activityNoun')}
				sortValue={(row, col) => (col === 'when' ? row.t : null)}
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
						{:else if row.target && row.action.startsWith('policy.')}
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
	{/if}
</div>

<ConfirmModal
	bind:open={deletePoliciesOpen}
	title={t('web.iam.deletePolicyTitle', { count: deletePolicyRows.length })}
	lead={t('web.iam.deletePolicyLead', { names: deletePolicyRows.map((row) => row.name).join(', ') })}
	notes={[t('web.iam.deletePolicyNote')]}
	confirmLabel={t('web.common.delete')}
	onconfirm={() => void removePoliciesConfirmed()}
/>

<ConfirmModal
	bind:open={deleteGroupsOpen}
	title={t('web.iam.deleteGroupTitle', { count: deleteGroupRows.length })}
	lead={t('web.iam.deleteGroupLead', { names: deleteGroupRows.map((row) => row.name).join(', ') })}
	notes={[t('web.iam.deleteGroupNote')]}
	confirmLabel={t('web.common.delete')}
	onconfirm={() => void removeGroupsConfirmed()}
/>

<style lang="scss">
	.tabbody {
		margin-top: 1rem;
	}

	.text {
		@include ellipsis;

		display: block;
	}
</style>
