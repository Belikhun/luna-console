<script lang="ts" generics="T = any">
	import type { Snippet } from 'svelte';
	import DataTable from './DataTable.svelte';
	import SearchInput from './SearchInput.svelte';
	import ContextMenu from './ContextMenu.svelte';
	import Btn from './Btn.svelte';
	import type { Column, TableFilterGroup } from './table';
	import type { ContextMenuItem } from './contextmenu';
	import { matches, rowText } from '$lib/search/match';

	/**
	 * The console's standard resource table (DESIGN.md §5.1): search, optional
	 * filter groups, pagination, the preferences dialog and a per-row context
	 * menu, in one component — so a table on a main screen is never *partly* a
	 * table, and a screen declares its row verbs exactly once.
	 *
	 * `rowActions(row)` is the row's context menu; the same function feeds the
	 * screen's own Actions dropdown in its `PageHeader`, which is where a
	 * selection's verbs live (DESIGN.md §5.2) — never a second button wedged
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
		searchPlaceholder = 'Find resources',
		searchWidth = '26rem',
		filters,
		rowActions,
		rowLabel,
		toolbar: toolbarExtra,
		selectable = 'none',
		selected = $bindable(new Set<string>()),
		sortValue,
		onRowClick,
		rowDim,
		paging = true,
		pageSize = 25,
		maxHeight,
		emptyTitle = 'No resources to display',
		emptyText = '',
		noun = 'resource'
	}: {
		/** required — preferences (columns, page size, density) are stored per table */
		tableId: string;
		columns: Column[];
		rows: T[];
		getId: (row: T) => string;
		cell: Snippet<[T, string]>;
		/** searchable text for a row; defaults to the row's own values */
		searchValue?: (row: T) => string;
		/** pre-filled query — how a global-search hit lands on a screen whose
		 *  objects have no detail route of their own */
		initialSearch?: string;
		searchPlaceholder?: string;
		searchWidth?: string;
		filters?: TableFilterGroup<T>[];
		/** the row's verbs — its right-click menu, and the screen's Actions dropdown */
		rowActions?: (row: T) => ContextMenuItem[];
		/** heading of the row's context menu (defaults to its id) */
		rowLabel?: (row: T) => string;
		/** extra controls, rendered after the search box */
		toolbar?: Snippet;
		selectable?: 'none' | 'single' | 'multi';
		selected?: Set<string>;
		sortValue?: (row: T, columnId: string) => string | number | null;
		onRowClick?: (row: T) => void;
		rowDim?: (row: T) => boolean;
		paging?: boolean;
		pageSize?: number;
		maxHeight?: string;
		emptyTitle?: string;
		emptyText?: string;
		/** what the rows are, for the "no matches" copy */
		noun?: string;
	} = $props();

	// seeded once from the prop on purpose: after that the box owns the query
	// svelte-ignore state_referenced_locally
	let search = $state(initialSearch);
	let filtersActive = $state(false);
	// only the reset is called from here, and naming the component type inside
	// its own generic instantiation is what TS cannot resolve
	let table: { clearFilters: () => void } | undefined = $state();
	let rowMenu: ContextMenu | undefined = $state();
	let menuRow: T | undefined = $state();

	const haystack = (row: T): string => searchValue?.(row) ?? rowText(row);

	const visible = $derived(
		search.trim() ? rows.filter((row) => matches(haystack(row), search)) : rows
	);

	const filtering = $derived(!!search.trim() || filtersActive);

	// "nothing matches" and "nothing exists" are different situations, and only
	// one of them is the user's to fix
	const noMatch = $derived(rows.length > 0 && visible.length === 0);

	async function openRowMenu(row: T, event: MouseEvent): Promise<void> {
		if (!rowActions) {
			return;
		}

		menuRow = row;

		await rowMenu?.openAt(event.clientX, event.clientY);
	}

	function clearAll(): void {
		search = '';
		table?.clearFilters();
	}
</script>

{#snippet tools()}
	<SearchInput bind:value={search} placeholder={searchPlaceholder} width={searchWidth} />
	{#if toolbarExtra}{@render toolbarExtra()}{/if}
{/snippet}

{#snippet clearer()}
	{#if filtering}
		<Btn icon="close" onclick={clearAll}>Clear search and filters</Btn>
	{/if}
{/snippet}

<DataTable
	bind:this={table}
	bind:filtersActive
	{tableId}
	{columns}
	rows={visible}
	{getId}
	cell={cellBody}
	toolbar={tools}
	emptyExtra={clearer}
	{filters}
	{selectable}
	bind:selected
	{sortValue}
	{onRowClick}
	{rowDim}
	{paging}
	{pageSize}
	{maxHeight}
	onRowContextMenu={rowActions ? openRowMenu : undefined}
	emptyTitle={noMatch ? `No ${noun} matches your search` : emptyTitle}
	emptyText={noMatch ? 'Nothing here answers the current search and filters.' : emptyText}
/>

<ContextMenu
	bind:this={rowMenu}
	items={menuRow && rowActions ? rowActions(menuRow) : []}
	header={menuRow ? (rowLabel?.(menuRow) ?? getId(menuRow)) : undefined}
	minWidth="14rem"
/>
