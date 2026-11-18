<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount, untrack } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, put } from '$lib/api';
	import { fmtDateTime } from '$lib/format';
	import { Authz } from '$lib/authz.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import { tooltip } from '$lib/tooltip.svelte';
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
	import TagsModal from '$lib/components/TagsModal.svelte';
	import WizardModal from '$lib/components/WizardModal.svelte';
	import SegmentedControl from '$lib/components/SegmentedControl.svelte';
	import ProgressBar from '$lib/components/ProgressBar.svelte';
	import DateTime from '$lib/components/DateTime.svelte';
	import type { WizardStep } from '$lib/components/wizardmodal';
	import type { SegmentOption } from '$lib/components/segmented';
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
	import { menuGroups, type ContextMenuItem } from '$lib/components/contextmenu';
	import { IAM_RESOURCE_TYPES } from '$shared/iam/actions';
	import { MAX_TAGS } from '$shared/iam/resources';
	import { withCopyResourceId } from '$lib/resourceid';
	import type { ResourceView } from '$core/resources';

	/**
	 * The console's Tag Editor, after AWS Resource Groups': find resources by
	 * type, creator and tag (the filters apply as they change and live in the
	 * address), read who owns what, export the result, and edit tags: one
	 * resource in the Manage tags popup, several through a two-step editor that
	 * shows every change per resource before applying it.
	 */

	/** The most resources one bulk edit takes, as AWS's Tag Editor caps it. */
	const MAX_BULK = 500;

	interface TagFilter {
		key: string;
		/** 'any': carries the key · 'missing': does not · 'value': carries it with `value` */
		mode: 'any' | 'missing' | 'value';
		value: string;
	}

	type Outcome = 'pending' | 'ok' | 'failed' | 'refused' | 'unchanged';

	/** One resource's line in the bulk editor's review. */
	interface PlanRow {
		id: string;
		view: ResourceView;
		diff: TagDiff;
		changes: TagChange[];
		/** why this resource will not be changed, when it will not */
		refused: string;
		outcome: Outcome;
		message: string;
	}

	/** The review's order: what needs a look first. */
	const OUTCOME_ORDER: Outcome[] = ['failed', 'refused', 'pending', 'ok', 'unchanged'];

	let all = $state<ResourceView[]>([]);
	let loading = $state(false);
	let loaded = $state(false);
	let lastUpdated = $state<number | null>(null);
	let selected = $state<Set<string>>(new Set());

	// the filters, applied as they change and written back to the address
	let types = $state<string[]>(page.url.searchParams.getAll('type'));
	let createdBy = $state(page.url.searchParams.get('createdBy') ?? '');
	let tagFilters = $state<TagFilter[]>(initialTagFilters());
	let untagged = $state(page.url.searchParams.get('untagged') === '1');
	// the tag filter's Select only adds; it never holds a choice
	let tagPick = $state('');

	// the popup for one resource
	let tagsOpen = $state(false);
	let tagsFor = $state<ResourceView | null>(null);

	// the bulk editor
	let bulkOpen = $state(false);
	let bulkStep = $state(0);
	let bulkTargets = $state<ResourceView[]>([]);
	let bulkEdit = $state<BulkTagRow[]>([]);
	let bulkBusy = $state(false);
	let bulkApplied = $state(false);
	let plan = $state<PlanRow[]>([]);
	let applyDone = $state(0);
	let applyTotal = $state(0);
	// null: the review's default filter, which follows the apply
	let reviewFilter = $state<string | null>(null);

	/** One tag filter as the address writes it: `key`, `key=value` or `!key`. */
	function encodeTagFilter(filter: TagFilter): string {
		if (filter.mode === 'missing') {
			return `!${filter.key}`;
		}

		return filter.mode === 'value'
			? `${filter.key}=${filter.value}`
			: filter.key;
	}

	/** The address's form back as a filter; `!` cannot start a tag key. */
	function decodeTagFilter(entry: string): TagFilter {
		if (entry.startsWith('!')) {
			return { key: entry.slice(1), mode: 'missing', value: '' };
		}

		const eq = entry.indexOf('=');

		return eq < 0
			? { key: entry, mode: 'any', value: '' }
			: { key: entry.slice(0, eq), mode: 'value', value: entry.slice(eq + 1) };
	}

	function initialTagFilters(): TagFilter[] {
		return page.url.searchParams.getAll('tag').map(decodeTagFilter);
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
		void refresh();
	});

	// the address holds the filters, so a filtered view can be linked and Back restores it
	$effect(() => {
		const params = new URLSearchParams(untrack(() => page.url.search));

		params.delete('type');
		params.delete('createdBy');
		params.delete('untagged');
		params.delete('tag');

		for (const type of types) {
			params.append('type', type);
		}

		if (createdBy !== '') {
			params.set('createdBy', createdBy);
		}

		if (untagged) {
			params.set('untagged', '1');
		}

		for (const filter of tagFilters) {
			params.append('tag', encodeTagFilter(filter));
		}

		const next = params.toString();
		const current = untrack(() => page.url.searchParams.toString());

		if (next === current) {
			return;
		}

		const path = untrack(() => page.url.pathname);
		const target = next === ''
			? path
			: `${path}?${next}`;

		void goto(target, { replaceState: true, keepFocus: true, noScroll: true });
	});

	function matchesTag(row: ResourceView, filter: TagFilter): boolean {
		const has = filter.key in row.tags;

		if (filter.mode === 'missing') {
			return !has;
		}

		if (filter.mode === 'any') {
			return has;
		}

		return has && row.tags[filter.key] === filter.value;
	}

	function matchesFilters(row: ResourceView): boolean {
		if (types.length > 0 && !types.includes(row.type)) {
			return false;
		}

		if (createdBy !== '' && (row.createdBy ?? '') !== createdBy) {
			return false;
		}

		if (untagged && Object.keys(row.tags).length > 0) {
			return false;
		}

		return tagFilters.every((filter) => matchesTag(row, filter));
	}

	const results = $derived(all.filter(matchesFilters));
	const picked = $derived(results.filter((row) => selected.has(row.id)));
	const vocabulary = $derived(vocabularyOf(all));
	const tagKeys = $derived(Object.keys(vocabulary));
	const untaggedCount = $derived(all.filter((row) => Object.keys(row.tags).length === 0).length);
	const filtered = $derived(types.length > 0 || createdBy !== '' || tagFilters.length > 0 || untagged);

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

	function countMatching(filter: TagFilter): number {
		return all.filter((row) => matchesTag(row, filter)).length;
	}

	const tagOptions = $derived([
		{ value: '', label: t('web.tagSearch.tagFilterPick') },
		...tagKeys.flatMap((key) => {
			const any: TagFilter = { key, mode: 'any', value: '' };
			const missing: TagFilter = { key, mode: 'missing', value: '' };
			const values = (vocabulary[key] ?? []).map((value) => {
				const filter: TagFilter = { key, mode: 'value', value };
				const count = countMatching(filter);
				const label = value === ''
					? t('web.tagSearch.optEmpty', { key, count })
					: t('web.tagSearch.optValue', { key, value, count });

				return { value: encodeTagFilter(filter), label };
			});

			return [
				{ value: encodeTagFilter(any), label: t('web.tagSearch.optAny', { key, count: countMatching(any) }) },
				{ value: encodeTagFilter(missing), label: t('web.tagSearch.optMissing', { key, count: countMatching(missing) }) },
				...values
			];
		})
	]);

	function addTagFilter(filter: TagFilter): void {
		const next = tagFilters.filter((entry) => entry.key !== filter.key);

		tagFilters = [...next, filter];
		untagged = false;
	}

	function pickTagFilter(value: string): void {
		tagPick = '';

		if (value === '') {
			return;
		}

		addTagFilter(decodeTagFilter(value));
	}

	function removeTagFilter(key: string): void {
		tagFilters = tagFilters.filter((filter) => filter.key !== key);
	}

	function toggleUntagged(): void {
		untagged = !untagged;

		// a resource without tags matches no tag filter; the two contradict
		if (untagged) {
			tagFilters = [];
		}
	}

	function clearFilters(): void {
		types = [];
		createdBy = '';
		tagFilters = [];
		untagged = false;
	}

	function chipText(filter: TagFilter): string {
		if (filter.mode === 'any') {
			return t('web.tagSearch.chipAny', { key: filter.key });
		}

		if (filter.mode === 'missing') {
			return t('web.tagSearch.chipMissing', { key: filter.key });
		}

		return filter.value === ''
			? t('web.tagSearch.chipEmpty', { key: filter.key })
			: t('web.tagSearch.chipValue', { key: filter.key, value: filter.value });
	}

	function canTag(row: ResourceView): boolean {
		return Authz.can('tag:Tag', row.id, { tags: row.tags, createdBy: row.createdBy });
	}

	function canUntag(row: ResourceView): boolean {
		return Authz.can('tag:Untag', row.id, { tags: row.tags, createdBy: row.createdBy });
	}

	// -- editing ---------------------------------------------------------------------

	/** Why the selection cannot be tagged, or empty when it can. */
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

	/** One resource opens the popup; two or more the bulk editor. */
	function openManage(targets: ResourceView[]): void {
		if (bulkBlocked(targets)) {
			return;
		}

		const one = targets.length === 1
			? targets[0]
			: undefined;

		if (one) {
			tagsFor = one;
			tagsOpen = true;

			return;
		}

		openBulk(targets);
	}

	function onTagsSaved(view: ResourceView | null): void {
		if (!view) {
			void refresh();

			return;
		}

		all = all.map((row) => (
			row.id === view.id
				? view
				: row
		));
	}

	function openBulk(targets: ResourceView[]): void {
		bulkTargets = targets;
		bulkEdit = bulkRows(targets);
		bulkStep = 0;
		bulkApplied = false;
		plan = [];
		applyDone = 0;
		applyTotal = 0;
		reviewFilter = null;
		bulkOpen = true;
	}

	const bulkFaults = $derived(
		draftFaults(bulkEdit, (uid) => {
			const row = bulkEdit.find((entry) => entry.uid === uid);

			return !!row && row.mixed && !row.edited;
		})
	);

	function shownValue(value: string): string {
		return value === ''
			? t('web.tagSearch.emptyValue')
			: value;
	}

	/** Where a key of the selection stands: which values it has on how many resources. */
	function spreadNote(row: BulkTagRow): { text: string; detail?: string } | null {
		if (row.original === null || row.spread.length === 0) {
			return null;
		}

		const total = bulkTargets.length;
		const carried = row.spread.filter((entry) => entry.value !== null);
		const have = carried.reduce((sum, entry) => sum + entry.count, 0);
		const only = carried.length === 1
			? carried[0]
			: undefined;

		if (only && have === total) {
			return null;
		}

		const detail = row.spread
			.map((entry) => t('web.tagBulk.spreadLine', {
				value: entry.value === null
					? t('web.tagBulk.spreadUnset')
					: shownValue(entry.value),
				count: entry.count
			}))
			.join('\n');

		const text = only
			? t('web.tagBulk.spreadSame', { value: shownValue(only.value ?? ''), have, total })
			: t('web.tagBulk.spreadMixed', { values: carried.length, have, total });

		return { text, detail };
	}

	function planFor(view: ResourceView): PlanRow {
		const after = applyBulkRows(view.tags, bulkEdit);
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
				? t('web.tagEditor.fixFaults')
				: changing === 0
					? t('web.tagBulk.nothingToApply')
					: undefined
		},
		{
			id: 'review',
			label: t('web.tagBulk.reviewStep'),
			description: bulkApplied && !bulkBusy
				? t('web.tagBulk.appliedHint')
				: t('web.tagBulk.reviewStepHint', {
					count: bulkApplied
						? applyTotal
						: changing
				})
		}
	]);

	const reviewRows = $derived(bulkApplied ? plan : draftPlan);

	const outcomeCounts = $derived.by(() => {
		const out: Record<Outcome, number> = { pending: 0, ok: 0, failed: 0, refused: 0, unchanged: 0 };

		for (const row of reviewRows) {
			out[row.outcome] += 1;
		}

		return out;
	});

	const reviewOptions: SegmentOption[] = $derived([
		{ id: 'all', label: t('web.tagEditor.showAll'), badge: reviewRows.length },
		...OUTCOME_ORDER
			.filter((outcome) => outcomeCounts[outcome] > 0)
			.map((outcome) => ({
				id: outcome,
				label: t(`web.tagBulk.outcome.${outcome}`),
				badge: outcomeCounts[outcome]
			}))
	]);

	const defaultReviewFilter = $derived.by(() => {
		if (!bulkApplied) {
			return outcomeCounts.pending > 0
				? 'pending'
				: 'all';
		}

		if (bulkBusy) {
			return 'all';
		}

		return outcomeCounts.failed > 0
			? 'failed'
			: 'all';
	});

	const activeReviewFilter = $derived.by(() => {
		const wanted = reviewFilter ?? defaultReviewFilter;

		return reviewOptions.some((option) => option.id === wanted)
			? wanted
			: 'all';
	});

	const shownReview = $derived(
		reviewRows
			.filter((row) => activeReviewFilter === 'all' || row.outcome === activeReviewFilter)
			.sort((a, b) => {
				const rank = OUTCOME_ORDER.indexOf(a.outcome) - OUTCOME_ORDER.indexOf(b.outcome);

				return rank !== 0
					? rank
					: a.view.name.localeCompare(b.view.name);
			})
	);

	async function applyBulk(): Promise<void> {
		if (bulkApplied) {
			bulkOpen = false;

			return;
		}

		// the table renders the plan from here on, each row's outcome landing as it returns
		plan = draftPlan.map((row) => ({ ...row }));
		applyTotal = plan.filter((row) => row.outcome === 'pending').length;
		applyDone = 0;
		reviewFilter = null;
		bulkApplied = true;
		bulkBusy = true;

		for (const row of plan) {
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

			applyDone += 1;
		}

		bulkBusy = false;

		const done = plan.filter((row) => row.outcome === 'ok').length;
		const failed = plan.filter((row) => row.outcome === 'failed');
		const refused = plan.filter((row) => row.outcome === 'refused');

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

	/** Rows as CSV, every column including one per tag key. */
	function exportCsv(rows: ResourceView[]): void {
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

		const lines = rows.map((row) => [
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

		return menuGroups(
			[
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
				}
			],
			[
				{
					label: one
						? t('web.resourceMeta.manage')
						: t('web.tagSearch.manageSelected', { count: targets.length }),
					icon: 'tags',
					disabled: !!blocked,
					hint: blocked || undefined,
					action: () => openManage(targets)
				},
				{
					label: t('web.tagSearch.exportSelected'),
					icon: 'fileExport',
					disabled: targets.length === 0,
					action: () => exportCsv(targets)
				}
			]
		);
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

	const OUTCOME_STATE: Record<Outcome, string> = {
		pending: 'info',
		ok: 'ok',
		failed: 'failed',
		refused: 'warning',
		unchanged: 'stopped'
	};

	const primaryBlocked = $derived(bulkBlocked(picked));
</script>

<svelte:head><title>{t('web.tagSearch.title')} | Luna Console</title></svelte:head>

{#snippet clearAction()}
	<Btn icon="close" onclick={clearFilters}>{t('web.tagSearch.clear')}</Btn>
{/snippet}

<PageHeader title={t('web.tagSearch.title')} description={t('web.tagSearch.pageDescription')} info={t('web.guide.resources')}>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="console-resources" />
		<Dropdown label={t('web.common.actions')} disabled={picked.length === 0} menu={withCopyResourceId(resourceActions(picked), picked.map((row) => row.id))} />
		<Btn icon="fileExport" disabled={results.length === 0} title={results.length === 0 ? t('web.tagSearch.nothingToExport') : undefined} onclick={() => exportCsv(results)}>
			{t('web.tagSearch.exportCsv')}
		</Btn>
		<Btn
			variant="primary"
			icon="tags"
			disabled={!!primaryBlocked}
			title={primaryBlocked || undefined}
			onclick={() => openManage(picked)}
		>
			{t('web.tagSearch.manageSelected', { count: picked.length })}
		</Btn>
	{/snippet}
</PageHeader>

<Panel
	title={t('web.tagSearch.resultsTitle')}
	count={filtered
		? t('web.tagSearch.countOf', { shown: results.length, total: all.length })
		: results.length}
	flush
>
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
		emptyTitle={all.length === 0
			? t('web.tagSearch.noneTitle')
			: t('web.tagSearch.emptyTitle')}
		emptyText={all.length === 0
			? t('web.tagSearch.noneText')
			: t('web.tagSearch.emptyText')}
		emptyAction={all.length > 0 && results.length === 0
			? clearAction
			: undefined}
	>
		{#snippet toolbar()}
			<MultiSelect
				label={t('web.tagSearch.resourceTypes')}
				bind:value={types}
				options={typeOptions}
				width="14rem"
				placeholder={t('web.tagSearch.allTypes')}
			/>
			<Select label={t('web.resources.colCreatedBy')} bind:value={createdBy} options={creatorOptions} width="12rem" />
			<Select
				label={t('web.tagSearch.tagFilter')}
				bind:value={tagPick}
				options={tagOptions}
				width="14rem"
				searchable
				onchange={pickTagFilter}
			/>
			<Btn pressed={untagged} onclick={toggleUntagged}>
				{t('web.tagSearch.untagged', { count: untaggedCount })}
			</Btn>

			{#if tagFilters.length > 0}
				<div class="filters">
					{#each tagFilters as filter (filter.key)}
						<span class="chip mono">
							<span class="k">{chipText(filter)}</span>
							<button
								type="button"
								class="x"
								aria-label={t('web.tagSearch.removeFilter', { key: filter.key })}
								use:tooltip={{ content: t('web.tagSearch.removeFilter', { key: filter.key }) }}
								onclick={() => removeTagFilter(filter.key)}
							>
								<Icon name="close" size="0.625rem" style="solid" />
							</button>
						</span>
					{/each}
					<Btn variant="link" onclick={clearFilters}>{t('web.tagSearch.clear')}</Btn>
				</div>
			{/if}
		{/snippet}

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
				<TagChips tags={row.tags} limit={4} onpick={(key, value) => addTagFilter({ key, mode: 'value', value })} />
			{:else if col === 'createdBy'}
				<OwnerCell name={row.createdBy} />
			{:else if col === 'created'}
				<span class="dim"><DateTime at={row.createdAt} text={row.createdAt ? fmtDateTime(row.createdAt) : undefined} /></span>
			{:else if col === 'updated'}
				<span class="dim"><DateTime at={row.updatedAt} text={row.updatedAt ? fmtDateTime(row.updatedAt) : undefined} /></span>
			{:else if col === 'updatedBy'}
				<OwnerCell name={row.updatedBy} />
			{/if}
		{/snippet}
	</ResourceTable>
</Panel>

{#if tagsFor}
	<TagsModal bind:open={tagsOpen} type={tagsFor.type} name={tagsFor.name} resource={tagsFor} onsaved={onTagsSaved} />
{/if}

<WizardModal
	bind:open={bulkOpen}
	bind:step={bulkStep}
	title={t('web.tagBulk.title', { count: bulkTargets.length })}
	steps={bulkSteps}
	confirmLabel={bulkApplied && !bulkBusy
		? t('web.common.close')
		: t('web.tagBulk.apply', {
			count: bulkApplied
				? applyTotal
				: changing
		})}
	busy={bulkBusy}
	onconfirm={applyBulk}
>
	{#snippet children(current)}
		{#if current.id === 'edit'}
			<TagEditor
				bind:rows={bulkEdit}
				faults={bulkFaults}
				newRow={blankBulkRow}
				disabled={bulkBusy}
				rowNote={spreadNote}
			/>
		{:else}
			<div class="review">
				{#if bulkBusy}
					<ProgressBar value={applyDone} max={applyTotal} left={t('web.tagBulk.applying', { done: applyDone, total: applyTotal })} />
				{/if}

				<SegmentedControl
					size="small"
					label={t('web.tagBulk.colStatus')}
					options={reviewOptions}
					value={activeReviewFilter}
					onchange={(id) => (reviewFilter = id)}
				/>

				<DataTable
					columns={reviewColumns}
					rows={shownReview}
					getId={(row: PlanRow) => row.id}
					maxHeight="22.5rem"
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
			</div>
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

	// a full line of the toolbar, under its controls
	.filters {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		flex-basis: 100%;
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

	.review {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
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
