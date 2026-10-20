<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import ResourceTable from './ResourceTable.svelte';
	import Icon from './Icon.svelte';
	import PolicyYamlPreview from './PolicyYamlPreview.svelte';
	import type { Column, TableFilterGroup } from './table';
	import {
		POLICY_KIND_ICONS,
		policyHref,
		policyKind,
		policyKindLabel,
		usedAsLabel,
		attachedCount,
		type PolicyRow
	} from '$lib/iam';

	/**
	 * A table to pick policies from, as AWS's "Attach permissions policies":
	 * searchable, filtered by type, each row unfolding into its document. Rows
	 * already attached to the target are locked rather than hidden, so the
	 * picker still shows the whole catalog.
	 */
	let {
		policies,
		selected = $bindable(new Set<string>()),
		locked,
		tableId,
		maxHeight = '26rem'
	}: {
		policies: PolicyRow[];
		selected?: Set<string>;
		/** policies the target already holds */
		locked?: (policy: PolicyRow) => boolean;
		tableId: string;
		maxHeight?: string;
	} = $props();

	const columns: Column[] = $derived([
		{ id: 'name', label: t('web.iamList.colPolicyName'), sortable: true, width: 260 },
		{ id: 'type', label: t('web.iamList.colType'), sortable: true, width: 160 },
		{ id: 'usedAs', label: t('web.iamList.colUsedAs'), sortable: true, width: 190 },
		{ id: 'description', label: t('web.iamList.colDescription') }
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
		}
	]);
</script>

<ResourceTable
	{tableId}
	{columns}
	{filters}
	rows={policies}
	getId={(row) => row.name}
	searchValue={(row) => `${row.name} ${row.description}`}
	searchPlaceholder={t('web.iamList.searchPolicies')}
	searchWidth="18rem"
	selectable="multi"
	bind:selected
	rowLocked={locked}
	paging
	pageSize={10}
	{maxHeight}
	noun={t('web.iam.policyNoun')}
	sortValue={(row, col) =>
		col === 'type'
			? (row.builtin ? 0 : 1)
			: col === 'usedAs'
				? attachedCount(row)
				: null}
	emptyTitle={t('web.iam.noPoliciesTitle')}
>
	{#snippet cell(row, col)}
		{#if col === 'name'}
			<span class="pname">
				<Icon name={POLICY_KIND_ICONS[policyKind(row)]} size="0.875rem" style={row.builtin ? 'solid' : 'regular'} />
				<a href={policyHref(row.name)} target="_blank" rel="noopener">{row.name}</a>
			</span>
		{:else if col === 'type'}
			{policyKindLabel(policyKind(row))}
		{:else if col === 'usedAs'}
			<span class:dim={attachedCount(row) === 0}>{usedAsLabel(row)}</span>
		{:else if col === 'description'}
			<span class="dim">{row.description || '–'}</span>
		{/if}
	{/snippet}

	{#snippet expanded(row)}
		<PolicyYamlPreview yaml={row.yaml} />
	{/snippet}
</ResourceTable>

<style lang="scss">
	.pname {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--text-secondary);
	}
</style>
