<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, put } from '$lib/api';
	import { fmtDateTime } from '$lib/format';
	import { Authz } from '$lib/authz.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import { RESOURCE_TYPE_ICONS, resourceHref, resourceTypeLabel, tagText, vocabularyOf } from '$lib/resourcemeta.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Select from '$lib/components/Select.svelte';
	import MultiSelect from '$lib/components/MultiSelect.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import OwnerCell from '$lib/components/OwnerCell.svelte';
	import TagChips from '$lib/components/TagChips.svelte';
	import TagEditor from '$lib/components/TagEditor.svelte';
	import WizardModal from '$lib/components/WizardModal.svelte';
	import type { WizardStep } from '$lib/components/wizardmodal';
	import {
		applyBulkRows,
		blankBulkRow,
		bulkRows,
		changesOf,
		diffIsEmpty,
		diffTags,
		draftFaults,
		type BulkTagRow,
		type TagChange,
		type TagDiff
	} from '$lib/components/tageditor';
	import type { Column } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { IAM_RESOURCE_TYPES } from '$shared/iam/actions';
	import { MAX_TAGS } from '$shared/iam/resources';
	import { withCopyResourceId } from '$lib/resourceid';
	import type { ResourceView } from '$core/resources';

	/**
	 * The console's Tag Editor, after AWS Resource Groups': find resources by
	 * type, tag and creator, read who owns what, export the result, and edit the
	 * tags of many resources at once through a two-step editor that shows every
	 * change per resource before applying it.
	 */

	/** The most resources one bulk edit takes, as AWS's Tag Editor caps it. */
	const MAX_BULK = 500;

	interface TagFilter {
		key: string;
		/** empty: any value */
		value: string;
	}

	interface Criteria {
		types: string[];
		tags: TagFilter[];
		createdBy: string;
	}

	/** One resource's line in the bulk editor's review. */
	interface PlanRow {
		id: string;
		view: ResourceView;
		diff: TagDiff;
		changes: TagChange[];
		/** why this resource will not be changed, when it will not */
		refused: string;
		outcome: 'pending' | 'ok' | 'failed' | 'refused' | 'unchanged';
		message: string;
	}

	let all = $state<ResourceView[]>([]);
	let loading = $state(false);
	let loaded = $state(false);
	let lastUpdated = $state<number | null>(null);
	let selected = $state<Set<string>>(new Set());

	// the form; what the table shows is the last *searched* criteria
	let types = $state<string[]>(page.url.searchParams.getAll('type'));
	let tagFilters = $state<TagFilter[]>(initialTagFilters());
	let createdBy = $state(page.url.searchParams.get('createdBy') ?? '');
	let filterKey = $state('');
	let filterValue = $state('');
	let applied = $state<Criteria>({ types: [], tags: [], createdBy: '' });

	// the bulk editor
	let bulkOpen = $state(false);
	let bulkStep = $state(0);
	let bulkTargets = $state<ResourceView[]>([]);
	let bulkEdit = $state<BulkTagRow[]>([]);
	let bulkRemoved = $state<string[]>([]);
	let bulkBusy = $state(false);
	let bulkApplied = $state(false);
	let plan = $state<PlanRow[]>([]);

	function initialTagFilters(): TagFilter[] {
		return page.url.searchParams.getAll('tag').map((entry) => {
			const eq = entry.indexOf('=');

			return eq < 0
				? { key: entry, value: '' }
				: { key: entry.slice(0, eq), value: entry.slice(eq + 1) };
		});
	}

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const data = await api<{ resources: ResourceView[] }>('/resources');

			all = data.resources;
			lastUpdated = Date.now();

			// a resource that disappeared cannot stay selected
			const known = new Set(all.map((row) => row.id));

			selected = new Set([...selected].filter((id) => known.has(id)));
		} catch (err) {
			Notify.error(t('web.resources.loadFailed'), { detail: (err as Error).message });
		} finally {
			loading = false;
			loaded = true;
		}
	}

	onMount(() => {
		applied = snapshot();
		void refresh();
	});

	function snapshot(): Criteria {
		return {
			types: [...types],
			tags: tagFilters.map((filter) => ({ ...filter })),
			createdBy
		};
	}

	async function search(): Promise<void> {
		applied = snapshot();
		selected = new Set();
		await refresh();
	}

	function clearCriteria(): void {
		types = [];
		tagFilters = [];
		createdBy = '';
		filterKey = '';
		filterValue = '';
	}

	function matchesCriteria(row: ResourceView, criteria: Criteria): boolean {
		if (criteria.types.length > 0 && !criteria.types.includes(row.type)) {
			return false;
		}

		if (criteria.createdBy !== '' && (row.createdBy ?? '') !== criteria.createdBy) {
			return false;
		}

		for (const filter of criteria.tags) {
			if (!(filter.key in row.tags)) {
				return false;
			}

			if (filter.value !== '' && row.tags[filter.key] !== filter.value) {
				return false;
			}
		}

		return true;
	}

	const results = $derived(all.filter((row) => matchesCriteria(row, applied)));
	const picked = $derived(results.filter((row) => selected.has(row.id)));
	const vocabulary = $derived(vocabularyOf(all));
	const tagKeys = $derived(Object.keys(vocabulary));

	const creators = $derived(
		[...new Set(all.map((row) => row.createdBy).filter((name): name is string => !!name))].sort((a, b) =>
			a.localeCompare(b)
		)
	);

	const typeOptions = $derived(
		IAM_RESOURCE_TYPES.map((type) => ({ value: type, label: resourceTypeLabel(type) }))
	);

	const creatorOptions = $derived([
		{ value: '', label: t('web.tagSearch.anyCreator') },
		...creators.map((name) => ({ value: name, label: name }))
	]);

	const keyOptions = $derived([
		{ value: '', label: t('web.tagSearch.pickKey') },
		...tagKeys.map((key) => ({ value: key, label: key }))
	]);

	const valueOptions = $derived([
		{ value: '', label: t('web.tagSearch.anyValue') },
		...(vocabulary[filterKey] ?? []).map((value) => ({
			value,
			label: value === '' ? t('web.tagSearch.emptyValue') : value
		}))
	]);

	function addTagFilter(): void {
		if (filterKey === '') {
			return;
		}

		const next = tagFilters.filter((filter) => filter.key !== filterKey);

		tagFilters = [...next, { key: filterKey, value: filterValue }];
		filterKey = '';
		filterValue = '';
	}

	function removeTagFilter(key: string): void {
		tagFilters = tagFilters.filter((filter) => filter.key !== key);
	}

	function canTag(row: ResourceView): boolean {
		return Authz.can('tag:Tag', row.id, { tags: row.tags, createdBy: row.createdBy });
	}

	function canUntag(row: ResourceView): boolean {
		return Authz.can('tag:Untag', row.id, { tags: row.tags, createdBy: row.createdBy });
	}

	// -- bulk editor -----------------------------------------------------------------

	/** Why the selection cannot go to the bulk editor, or empty when it can. */
	function bulkBlocked(targets: ResourceView[]): string {
		if (targets.length === 0) {
			return t('web.tagSearch.pickSome');
		}

		if (targets.length > MAX_BULK) {
			return t('web.tagSearch.tooMany', { max: MAX_BULK });
		}

		if (!targets.some((row) => canTag(row) || canUntag(row))) {
			return t('web.resources.noneTaggable');
		}

		return '';
	}

	function openBulk(targets: ResourceView[]): void {
		if (bulkBlocked(targets)) {
			return;
		}

		bulkTargets = targets;
		bulkEdit = bulkRows(targets);
		bulkRemoved = [];
		bulkStep = 0;
		bulkApplied = false;
		plan = [];
		bulkOpen = true;
	}

	function onBulkRemove(row: BulkTagRow): void {
		if (row.original !== null) {
			bulkRemoved = [...bulkRemoved, row.original];
		}
	}

	const bulkFaults = $derived(
		draftFaults(bulkEdit, (uid) => {
			const row = bulkEdit.find((entry) => entry.uid === uid);

			return !!row && row.mixed && !row.edited;
		})
	);

	function planFor(view: ResourceView): PlanRow {
		const after = applyBulkRows(view.tags, bulkEdit, bulkRemoved);
		const diff = diffTags(view.tags, after);
		const changes = changesOf(view.tags, diff);
		let refused = '';

		if (Object.keys(diff.set).length > 0 && !canTag(view)) {
			refused = t('web.resourceMeta.mayNotTag');
		} else if (diff.remove.length > 0 && !canUntag(view)) {
			refused = t('web.resourceMeta.mayNotUntag');
		} else if (Object.keys(after).length > MAX_TAGS) {
			refused = t('web.tagEditor.tooMany', { max: MAX_TAGS });
		}

		return {
			id: view.id,
			view,
			diff,
			changes,
			refused,
			outcome: diffIsEmpty(diff)
				? 'unchanged'
				: refused
					? 'refused'
					: 'pending',
			message: refused
		};
	}

	const draftPlan = $derived(bulkOpen && !bulkApplied ? bulkTargets.map(planFor) : []);
	const changing = $derived(draftPlan.filter((row) => row.outcome === 'pending').length);

	const bulkSteps: WizardStep[] = $derived([
		{
			id: 'edit',
			label: t('web.tagBulk.editStep'),
			description: t('web.tagBulk.editStepHint', { count: bulkTargets.length }),
			blocked: Object.keys(bulkFaults).length > 0
				? t('web.tagBulk.fixFaults')
				: changing === 0
					? t('web.tagBulk.nothingToApply')
					: undefined
		},
		{
			id: 'review',
			label: t('web.tagBulk.reviewStep'),
			description: bulkApplied
				? t('web.tagBulk.appliedHint')
				: t('web.tagBulk.reviewStepHint', { count: changing })
		}
	]);

	const reviewRows = $derived(bulkApplied ? plan : draftPlan);

	async function applyBulk(): Promise<void> {
		if (bulkApplied) {
			bulkOpen = false;

			return;
		}

		const rows = draftPlan.map((row) => ({ ...row }));

		bulkBusy = true;

		for (const row of rows) {
			if (row.outcome !== 'pending') {
				continue;
			}

			try {
				if (Object.keys(row.diff.set).length > 0) {
					await put('/resources/tags', { id: row.id, tags: row.diff.set });
				}

				if (row.diff.remove.length > 0) {
					await api('/resources/tags', {
						method: 'DELETE',
						body: JSON.stringify({ id: row.id, keys: row.diff.remove })
					});
				}

				row.outcome = 'ok';
			} catch (err) {
				row.outcome = 'failed';
				row.message = (err as Error).message;
			}
		}

		plan = rows;
		bulkApplied = true;
		bulkBusy = false;

		const done = rows.filter((row) => row.outcome === 'ok').length;
		const failed = rows.filter((row) => row.outcome === 'failed');
		const refused = rows.filter((row) => row.outcome === 'refused');

		if (failed.length === 0 && refused.length === 0) {
			Notify.success(t('web.tagBulk.done', { count: done }));
		} else {
			Notify.warning(t('web.tagBulk.partial', { done, failed: failed.length, refused: refused.length }), {
				detail: [...failed, ...refused].map((row) => `${row.id}: ${row.message}`).join('\n')
			});
		}

		await refresh();
	}

	// -- export ----------------------------------------------------------------------

	function csvField(value: string): string {
		return /[",\r\n]/.test(value)
			? `"${value.replace(/"/g, '""')}"`
			: value;
	}

	function isoOf(stamp: number | null): string {
		return stamp ? new Date(stamp).toISOString() : '';
	}

	/** The search results as CSV, every column including one per tag key. */
	function exportCsv(): void {
		const header = [
			t('web.resources.colId'),
			t('web.resources.colType'),
			t('web.resources.colName'),
			t('web.resources.colCreatedBy'),
			t('web.resources.colCreated'),
			t('web.resources.colUpdatedBy'),
			t('web.resources.colUpdated'),
			t('web.tagSearch.colTagCount'),
			t('web.resources.colTags'),
			...tagKeys.map((key) => t('web.tagSearch.colTag', { key }))
		];

		const lines = results.map((row) => [
			row.id,
			row.type,
			row.name,
			row.createdBy ?? '',
			isoOf(row.createdAt),
			row.updatedBy ?? '',
			isoOf(row.updatedAt),
			String(Object.keys(row.tags).length),
			tagText(row.tags),
			...tagKeys.map((key) => row.tags[key] ?? '')
		]);

		const text = [header, ...lines].map((line) => line.map(csvField).join(',')).join('\r\n');
		const blob = new Blob([`﻿${text}\r\n`], { type: 'text/csv;charset=utf-8' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');

		link.href = url;
		link.download = `luna-resources-${new Date().toISOString().slice(0, 10)}.csv`;
		link.click();
		URL.revokeObjectURL(url);
	}

	// -- table -----------------------------------------------------------------------

	/** The verbs over a set of rows: the Actions dropdown and each row's menu share them. */
	function resourceActions(targets: ResourceView[]): ContextMenuItem[] {
		const one = targets.length === 1 ? targets[0] : undefined;
		const href = one ? resourceHref(one.type, one.name) : null;
		const blocked = bulkBlocked(targets);

		return [
			{
				label: t('web.resources.open'),
				icon: 'arrowUpRightFromSquare',
				disabled: !href,
				hint: !one
					? t('web.resources.pickOne')
					: href
						? undefined
						: t('web.resources.noScreen'),
				action: () => goto(href!)
			},
			{
				label: t('web.tagSearch.manageSelected', { count: targets.length }),
				icon: 'tags',
				disabled: !!blocked,
				hint: blocked || undefined,
				action: () => openBulk(targets)
			}
		];
	}

	function rowActions(row: ResourceView): ContextMenuItem[] {
		return resourceActions(selected.has(row.id) && picked.length > 1 ? picked : [row]);
	}

	const columns: Column[] = $derived([
		{ id: 'name', label: t('web.tagSearch.colIdentifier'), sortable: true, width: 240 },
		{ id: 'type', label: t('web.resources.colType'), sortable: true, width: 150 },
		{ id: 'createdBy', label: t('web.resources.colCreatedBy'), sortable: true, width: 140 },
		{ id: 'created', label: t('web.resources.colCreated'), sortable: true, width: 170 },
		{ id: 'tagCount', label: t('web.tagSearch.colTagCount'), sortable: true, width: 90, align: 'right' },
		{ id: 'tags', label: t('web.resources.colTags'), sortable: true },
		{ id: 'updatedBy', label: t('web.resources.colUpdatedBy'), sortable: true, width: 140, hidden: true },
		{ id: 'updated', label: t('web.resources.colUpdated'), sortable: true, width: 170, hidden: true },
		...tagKeys.map((key) => ({
			id: `tag:${key}`,
			label: t('web.tagSearch.colTag', { key }),
			sortable: true,
			width: 150,
			hidden: true
		}))
	]);

	function sortValue(row: ResourceView, col: string): string | number | null {
		if (col.startsWith('tag:')) {
			return row.tags[col.slice(4)] ?? '';
		}

		switch (col) {
			case 'name':
				return row.name;
			case 'type':
				return resourceTypeLabel(row.type);
			case 'created':
				return row.createdAt ?? 0;
			case 'updated':
				return row.updatedAt ?? 0;
			case 'createdBy':
				return row.createdBy ?? '';
			case 'updatedBy':
				return row.updatedBy ?? '';
			case 'tagCount':
				return Object.keys(row.tags).length;
			case 'tags':
				return tagText(row.tags);
			default:
				return null;
		}
	}

	const reviewColumns: Column[] = $derived([
		{ id: 'resource', label: t('web.tagSearch.colIdentifier'), width: 220 },
		{ id: 'changes', label: t('web.tagBulk.colChanges') },
		{ id: 'status', label: t('web.tagBulk.colStatus'), width: 170 }
	]);

	const OUTCOME_STATE: Record<PlanRow['outcome'], string> = {
		pending: 'info',
		ok: 'ok',
		failed: 'failed',
		refused: 'warning',
		unchanged: 'stopped'
	};
</script>

<svelte:head><title>{t('web.tagSearch.title')} | Luna Console</title></svelte:head>

<PageHeader title={t('web.tagSearch.title')} description={t('web.tagSearch.pageDescription')} info>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="console-resources" />
		<Dropdown label={t('web.common.actions')} disabled={picked.length === 0} menu={withCopyResourceId(resourceActions(picked), picked.map((row) => row.id))} />
		<Btn icon="fileExport" disabled={results.length === 0} title={results.length === 0 ? t('web.tagSearch.nothingToExport') : undefined} onclick={exportCsv}>
			{t('web.tagSearch.exportCsv')}
		</Btn>
		<Btn
			variant="primary"
			icon="tags"
			disabled={!!bulkBlocked(picked)}
			title={bulkBlocked(picked) || undefined}
			onclick={() => openBulk(picked)}
		>
			{t('web.tagSearch.manageSelected', { count: picked.length })}
		</Btn>
	{/snippet}
</PageHeader>

<Panel title={t('web.tagSearch.findTitle')} description={t('web.tagSearch.findHint')}>
	<div class="criteria">
		<div class="crow">
			<MultiSelect
				label={t('web.tagSearch.resourceTypes')}
				bind:value={types}
				options={typeOptions}
				width="20rem"
				placeholder={t('web.tagSearch.allTypes')}
			/>
			<Select label={t('web.resources.colCreatedBy')} bind:value={createdBy} options={creatorOptions} width="14rem" />
		</div>

		<div class="crow">
			<Select label={t('web.tagSearch.tagKey')} bind:value={filterKey} options={keyOptions} width="14rem" searchable />
			<Select
				label={t('web.tagSearch.tagValue')}
				bind:value={filterValue}
				options={valueOptions}
				width="14rem"
				disabled={filterKey === ''}
				searchable
			/>
			<Btn icon="plus" disabled={filterKey === ''} title={filterKey === '' ? t('web.tagSearch.pickKeyFirst') : undefined} onclick={addTagFilter}>
				{t('web.common.add')}
			</Btn>
		</div>

		{#if tagFilters.length > 0}
			<div class="filters">
				{#each tagFilters as filter (filter.key)}
					<span class="chip mono">
						<span class="k">{filter.key}</span>
						<span class="v">= {filter.value === '' ? t('web.tagSearch.anyValueShort') : filter.value}</span>
						<button
							type="button"
							class="x"
							title={t('web.tagSearch.removeFilter', { key: filter.key })}
							aria-label={t('web.tagSearch.removeFilter', { key: filter.key })}
							onclick={() => removeTagFilter(filter.key)}
						>
							<Icon name="close" size="0.625rem" style="solid" />
						</button>
					</span>
				{/each}
			</div>
		{/if}

		<div class="crow">
			<Btn variant="primary" icon="magnifyingGlass" loading={loading} onclick={() => void search()}>
				{t('web.tagSearch.search')}
			</Btn>
			<Btn onclick={clearCriteria}>{t('web.tagSearch.clear')}</Btn>
		</div>
	</div>
</Panel>

<div class="gap"></div>

<Panel title={t('web.tagSearch.resultsTitle')} count={results.length} flush>
	<ResourceTable
		tableId="resources"
		loading={!loaded}
		initialSearch={page.url.searchParams.get('q') ?? ''}
		{columns}
		rows={results}
		getId={(row) => row.id}
		searchValue={(row) => `${row.name} ${row.id} ${tagText(row.tags)} ${row.createdBy ?? ''} ${row.updatedBy ?? ''}`}
		searchPlaceholder={t('web.resources.searchPlaceholder')}
		selectable="multi"
		bind:selected
		{rowActions}
		rowLabel={(row) => row.name}
		resourceId={(row) => row.id}
		{sortValue}
		defaultSort={{ col: 'type' }}
		noun={t('web.resources.noun')}
		emptyTitle={t('web.tagSearch.emptyTitle')}
		emptyText={t('web.tagSearch.emptyText')}
	>
		{#snippet cell(row, col)}
			{#if col.startsWith('tag:')}
				{@const value = row.tags[col.slice(4)]}
				{#if value === undefined}
					<span class="dim">–</span>
				{:else}
					<span class="mono">{value}</span>
				{/if}
			{:else if col === 'type'}
				<span class="type"><Icon name={RESOURCE_TYPE_ICONS[row.type]} size="0.875rem" style="solid" /> {resourceTypeLabel(row.type)}</span>
			{:else if col === 'name'}
				{@const href = resourceHref(row.type, row.name)}
				{#if href}
					<a {href}><b>{row.name}</b></a>
				{:else}
					<b>{row.name}</b>
				{/if}
			{:else if col === 'tagCount'}
				{Object.keys(row.tags).length}
			{:else if col === 'tags'}
				<TagChips tags={row.tags} />
			{:else if col === 'createdBy'}
				<OwnerCell name={row.createdBy} />
			{:else if col === 'created'}
				<span class="dim">{row.createdAt ? fmtDateTime(row.createdAt) : '–'}</span>
			{:else if col === 'updated'}
				<span class="dim">{row.updatedAt ? fmtDateTime(row.updatedAt) : '–'}</span>
			{:else if col === 'updatedBy'}
				<OwnerCell name={row.updatedBy} />
			{/if}
		{/snippet}
	</ResourceTable>
</Panel>

<WizardModal
	bind:open={bulkOpen}
	bind:step={bulkStep}
	title={t('web.tagBulk.title', { count: bulkTargets.length })}
	steps={bulkSteps}
	confirmLabel={bulkApplied ? t('web.common.close') : t('web.tagBulk.apply', { count: changing })}
	busy={bulkBusy}
	onconfirm={applyBulk}
>
	{#snippet children(current)}
		{#if current.id === 'edit'}
			<TagEditor
				bind:rows={bulkEdit}
				faults={bulkFaults}
				newRow={blankBulkRow}
				onremove={onBulkRemove}
				disabled={bulkBusy}
			/>
		{:else}
			<DataTable
				columns={reviewColumns}
				rows={reviewRows}
				getId={(row: PlanRow) => row.id}
				emptyTitle={t('web.tagBulk.noResources')}
			>
				{#snippet cell(row, col)}
					{#if col === 'resource'}
						<span class="mono">{row.view.name}</span>
						<span class="dim small">{resourceTypeLabel(row.view.type)}</span>
					{:else if col === 'changes'}
						{#if row.changes.length === 0}
							<span class="dim">{t('web.tagBulk.noChange')}</span>
						{:else}
							<ul class="changes mono">
								{#each row.changes as change (change.key)}
									<li class={change.kind}>
										{#if change.kind === 'add'}
											{t('web.tagBulk.added', { key: change.key, value: change.to ?? '' })}
										{:else if change.kind === 'change'}
											{t('web.tagBulk.changed', { key: change.key, from: change.from ?? '', to: change.to ?? '' })}
										{:else}
											{t('web.tagBulk.removed', { key: change.key })}
										{/if}
									</li>
								{/each}
							</ul>
						{/if}
					{:else if col === 'status'}
						<StatusBadge
							state={OUTCOME_STATE[row.outcome]}
							label={t(`web.tagBulk.outcome.${row.outcome}`)}
							detail={row.message || undefined}
						/>
					{/if}
				{/snippet}
			</DataTable>
		{/if}
	{/snippet}
</WizardModal>

<style lang="scss">
	.type {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		white-space: nowrap;
	}

	.criteria {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.crow {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		align-items: center;
	}

	.filters {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		max-width: 100%;
		font-size: 0.75rem;
		line-height: 1.25rem;
		border: 0.1rem solid var(--border-divider);
		border-radius: 0.75rem;
		padding: 0.125rem 0.5rem;

		.k {
			@include ellipsis;

			color: var(--text-heading);
		}

		.v {
			@include ellipsis;

			color: var(--text-secondary);
		}
	}

	.x {
		@include bare-button;

		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1rem;
		height: 1rem;
		margin-right: -0.25rem;
		border-radius: 50%;
		color: var(--text-secondary);
		cursor: pointer;

		&:hover {
			color: var(--text-heading);
			background: var(--bg-hover);
		}
	}

	.gap {
		height: 1.25rem;
	}

	.small {
		margin-left: 0.375rem;
		font-size: 0.75rem;
	}

	.changes {
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: 0.75rem;

		.add {
			color: var(--success);
		}

		.change {
			color: var(--warning);
		}

		.remove {
			color: var(--error);
		}
	}
</style>
