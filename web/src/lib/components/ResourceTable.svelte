<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts" generics="T = any">
	import { t } from '$lib/i18n.svelte';
	import { untrack, type Snippet } from 'svelte';
	import DataTable from './DataTable.svelte';
	import SearchInput from './SearchInput.svelte';
	import Btn from './Btn.svelte';
	import type { Column, TableFilterGroup } from './table';
	import type { ContextMenuItem } from './contextmenu';
	import { matches, rowText } from '$lib/search/match';
	import { type ResourceIdOf, resourceIdList } from '$lib/resourceid';

	/**
	 * The console's standard resource table (DESIGN.md §5.1): search, optional
	 * filter groups, pagination, the preferences dialog and a per-row context
	 * menu, in one component; so a table on a main screen is never *partly* a
	 * table, and a screen declares its row verbs exactly once.
	 *
	 * `rowActions(row)` is the row's context menu; the same function feeds the
	 * screen's own Actions dropdown in its `PageHeader`, which is where a
	 * selection's verbs live (DESIGN.md §5.2); never a second button wedged
	 * beside the search box. `tableId` is required because the preferences it
	 * persists are per table.
	 */
	let {
		tableId,
		columns,
		rows,
		getId,
		// renamed on the way in: the snippets this component passes *down* to
		// DataTable own those names inside the template
		cell: cellBody,
		searchValue,
		initialSearch = '',
		searchPlaceholder = t('web.common.findResources'),
		searchWidth = '26rem',
		filters,
		initialFilters,
		onfilterchange,
		rowActions,
		rowLabel,
		toolbar: toolbarExtra,
		selectable = 'none',
		selected = $bindable(new Set<string>()),
		sortValue,
		onRowClick,
		onRowDblClick,
		rowDraggable,
		onRowDragStart,
		rowDropTarget,
		onRowDrop,
		search = $bindable(initialSearch),
		rowDim,
		rowLocked,
		paging = true,
		pageSize = 25,
		maxHeight,
		emptyTitle = t('web.table.emptyTitle'),
		emptyText = '',
		defaultSort,
		noun = 'resource',
		loading = false,
		expanded,
		expandable,
		resourceId
	}: {
		/** required; preferences (columns, page size, density) are stored per table */
		tableId: string;
		columns: Column[];
		rows: T[];
		getId: (row: T) => string;
		cell: Snippet<[T, string]>;
		/** searchable text for a row; defaults to the row's own values */
		searchValue?: (row: T) => string;
		/** pre-filled query; how a global-search hit lands on a screen whose
		 *  objects have no detail route of their own */
		initialSearch?: string;
		searchPlaceholder?: string;
		searchWidth?: string;
		filters?: TableFilterGroup<T>[];
		/** the option each filter group starts on, by group id */
		initialFilters?: Record<string, string>;
		/** told the filter values whenever one changes */
		onfilterchange?: (values: Record<string, string>) => void;
		/** the row's verbs; its right-click menu, and the screen's Actions dropdown */
		rowActions?: (row: T) => ContextMenuItem[];
		/** heading of the row's context menu (defaults to its id) */
		rowLabel?: (row: T) => string;
		/** extra controls, rendered after the search box */
		toolbar?: Snippet;
		selectable?: 'none' | 'single' | 'multi';
		selected?: Set<string>;
		sortValue?: (row: T, columnId: string) => string | number | null;
		onRowClick?: (row: T) => void;
		/** a double-click opens the row (a file manager's folder) */
		onRowDblClick?: (row: T) => void;
		/** rows that can be dragged, and onto which rows a drag may drop (see DataTable) */
		rowDraggable?: (row: T) => boolean;
		onRowDragStart?: (row: T, event: DragEvent) => void;
		rowDropTarget?: (row: T, event: DragEvent) => boolean;
		onRowDrop?: (row: T, event: DragEvent) => void;
		/** the search box's text, for a screen that also searches beyond the rows it holds */
		search?: string;
		/** dimmed rows; de-emphasis only, still selectable */
		rowDim?: (row: T) => boolean;
		/** rows no bulk verb can apply to: dimmed *and* kept out of the selection */
		rowLocked?: (row: T) => boolean;
		paging?: boolean;
		pageSize?: number;
		maxHeight?: string;
		emptyTitle?: string;
		emptyText?: string;
		/** the order the screen's author considers natural, until the reader sorts
		 *  it themselves; their choice is stored per table and wins after that */
		defaultSort?: { col: string; dir?: 'asc' | 'desc' };
		/** what the rows are, for the "no matches" copy */
		noun?: string;
		/** the rows are still on their way; the table shows ghost rows until some arrive */
		loading?: boolean;
		/** a row's unfolded body; adds the expander column (see DataTable) */
		expanded?: Snippet<[T]>;
		/** rows that may unfold; every row when omitted */
		expandable?: (row: T) => boolean;
		/** the resource id (or ids) a row stands for: a hidden "Resource id"
		 *  column, a "Copy resource id" menu entry, and words the search finds */
		resourceId?: ResourceIdOf<T>;
	} = $props();

	// A link to the screen that is already open (a global search hit) changes the
	// starting search and filters without remounting the table; follow them, but
	// only when they change, so the reader's own typing is never overwritten.
	let appliedSearch = untrack(() => initialSearch);
	let appliedFilters = untrack(() => JSON.stringify(initialFilters ?? {}));

	$effect(() => {
		const wanted = initialSearch;

		if (wanted === appliedSearch) {
			return;
		}

		appliedSearch = wanted;
		search = wanted;
	});

	$effect(() => {
		const wanted = initialFilters ?? {};
		const key = JSON.stringify(wanted);

		if (key === appliedFilters) {
			return;
		}

		appliedFilters = key;
		untrack(() => {
			table?.clearFilters();

			for (const [id, value] of Object.entries(wanted)) {
				table?.setFilter(id, value);
			}
		});
	});
	let filtersActive = $state(false);
	let filteredCount = $state(0);
	// only the reset is called from here, and naming the component type inside
	// its own generic instantiation is what TS cannot resolve
	let table: { clearFilters: () => void; setFilter: (id: string, value: string) => void } | undefined = $state();

	function haystack(row: T): string {
		const own = searchValue?.(row) ?? rowText(row);

		if (!resourceId) {
			return own;
		}

		return `${own} ${resourceIdList(resourceId(row)).join(' ')}`;
	}

	const visible = $derived(
		search.trim() ? rows.filter((row) => matches(haystack(row), search)) : rows
	);

	const filtering = $derived(!!search.trim() || filtersActive);

	// "nothing matches" and "nothing exists" are different situations, and only
	// one of them is the user's to fix
	// the search box and the column filters both narrow the rows, so the count
	// comes from the table, after both
	const noMatch = $derived(rows.length > 0 && (visible.length === 0 || filteredCount === 0));

	function clearAll(): void {
		search = '';
		table?.clearFilters();
	}

	/** Set one filter group from outside the table. */
	export function setFilter(id: string, value: string): void {
		table?.setFilter(id, value);
	}
</script>

{#snippet tools()}
	<SearchInput bind:value={search} placeholder={searchPlaceholder} width={searchWidth} />
	{#if toolbarExtra}{@render toolbarExtra()}{/if}
{/snippet}

{#snippet clearer()}
	{#if filtering}
		<Btn icon="close" onclick={clearAll}>{t('web.table.clearFilters')}</Btn>
	{/if}
{/snippet}

<DataTable
	bind:this={table}
	bind:filtersActive
	bind:filteredCount
	{tableId}
	{columns}
	rows={visible}
	{getId}
	cell={cellBody}
	toolbar={tools}
	emptyExtra={clearer}
	{defaultSort}
	{filters}
	{initialFilters}
	{onfilterchange}
	{selectable}
	bind:selected
	{sortValue}
	{onRowClick}
	{onRowDblClick}
	{rowDraggable}
	{onRowDragStart}
	{rowDropTarget}
	{onRowDrop}
	{rowDim}
	{rowLocked}
	{paging}
	{pageSize}
	{maxHeight}
	{rowActions}
	{rowLabel}
	{expanded}
	{expandable}
	{resourceId}
	loading={loading && rows.length === 0}
	emptyTitle={noMatch ? t('web.table.noMatch', { noun }) : emptyTitle}
	emptyText={noMatch ? t('web.table.noMatchText') : emptyText}
/>
