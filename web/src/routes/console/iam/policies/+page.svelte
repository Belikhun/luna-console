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
	import Icon from '$lib/components/Icon.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import PolicyYamlPreview from '$lib/components/PolicyYamlPreview.svelte';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import { menuGroups, type ContextMenuItem } from '$lib/components/contextmenu';
	import { Authz } from '$lib/authz.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import { resourceId } from '$shared/iam/resources';
	import { withCopyResourceId } from '$lib/resourceid';
	import {
		POLICY_KIND_ICONS,
		attachedCount,
		policyDeleteReason,
		policyHref,
		policyKind,
		policyKindLabel,
		usedAsLabel,
		type PolicyRow
	} from '$lib/iam';

	/**
	 * Policies, AWS's list: every built-in and managed policy with its type, what
	 * it is used as and what it is for, each row unfolding into its document.
	 * The verbs act on one policy at a time, so the table picks one.
	 */

	let policies: PolicyRow[] = $state([]);
	let loading = $state(false);
	let loaded = $state(false);
	let lastUpdated: number | null = $state(null);
	let selected: Set<string> = $state(new Set());
	let deleteOpen = $state(false);
	let deleteRow = $state<PolicyRow | null>(null);

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const data = await api<{ policies: PolicyRow[] }>('/iam/policies');

			policies = data.policies;
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

	const picked = $derived(policies.find((row) => selected.has(row.name)));

	function denied(action: string): string {
		return Authz.can(action)
			? ''
			: t('web.common.notAllowed', { action });
	}

	function askDelete(row: PolicyRow): void {
		deleteRow = row;
		deleteOpen = true;
	}

	async function deleteConfirmed(): Promise<void> {
		const row = deleteRow;

		if (!row) {
			return;
		}

		try {
			await del(`/iam/policies/${encodeURIComponent(row.name)}`);

			Notify.success(t('web.iamPolicy.removed', { name: row.name }));
			selected = new Set();
			await refresh();
		} catch (err) {
			Notify.error(t('web.iamPolicy.updateFailed'), { detail: (err as Error).message });
		}
	}

	function policyActions(row: PolicyRow | undefined): ContextMenuItem[] {
		const pickOne = t('web.iamList.pickPolicy');
		const editReason = !row
			? pickOne
			: row.builtin
				? t('web.iam.builtinNoEdit')
				: denied('iam:UpdatePolicy');
		const deleteReason = !row
			? pickOne
			: policyDeleteReason(row) || denied('iam:DeletePolicy');

		return menuGroups(
			[
				{
					label: t('web.iamList.viewDetails'),
					icon: 'circleInfo',
					disabled: !row,
					hint: row ? undefined : pickOne,
					action: () => goto(policyHref(row!.name))
				}
			],
			[
				{
					label: t('web.common.edit'),
					icon: 'pen',
					disabled: !!editReason,
					hint: editReason || undefined,
					action: () => goto(`${policyHref(row!.name)}/edit`)
				},
				{
					label: t('web.iamList.attach'),
					icon: 'link',
					disabled: !row || !!denied('iam:Attach'),
					hint: row ? denied('iam:Attach') || undefined : pickOne,
					action: () => goto(`${policyHref(row!.name)}?tab=entities&attach=1`)
				}
			],
			[
				{
					label: t('web.common.delete'),
					icon: 'trash',
					color: 'danger',
					disabled: !!deleteReason,
					hint: deleteReason || undefined,
					action: () => askDelete(row!)
				}
			]
		);
	}

	const headerMenu = $derived(
		picked
			? withCopyResourceId(policyActions(picked), [resourceId('policy', picked.name)])
			: policyActions(picked)
	);
	const deleteReason = $derived(picked ? policyDeleteReason(picked) || denied('iam:DeletePolicy') : t('web.iamList.pickPolicy'));

	const columns: Column[] = $derived([
		{ id: 'name', label: t('web.iamList.colPolicyName'), sortable: true, width: 280 },
		{ id: 'type', label: t('web.iamList.colType'), sortable: true, width: 170 },
		{ id: 'usedAs', label: t('web.iamList.colUsedAs'), sortable: true, width: 200 },
		{ id: 'description', label: t('web.iamList.colDescription') },
		{ id: 'created', label: t('web.iamList.colCreated'), sortable: true, width: 180, hidden: true },
		{ id: 'updated', label: t('web.iamList.colEdited'), sortable: true, width: 180, hidden: true }
	]);

	const filters: TableFilterGroup<PolicyRow>[] = $derived([
		{
			id: 'type',
			label: t('web.iamList.filterType'),
			options: [
				{ value: 'any', label: t('web.iamList.anyType') },
				{ value: 'builtin', label: t('web.iamList.typeBuiltin'), match: (row) => row.builtin },
				{ value: 'managed', label: t('web.iamList.typeManaged'), match: (row) => !row.builtin }
			]
		},
		{
			id: 'usedAs',
			label: t('web.iamList.filterUsedAs'),
			options: [
				{ value: 'any', label: t('web.iamList.anyUse') },
				{ value: 'used', label: t('web.iamList.usedAsPermissionsAny'), match: (row) => attachedCount(row) > 0 },
				{ value: 'unused', label: t('web.iamList.usedAsNone'), match: (row) => attachedCount(row) === 0 }
			]
		}
	]);

	function sortValue(row: PolicyRow, col: string): string | number | null {
		if (col === 'type') {
			return row.builtin ? 0 : 1;
		}

		if (col === 'usedAs') {
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
</script>

<svelte:head><title>{t('web.iamList.policiesTitle')} | Luna Console</title></svelte:head>

<PageHeader
	title={t('web.iamList.policiesTitle')}
	count={policies.length}
	description={t('web.iamList.policiesDescription')}
	info
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="iam-policies" />
		<Dropdown label={t('web.common.actions')} disabled={!picked} menu={headerMenu} />
		<Btn
			icon="trash"
			disabled={!!deleteReason}
			title={deleteReason || undefined}
			onclick={() => picked && askDelete(picked)}
		>
			{t('web.common.delete')}
		</Btn>
		<Btn
			variant="primary"
			icon="plus"
			href="/console/iam/policies/new"
			disabled={!!denied('iam:CreatePolicy')}
			title={denied('iam:CreatePolicy') || undefined}
		>
			{t('web.iamList.createPolicy')}
		</Btn>
	{/snippet}
</PageHeader>

<Panel flush>
	<ResourceTable
		tableId="iam-policies"
		loading={!loaded}
		initialSearch={page.url.searchParams.get('q') ?? ''}
		{columns}
		{filters}
		rows={policies}
		getId={(row) => row.name}
		searchValue={(row) => `${row.name} ${row.description}`}
		searchPlaceholder={t('web.iamList.searchPolicies')}
		selectable="single"
		bind:selected
		rowActions={(row) => policyActions(row)}
		rowLabel={(row) => row.name}
		resourceId={(row) => resourceId('policy', row.name)}
		noun={t('web.iam.policyNoun')}
		{sortValue}
		emptyTitle={t('web.iam.noPoliciesTitle')}
		emptyText={t('web.iam.noPoliciesText')}
	>
		{#snippet cell(row, col)}
			{#if col === 'name'}
				<span class="pname">
					<Icon
						name={POLICY_KIND_ICONS[policyKind(row)]}
						size="0.875rem"
						style={row.builtin ? 'solid' : 'regular'}
					/>
					<a href={policyHref(row.name)}>{row.name}</a>
				</span>
			{:else if col === 'type'}
				{policyKindLabel(policyKind(row))}
			{:else if col === 'usedAs'}
				<span class:dim={attachedCount(row) === 0}>{usedAsLabel(row)}</span>
			{:else if col === 'description'}
				<span class="dim text">{row.description || '–'}</span>
			{:else if col === 'created'}
				<span class="dim">{row.createdAt ? fmtDateTime(row.createdAt) : '–'}</span>
			{:else if col === 'updated'}
				<span class="dim">{row.updatedAt ? fmtDateTime(row.updatedAt) : '–'}</span>
			{/if}
		{/snippet}

		{#snippet expanded(row)}
			<PolicyYamlPreview yaml={row.yaml} />
		{/snippet}
	</ResourceTable>
</Panel>

<ConfirmModal
	bind:open={deleteOpen}
	title={t('web.iam.deletePolicyTitle', { count: 1 })}
	lead={t('web.iam.deletePolicyLead', { names: deleteRow?.name ?? '' })}
	notes={[t('web.iam.deletePolicyNote')]}
	confirmLabel={t('web.common.delete')}
	onconfirm={() => void deleteConfirmed()}
/>

<style lang="scss">
	.pname {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--text-secondary);
	}

	.text {
		@include ellipsis;

		display: block;
	}
</style>
