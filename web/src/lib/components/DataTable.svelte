<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts" generics="T = any">
	import { t } from '$lib/i18n.svelte';
	import { untrack, type Snippet } from 'svelte';
	import Icon from './Icon.svelte';
	import Checkbox from './Checkbox.svelte';
	import Toggle from './Toggle.svelte';
	import PagingBar from './PagingBar.svelte';
	import Modal from './Modal.svelte';
	import ContextMenu from './ContextMenu.svelte';
	import Btn from './Btn.svelte';
	import Select from './Select.svelte';
	import {
		type Column,
		type TableFilterGroup,
		type StickyFirst,
		type TablePrefs,
		PAGE_SIZES,
		applyOrder,
		loadPrefs,
		savePrefs
	} from './table';
	import type { ContextMenuItem } from './contextmenu';

	/**
	 * Resource table: darker sticky header with column dividers and
	 * weight-coded sort carets, drag-resizable columns, pinned leading columns,
	 * canned filters beside the search box, client-side paging, and a two-column
	 * preferences dialog (page size, display options, column order + visibility)
	 *; all persisted per tableId. Selecting a row never shifts the layout, and
	 * runs of selected rows merge into a single block.
	 */
	let {
		tableId,
		columns,
		rows,
		getId,
		cell,
		toolbar,
		filters,
		selectable = 'none',
		selected = $bindable(new Set<string>()),
		sortValue,
		onRowClick,
		onRowContextMenu,
		rowActions,
		rowLabel,
		rowDim,
		rowLocked,
		paging = false,
		pageSize = 25,
		maxHeight,
		emptyTitle = t('web.table.emptyTitle'),
		emptyText = '',
		emptyExtra,
		defaultSort,
		filtersActive = $bindable(false)
	}: {
		/** persistence key for column prefs */
		tableId?: string;
		columns: Column[];
		rows: T[];
		getId: (row: T) => string;
		cell: Snippet<[T, string]>;
		/** left side of the built-in toolbar row */
		toolbar?: Snippet;
		/** canned attribute filters, one inline-labelled select per group */
		filters?: TableFilterGroup<T>[];
		selectable?: 'none' | 'single' | 'multi';
		selected?: Set<string>;
		sortValue?: (row: T, columnId: string) => string | number | null;
		onRowClick?: (row: T) => void;
		/** right-click on a row; the row is selected first, then this fires.
		 *  Prefer `rowActions`: this is the escape hatch for a caller that owns its
		 *  own menu (and is what ResourceTable used before the menu moved here) */
		onRowContextMenu?: (row: T, event: MouseEvent) => void;
		/** the row's verbs, as its right-click menu; a table never grows a column
		 *  of buttons instead (see CLAUDE.md, web console conventions) */
		rowActions?: (row: T) => ContextMenuItem[];
		/** heading of the row's context menu (defaults to the row's id) */
		rowLabel?: (row: T) => string;
		/** rows rendered dimmed; de-emphasis only (disabled, withheld, not deployed).
		 *  A dimmed row is still selectable, because the verb that un-dims it is
		 *  usually the one the user came for */
		rowDim?: (row: T) => boolean;
		/** rows that cannot be selected at all; no checkbox, clicks don't select.
		 *  Only for rows no bulk verb can ever apply to (e.g. external servers luna
		 *  does not own); these render dimmed too */
		rowLocked?: (row: T) => boolean;
		paging?: boolean;
		pageSize?: number;
		maxHeight?: string;
		emptyTitle?: string;
		emptyText?: string;
		/** rendered under the empty state; e.g. "clear the search" */
		emptyExtra?: Snippet;
		/** the order the screen's author considers this table's natural one, used
		 *  until the reader sorts it themselves. Their choice is stored per table
		 *  and wins from then on; there is no way back to an unsorted table, so a
		 *  stored `null` only ever means "has never sorted this one" */
		defaultSort?: { col: string; dir?: 'asc' | 'desc' };
		/** true while any filter group is on something other than "any value" */
		filtersActive?: boolean;
	} = $props();

	// untracked on purpose: preferences are read once per mount, and a table's
	// id never changes under it; re-reading them would fight the user's edits
	const initial = untrack(() => loadPrefs(tableId));

	/** px; fallbacks for a column that has never been measured or resized */
	const DEFAULT_COL_W = 120;
	const MIN_COL_W = 56;

	/** px; mirrors the `2.75rem` the selection column is given in CSS */
	const SEL_COL_W = 44;

	/**
	 * px; how far the container may drift before the measured widths are re-fitted
	 * to it. Comfortably clear of a scrollbar appearing (~15px), which must never
	 * be mistaken for a resize: re-fitting would toggle the scrollbar right back.
	 */
	const SETTLE_SLOP = 24;

	/** ms the container must hold a new width before the columns re-fit to it */
	const SETTLE_MS = 150;

	/** px per rem, for turning measured geometry back into the rem scale */
	const REM = 16;

	// the column set is a static declaration of the screen, captured once so the
	// stored order and hidden set below stay the user's, not the author's
	const defaultHidden = untrack(() => columns.filter((col) => col.hidden).map((col) => col.id));

	let widths: Record<string, number> = $state(initial.widths);
	let hidden: Set<string> = $state(new Set([...initial.hidden, ...defaultHidden]));
	let order: string[] = $state(initial.order ?? untrack(() => columns.map((col) => col.id)));
	let effPageSize = $state(initial.pageSize ?? untrack(() => pageSize));
	let wrapLines = $state(initial.wrapLines ?? false);
	let striped = $state(initial.striped ?? false);
	let compact = $state(initial.compact ?? false);
	let stickyFirst: StickyFirst = $state(initial.stickyFirst ?? 1);
	let stickyLast = $state(initial.stickyLast ?? false);

	let sortCol: string | null = $state(initial.sortCol ?? untrack(() => defaultSort?.col ?? null));
	let sortDir: 'asc' | 'desc' = $state(
		initial.sortCol
			? (initial.sortDir ?? 'asc')
			: untrack(() => defaultSort?.dir ?? 'asc')
	);
	let page = $state(1);
	let prefsOpen = $state(false);
	let rowMenu: ContextMenu | undefined = $state();
	let menuRow: T | undefined = $state();

	// each group starts on its first option, which is the "any value" entry
	const filterValues: Record<string, string> = $state(
		untrack(() =>
			Object.fromEntries(
				(filters ?? []).map((group) => [group.id, group.options[0]?.value ?? ''])
			)
		)
	);

	const orderedColumns = $derived(applyOrder(columns, order));
	const visibleCols = $derived(orderedColumns.filter((col) => !hidden.has(col.id)));

	const matchers = $derived(
		(filters ?? []).flatMap((group) => {
			const option = group.options.find((entry) => entry.value === filterValues[group.id]);

			return option?.match ? [option.match] : [];
		})
	);

	const filtered = $derived(
		matchers.length ? rows.filter((row) => matchers.every((match) => match(row))) : rows
	);

	// the wrapper needs to know whether a filter is narrowing the table, so an
	// empty result can say "nothing matches" rather than "nothing exists"
	$effect(() => {
		filtersActive = matchers.length > 0;
	});

	/** Reset every filter group to its "any value" entry. */
	export function clearFilters(): void {
		for (const group of filters ?? []) {
			filterValues[group.id] = group.options[0]?.value ?? '';
		}

		page = 1;
	}

	// a restored sort holds only while its column is still there and still sortable
	const activeSort = $derived(
		columns.some((col) => col.id === sortCol && col.sortable) ? sortCol : null
	);

	const sorted = $derived.by(() => {
		if (!activeSort || !sortValue) {
			return filtered;
		}

		const col = activeSort;
		const dir = sortDir === 'asc' ? 1 : -1;

		return [...filtered].sort((a, b) => {
			const left = sortValue(a, col) ?? '';
			const right = sortValue(b, col) ?? '';

			if (typeof left === 'number' && typeof right === 'number') {
				return (left - right) * dir;
			}

			return String(left).localeCompare(String(right)) * dir;
		});
	});

	const maxPage = $derived(paging ? Math.max(1, Math.ceil(sorted.length / effPageSize)) : 1);

	// filtering can shrink the table under the current page
	$effect(() => {
		if (page > maxPage) {
			page = maxPage;
		}
	});

	const paged = $derived(
		paging ? sorted.slice((page - 1) * effPageSize, page * effPageSize) : sorted
	);

	const selectableRows = $derived(filtered.filter((row) => !rowLocked?.(row)));
	const allSelected = $derived(selectableRows.length > 0 && selected.size >= selectableRows.length);
	const someSelected = $derived(selected.size > 0 && !allSelected);

	function persist(): void {
		const prefs: TablePrefs = {
			widths,
			hidden: [...hidden],
			order,
			pageSize: effPageSize,
			wrapLines,
			striped,
			compact,
			stickyFirst,
			stickyLast,
			sortCol,
			sortDir
		};
		savePrefs(tableId, prefs);
	}

	// ----- sorting & selection -----
	function toggleSort(col: Column): void {
		if (!col.sortable) {
			return;
		}

		if (sortCol === col.id) {
			sortDir = sortDir === 'asc' ? 'desc' : 'asc';
			persist();

			return;
		}

		sortCol = col.id;
		sortDir = 'asc';
		persist();
	}

	function toggle(row: T): void {
		const id = getId(row);

		if (selectable === 'single') {
			selected = new Set<string>(selected.has(id) ? [] : [id]);

			return;
		}

		const next = new Set(selected);

		if (selectable === 'multi') {
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
		}

		selected = next;
	}

	function rowClick(row: T): void {
		if (rowLocked?.(row)) {
			return;
		}

		if (selectable !== 'none') {
			selected = new Set([getId(row)]);
		}

		onRowClick?.(row);
	}

	/**
	 * A dimmed row still has verbs; it is usually the one that needs them, since
	 * "dim" here means disabled, withheld or not deployed, and the verb that fixes
	 * that is in this menu. Only a *locked* row is kept out of the selection.
	 */
	async function rowContext(row: T, event: MouseEvent): Promise<void> {
		if (!onRowContextMenu && !rowActions) {
			return;
		}

		event.preventDefault();

		// right-clicking outside the selection moves it to this row first
		if (selectable !== 'none' && !rowLocked?.(row) && !selected.has(getId(row))) {
			selected = new Set([getId(row)]);
		}

		if (rowActions) {
			menuRow = row;

			await rowMenu?.openAt(event.clientX, event.clientY);
		}

		onRowContextMenu?.(row, event);
	}

	function toggleAll(): void {
		selected = allSelected ? new Set() : new Set(selectableRows.map(getId));
	}

	// ----- column widths -----
	// Every visible column carries an explicit width so `table-layout: fixed` can
	// never redistribute a drag across its neighbours. Columns that declare no
	// width are measured from the natural (auto) layout instead of being guessed,
	// so the table starts out looking exactly as it did before.
	let headCells: HTMLTableCellElement[] = $state([]);
	let tableEl: HTMLTableElement | undefined = $state();
	let wrapEl: HTMLDivElement | undefined = $state();
	let wrapWidth = $state(0);
	let autoWidths: Record<string, number> = $state({});

	/** px; the container width the current measurements were taken at */
	let measuredAt = $state(0);

	/**
	 * px; a column's authoritative width: the user's own resize, else what the
	 * natural layout measured. A declared width only stands in until that
	 * measurement exists: it is a hint the natural layout has already honoured, so
	 * preferring it afterwards would hold the column at its minimum and leave the
	 * space it should have taken to the filler.
	 *
	 * A declared `minWidth` bounds all three. A drag is already clamped to it, so
	 * a stored width below it can only be one saved before the column asked for
	 * more; and the alternative is a column that stays too narrow for its own
	 * content until the user happens to drag it.
	 */
	function sizeOf(col: Column): number | undefined {
		const size = widths[col.id] ?? autoWidths[col.id] ?? col.width;

		if (size === undefined) {
			return undefined;
		}

		return Math.max(size, col.minWidth ?? 0);
	}

	const layoutReady = $derived(visibleCols.every((col) => autoWidths[col.id] !== undefined));

	const selWidth = $derived(selectable !== 'none' ? SEL_COL_W : 0);

	const contentWidth = $derived(
		visibleCols.reduce((acc, col) => acc + (sizeOf(col) ?? 0), selWidth)
	);

	// The table is sized to its columns, never to its container: that is what lets
	// the sum overflow into a horizontal scroll instead of squeezing columns. Any
	// leftover space when the columns are narrower than the viewport goes to a
	// trailing filler column, so the header strip and row rules still span the
	// full width without a single real column being stretched.
	const tableWidth = $derived(Math.max(contentWidth, wrapWidth));
	const slack = $derived(layoutReady ? tableWidth - contentWidth : 0);
	const overflowing = $derived(layoutReady && contentWidth > wrapWidth);

	$effect(() => {
		if (!wrapEl) {
			return;
		}

		const observer = new ResizeObserver((entries) => {
			wrapWidth = entries[0]?.contentRect.width ?? 0;
		});

		observer.observe(wrapEl);

		return () => observer.disconnect();
	});

	/**
	 * Measure what the browser would give each column if the table laid itself out
	 * freely, and restore the applied widths before anything is painted.
	 *
	 * The measurement has to be its own synchronous write-read-restore rather than
	 * "clear the widths and read them back in the next effect": Svelte coalesces
	 * the clear with the re-measure into a single flush, so that DOM state is never
	 * reached and the effect just re-reads the widths already in force. Reading a
	 * rect forces the reflow, so the natural geometry is real; and the widths are
	 * back in place by the end of the function, well before the frame is painted.
	 *
	 * The user's own resizes must come off for the pass, or a pinned neighbour
	 * would leave the others measuring only the space it did not take; reloading
	 * a table with one widened column would quietly re-compact everything around
	 * it. Widths a page *declares* stay on: they are a static hint, identical on
	 * every load, and the layout being measured is meant to respect them.
	 */
	function naturalWidths(table: HTMLTableElement): Record<string, number> {
		const cols = [...table.querySelectorAll('col')];
		const savedCols = cols.map((col) => col.style.width);
		const savedLayout = table.style.tableLayout;
		const savedWidth = table.style.width;
		const offset = selectable !== 'none' ? 1 : 0;

		// the selection column is left alone; it is a fixed box in CSS, not a
		// measured one; while the filler must not hold space during the pass
		visibleCols.forEach((col, ci) => {
			const element = cols[ci + offset];

			if (element) {
				element.style.width = col.width ? `${col.width / REM}rem` : '';
			}
		});

		const filler = cols[visibleCols.length + offset];

		if (filler) {
			filler.style.width = '';
		}

		table.style.tableLayout = 'auto';
		table.style.width = '100%';

		const next: Record<string, number> = {};

		visibleCols.forEach((col, ci) => {
			const head = headCells[ci + offset];

			// floored, never rounded: rounding up can push the total a pixel past
			// the container and raise a scrollbar over nothing, while the few pixels
			// a floor leaves behind disappear into the filler
			const natural = Math.floor(head?.getBoundingClientRect().width ?? 0);

			// a cell that measures as nothing is not a column worth keeping; a
			// declared or default width beats collapsing it to a sliver
			const measured = natural >= MIN_COL_W ? natural : (col.width ?? DEFAULT_COL_W);

			// A declared minWidth is a floor here too, not only under a drag: this
			// pass runs the table at 100%, so a crowded one hands every column its
			// squeezed share, and a column whose content is indivisible (a brand mark
			// beside its name) ends up ellipsised at rest. Raising it past the share
			// costs the table width the wrap already scrolls.
			next[col.id] = Math.max(measured, col.minWidth ?? 0);
		});

		cols.forEach((col, index) => (col.style.width = savedCols[index] ?? ''));
		table.style.tableLayout = savedLayout;
		table.style.width = savedWidth;

		return next;
	}

	$effect(() => {
		// Header labels alone measure far narrower than the data, so the pass waits
		// for the first rendered rows rather than locking in a width nothing fits.
		// A zero-width container means the table is not on screen yet (a closed tab
		// panel), where every cell would measure as nothing.
		if (layoutReady || !paged.length || !wrapWidth || !tableEl) {
			return;
		}

		autoWidths = naturalWidths(tableEl);
		measuredAt = wrapWidth;
	});

	// A window resize or a collapsed side nav moves the container the columns were
	// fitted to, which would otherwise leave the filler holding the difference for
	// good. Dropping the measurements re-runs the pass; anything the user resized
	// by hand lives in `widths` and survives untouched. The wait lets a drag finish
	// first, so the table re-fits once instead of on every frame.
	$effect(() => {
		if (!layoutReady || Math.abs(wrapWidth - measuredAt) <= SETTLE_SLOP) {
			return;
		}

		const timer = setTimeout(() => (autoWidths = {}), SETTLE_MS);

		return () => clearTimeout(timer);
	});

	// ----- pinned columns: offsets are measured, since widths may be automatic -----
	let stickyOffsets: number[] = $state([]);

	/** number of leading cells (selection column included) that stay pinned */
	const stickyCount = $derived(stickyFirst === 0 ? 0 : stickyFirst + (selectable !== 'none' ? 1 : 0));

	$effect(() => {
		// anything that can change a leading column's width re-measures the offsets
		void [stickyCount, visibleCols, widths, autoWidths, tableWidth];
		void [compact, wrapLines, rows.length];

		const offsets: number[] = [];
		let acc = 0;

		for (let i = 0; i < stickyCount; i++) {
			offsets.push(acc);
			acc += headCells[i]?.offsetWidth ?? 0;
		}

		stickyOffsets = offsets;
	});

	const stickyStyle = (index: number): string | undefined => {
		if (index >= stickyCount) {
			return undefined;
		}

		return `left: ${(stickyOffsets[index] ?? 0) / REM}rem`;
	};

	// ----- column drag-resize -----
	let resizing: { col: string; startX: number; startW: number } | null = $state(null);

	function startResize(colId: string, event: PointerEvent): void {
		event.preventDefault();
		event.stopPropagation();

		const header = (event.target as HTMLElement).closest('th');
		const col = columns.find((candidate) => candidate.id === colId);

		resizing = {
			col: colId,
			startX: event.clientX,
			// the rendered width is what the user grabbed, so a drag never jumps
			startW: (col ? sizeOf(col) : undefined) ?? header?.offsetWidth ?? DEFAULT_COL_W
		};
	}

	function onMove(event: PointerEvent): void {
		if (!resizing) {
			return;
		}

		const col = columns.find((candidate) => candidate.id === resizing!.col);
		const wanted = resizing.startW + (event.clientX - resizing.startX);

		widths[resizing.col] = Math.max(col?.minWidth ?? MIN_COL_W, wanted);
	}

	function endResize(): void {
		if (!resizing) {
			return;
		}

		resizing = null;
		persist();
	}

	// ----- preferences dialog (draft state, committed on Confirm) -----
	let draft = $state({
		pageSize: 25,
		wrapLines: false,
		striped: false,
		compact: false,
		stickyFirst: 1 as StickyFirst,
		stickyLast: false,
		order: [] as string[],
		hidden: new Set<string>()
	});
	let dragId: string | null = $state(null);

	function openPrefs(): void {
		draft = {
			pageSize: effPageSize,
			wrapLines,
			striped,
			compact,
			stickyFirst,
			stickyLast,
			order: orderedColumns.map((col) => col.id),
			hidden: new Set(hidden)
		};

		prefsOpen = true;
	}

	function confirmPrefs(): void {
		effPageSize = draft.pageSize;
		wrapLines = draft.wrapLines;
		striped = draft.striped;
		compact = draft.compact;
		stickyFirst = draft.stickyFirst;
		stickyLast = draft.stickyLast;
		order = [...draft.order];
		hidden = new Set(draft.hidden);
		page = 1;
		prefsOpen = false;
		persist();
	}

	function toggleDraftColumn(id: string): void {
		const next = new Set(draft.hidden);

		if (next.has(id)) {
			next.delete(id);
		} else {
			next.add(id);
		}

		// hiding the last visible column would leave an empty table
		if (next.size >= draft.order.length) {
			return;
		}

		draft.hidden = next;
	}

	function dropOn(targetId: string): void {
		if (!dragId || dragId === targetId) {
			return;
		}

		const next = draft.order.filter((id) => id !== dragId);

		next.splice(next.indexOf(targetId), 0, dragId);
		draft.order = next;
	}

	const draftColumns = $derived(
		draft.order
			.map((id) => columns.find((col) => col.id === id))
			.filter((col): col is Column => !!col)
	);

	const rangeText = $derived.by(() => {
		if (!paging || sorted.length === 0) {
			return '';
		}

		const from = (page - 1) * effPageSize + 1;
		const to = Math.min(page * effPageSize, sorted.length);

		return `${from}-${to} of ${sorted.length}`;
	});

	/**
	 * Column width in rem, from a resize, a declared width or the measured one -
	 * and nothing at all during the measuring pass, which must stay natural.
	 */
	function colWidth(col: Column): string | undefined {
		if (!layoutReady) {
			return undefined;
		}

		const size = sizeOf(col);

		return size ? `${size / REM}rem` : undefined;
	}

	const STICKY_FIRST_OPTIONS: Array<{ value: StickyFirst; label: string }> = [
		{ value: 0, label: t('web.table.stickyNone') },
		{ value: 1, label: t('web.table.stickyFirst') },
		{ value: 2, label: t('web.table.stickyFirstTwo') }
	];

	const STICKY_LAST_OPTIONS = [
		{ value: false, label: t('web.table.stickyNone') },
		{ value: true, label: t('web.table.stickyLast') }
	];
</script>

<svelte:window onpointermove={onMove} onpointerup={endResize} />

<div
	class="dt"
	class:resizing={!!resizing}
	class:wrap-lines={wrapLines}
	class:striped
	class:compact
>
	{#if toolbar || paging || tableId || filters}
		<div class="tb">
			<div class="tb-left">
				{#if toolbar}{@render toolbar()}{/if}
				{#each filters ?? [] as group (group.id)}
					<Select
						label={group.label}
						bind:value={filterValues[group.id]}
						options={group.options}
						width="14rem"
						onchange={() => (page = 1)}
					/>
				{/each}
			</div>
			<div class="tb-right">
				{#if rangeText}<span class="range">{rangeText}</span>{/if}
				{#if paging}<PagingBar bind:page max={maxPage} />{/if}
				{#if tableId}
					{#if paging}<span class="tb-div"></span>{/if}
					<button class="gear" title="Preferences" onclick={openPrefs}>
						<Icon name="gear" size="1.125rem" style="solid" />
					</button>
				{/if}
			</div>
		</div>
	{/if}

	<div class="wrap" style:max-height={maxHeight} bind:this={wrapEl}>
		<table
			bind:this={tableEl}
			style:table-layout={layoutReady ? 'fixed' : 'auto'}
			style:width={layoutReady ? `${tableWidth / REM}rem` : '100%'}
		>
			<colgroup>
				{#if selectable !== 'none'}<col style="width: 2.75rem" />{/if}
				{#each visibleCols as col (col.id)}
					<col style:width={colWidth(col)} />
				{/each}
				<col style:width={`${slack / REM}rem`} />
			</colgroup>
			<thead>
				<tr>
					{#if selectable !== 'none'}
						<th
							class="sel"
							class:sticky={stickyCount > 0}
							style={stickyStyle(0)}
							bind:this={headCells[0]}
						>
							<div class="hcell chk">
								{#if selectable === 'multi'}
									<Checkbox
										checked={allSelected}
										indeterminate={someSelected}
										label={t('web.table.selectAll')}
										onchange={toggleAll}
									/>
								{/if}
							</div>
						</th>
					{/if}
					{#each visibleCols as col, ci (col.id)}
						{@const index = ci + (selectable !== 'none' ? 1 : 0)}
						<th
							data-align={col.align ?? 'left'}
							class:sticky={index < stickyCount}
							class:sticky-last={stickyLast && overflowing && ci === visibleCols.length - 1}
							style={stickyStyle(index)}
							bind:this={headCells[index]}
						>
							<div
								class="hcell"
								class:sortable={col.sortable}
								role={col.sortable ? 'button' : undefined}
								onclick={() => toggleSort(col)}
							>
								<span class="name">{col.label}</span>
								{#if col.sortable}
									{@const on = activeSort === col.id}
									<span class="sort" class:on class:asc={on && sortDir === 'asc'}>
										<Icon name="sortDown" size="0.875rem" style={on ? 'solid' : 'light'} />
									</span>
								{/if}
							</div>
							<span
								class="rz"
								class:edge={ci === visibleCols.length - 1}
								role="separator"
								aria-label="Resize column"
								onpointerdown={(event) => startResize(col.id, event)}
							>
								<span class="rzline"></span>
							</span>
						</th>
					{/each}
					<th class="filler" aria-hidden="true"></th>
				</tr>
			</thead>
			<tbody>
				{#each paged as row, i (getId(row))}
					{@const locked = rowLocked?.(row) ?? false}
					{@const dim = locked || (rowDim?.(row) ?? false)}
					{@const isSelected = selected.has(getId(row))}
					{@const afterSelected = !isSelected && i > 0 && selected.has(getId(paged[i - 1]!))}
					<tr
						class:selected={isSelected}
						class:after-selected={afterSelected}
						class:dim
						class:locked
						onclick={() => rowClick(row)}
						oncontextmenu={(event) => rowContext(row, event)}
					>
						{#if selectable !== 'none'}
							<td class="sel" class:sticky={stickyCount > 0} style={stickyStyle(0)}>
								<div class="cell chk">
									{#if !locked}
										<!-- a square promises "as many as you like", so a table that
										     only takes one row wears a radio instead -->
										<Checkbox
											checked={isSelected}
											shape={selectable === 'single' ? 'radio' : 'check'}
											label="Select {getId(row)}"
											onchange={() => toggle(row)}
										/>
									{/if}
								</div>
							</td>
						{/if}
						{#each visibleCols as col, ci (col.id)}
							{@const index = ci + (selectable !== 'none' ? 1 : 0)}
							<td
								data-align={col.align ?? 'left'}
								class:sticky={index < stickyCount}
								class:sticky-last={stickyLast && overflowing && ci === visibleCols.length - 1}
								style={stickyStyle(index)}
							>
								<div class="cell">{@render cell(row, col.id)}</div>
							</td>
						{/each}
						<td class="filler"></td>
					</tr>
				{/each}
			</tbody>
		</table>
		{#if sorted.length === 0}
			<div class="empty">
				<div class="et">{emptyTitle}</div>
				{#if emptyText}<div class="ec">{emptyText}</div>{/if}
				{#if emptyExtra}<div class="ea">{@render emptyExtra()}</div>{/if}
			</div>
		{/if}
	</div>
</div>

<ContextMenu
	bind:this={rowMenu}
	items={menuRow && rowActions ? rowActions(menuRow) : []}
	header={menuRow ? (rowLabel?.(menuRow) ?? getId(menuRow)) : undefined}
	minWidth="14rem"
/>

<Modal title={t('web.table.preferences')} bind:open={prefsOpen} wide>
	<div class="prefs">
		<div class="pcol">
			{#if paging}
				<div class="pgroup">
					<div class="ptitle">{t('web.table.selectPageSize')}</div>
					{#each PAGE_SIZES as size}
						<label class="prow">
							<input
								type="radio"
								name="page-size"
								checked={draft.pageSize === size}
								onchange={() => (draft.pageSize = size)}
							/>
							<span>{t('web.table.itemCount', { count: size })}</span>
						</label>
					{/each}
				</div>
			{/if}

			<div class="pgroup">
				<label class="prow top">
					<Checkbox
						checked={draft.wrapLines}
						label={t('web.table.wrapLines')}
						onchange={(value) => (draft.wrapLines = value)}
					/>
					<span>
						<b>{t('web.table.wrapLines')}</b>
						<em>{t('web.table.wrapLinesHint')}</em>
					</span>
				</label>
				<label class="prow top">
					<Checkbox
						checked={draft.striped}
						label={t('web.table.striped')}
						onchange={(value) => (draft.striped = value)}
					/>
					<span>
						<b>{t('web.table.striped')}</b>
						<em>{t('web.table.stripedHint')}</em>
					</span>
				</label>
				<label class="prow top">
					<Checkbox
						checked={draft.compact}
						label={t('web.table.compact')}
						onchange={(value) => (draft.compact = value)}
					/>
					<span>
						<b>{t('web.table.compact')}</b>
						<em>{t('web.table.compactHint')}</em>
					</span>
				</label>
			</div>

			<div class="pgroup">
				<div class="ptitle">{t('web.table.stickFirstTitle')}</div>
				<div class="phint">{t('web.table.stickFirstHint')}</div>
				{#each STICKY_FIRST_OPTIONS as option}
					<label class="prow">
						<input
							type="radio"
							name="sticky-first"
							checked={draft.stickyFirst === option.value}
							onchange={() => (draft.stickyFirst = option.value)}
						/>
						<span>{option.label}</span>
					</label>
				{/each}
			</div>

			<div class="pgroup">
				<div class="ptitle">{t('web.table.stickLastTitle')}</div>
				<div class="phint">{t('web.table.stickLastHint')}</div>
				{#each STICKY_LAST_OPTIONS as option}
					<label class="prow">
						<input
							type="radio"
							name="sticky-last"
							checked={draft.stickyLast === option.value}
							onchange={() => (draft.stickyLast = option.value)}
						/>
						<span>{option.label}</span>
					</label>
				{/each}
			</div>
		</div>

		<div class="pcol right">
			<div class="ptitle">{t('web.table.columnPreferences')}</div>
			<div class="phint">{t('web.table.columnsHint')}</div>
			<div class="clist">
				{#each draftColumns as col (col.id)}
					<div
						class="crow"
						class:dragging={dragId === col.id}
						draggable="true"
						role="listitem"
						ondragstart={() => (dragId = col.id)}
						ondragend={() => (dragId = null)}
						ondragover={(event) => event.preventDefault()}
						ondrop={() => dropOn(col.id)}
					>
						<span class="grip" title="Drag to reorder">
							<Icon name="gripLines" size="0.875rem" style="solid" />
						</span>
						<span class="cname">{col.label}</span>
						<Toggle
							checked={!draft.hidden.has(col.id)}
							label={t('web.table.showColumn', { name: col.label })}
							onchange={() => toggleDraftColumn(col.id)}
						/>
					</div>
				{/each}
			</div>
		</div>
	</div>
	{#snippet footer()}
		<Btn variant="link" onclick={() => (prefsOpen = false)}>{t('web.common.closeModal')}</Btn>
		<Btn variant="primary" onclick={confirmPrefs}>{t('web.common.confirm')}</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.dt {
		position: relative;
		width: 100%;

		&.resizing {
			cursor: col-resize;
			user-select: none;
		}
	}

	.tb {
		position: relative;
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.75rem 1rem;
	}

	.tb-left {
		display: flex;
		align-items: flex-end;
		flex-wrap: wrap;
		gap: 0.75rem;
		flex: 1;
		min-width: 0;
	}

	.tb-right {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex: none;
	}

	.range {
		color: var(--text-secondary);
		font-size: 0.875rem;
		white-space: nowrap;
	}

	.tb-div {
		width: 0.1rem;
		height: 1.5rem;
		background: var(--border);
	}

	.gear {
		@include bare-button;

		color: var(--text);
		padding: 0.25rem;
		border-radius: 0.25rem;
		display: inline-flex;

		&:hover {
			color: var(--link);
		}
	}

	.wrap {
		overflow: auto;
	}

	// the width is set inline, from the sum of the column widths; the table sizes
	// itself to its columns so that a resize can overflow into .wrap's scroll
	// instead of being paid for by the neighbouring columns
	table {
		border-collapse: separate;
		border-spacing: 0;
		font-size: 0.875rem;
	}

	// ---- header: darker strip, column dividers, weight-coded sort carets ----
	th {
		position: sticky;
		top: 0;
		z-index: var(--z-sticky);
		background: var(--bg-table-header);
		padding: 0.125rem 0;
		border-bottom: 0.1rem solid var(--border);
		text-align: left;
		user-select: none;

		// header labels share the body cells' 0.875rem inset so both sit on the same
		// vertical axis; the th itself must not add any of its own
		.hcell {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			min-height: 1.75rem;
			padding: 0.125rem 0.875rem;
			color: var(--text-label);
			font-size: 0.8125rem;
			font-weight: 700;
			white-space: nowrap;

			.name {
				flex: 1;
				overflow: hidden;
				text-overflow: ellipsis;
			}

			&.sortable {
				cursor: pointer;

				&:hover {
					color: var(--link);

					.sort {
						color: var(--link);
					}
				}
			}
		}

		&[data-align='right'] .hcell {
			justify-content: flex-end;

			.name {
				flex: 0 1 auto;
				text-align: right;
			}
		}

		&[data-align='center'] .hcell {
			justify-content: center;

			.name {
				flex: 0 1 auto;
				text-align: center;
			}
		}
	}

	.sort {
		color: var(--text-secondary);
		display: inline-flex;

		// the caret is one glyph in two weights: light idle, solid when sorting
		&.on {
			color: var(--link);
		}

		&.asc {
			transform: rotate(180deg);
		}
	}

	// selection column: header and body checkboxes share the same box so they
	// line up on the same vertical axis
	th.sel,
	td.sel {
		width: 2.75rem;
	}

	// the header cell pads itself while body cells rely on their reserved
	// selection border, so the selection column mirrors that inset exactly and
	// both checkboxes land on the same vertical axis
	th.sel {
		padding: 0.125rem 0;
		border-left: 0.125rem solid transparent;
	}

	th .hcell.chk,
	td .cell.chk {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 1.75rem;
		padding-left: 0;
		padding-right: 0;
	}

	// The resize handle *is* the column separator: there is no header border,
	// just a short rule on the boundary inside a wide grab area, so the divider
	// and the drag target can never drift apart. The grab area overhangs into the
	// next column but the rule itself stays flush inside this one; a th sets up
	// its own stacking context, so anything crossing the boundary is painted over
	// by the following header cell and the divider vanishes at some widths.
	.rz {
		position: absolute;
		top: 0;
		right: -0.75rem;
		width: 1.5rem;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: flex-end;
		padding-right: 0.75rem;
		cursor: col-resize;
		z-index: 3;

		// The last column's grab area may not overhang: it would reach past the
		// table's own right edge and give .wrap a scrollbar with nothing to scroll.
		// Half the width keeps the live area identical to every other column's -
		// the overhanging half is painted over by the next header anyway.
		&.edge {
			right: 0;
			width: 0.75rem;
			padding-right: 0;
		}

		&:hover .rzline {
			background: var(--link);
			width: 0.125rem;
			height: 100%;
		}
	}

	.rzline {
		width: var(--hairline);
		height: 1rem;
		background: var(--border);
	}

	// ---- body ----
	// Every cell reserves the selection edges up front (0.125rem above, the row
	// divider below, outer sides only on the end cells) so selecting a row never
	// moves anything. Interior cells deliberately have no side borders; a
	// coloured top border mitering into a transparent side border is what leaves
	// little empty triangles at the cell corners.
	//
	// The filler cell is always in the DOM (0-wide once the columns overflow), so
	// the row's own last cell is reliably :nth-last-child(2); never :last-child.
	td {
		padding: 0;
		border-top: 0.125rem solid transparent;
		border-bottom: 0.1rem solid var(--border-divider);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;

		&:first-child {
			border-left: 0.125rem solid transparent;
		}

		&:nth-last-child(2) {
			border-right: 0.125rem solid transparent;
		}

		.cell {
			padding: 0.375rem 0.875rem;
			line-height: 1.25rem;
			overflow: hidden;
			text-overflow: ellipsis;

			// an empty cell reads as "no value", not as a layout gap
			&:empty::before {
				content: '–';
				color: var(--text-secondary);
			}
		}

		// a cell holding an open in-place editor must not clip it: the column is
		// sized for the resting value (a number, a short name) and the editor is
		// always wider, so the confirm and cancel would be cut off. Only while
		// one is open, and only on that cell
		&:has(:global(.inlineedit.editing)) {
			overflow: visible;

			.cell {
				overflow: visible;
			}
		}

		&[data-align='right'] .cell {
			text-align: right;
		}

		&[data-align='center'] .cell {
			text-align: center;
		}
	}

	// the selection column is legitimately empty on dimmed rows
	td.sel .cell:empty::before {
		content: none;
	}

	.dt.compact td .cell {
		padding: 0.125rem 0.875rem;
	}

	.dt.wrap-lines td {
		white-space: normal;

		.cell {
			overflow: visible;
			white-space: normal;
			word-break: break-word;
		}
	}

	tbody tr {
		cursor: pointer;

		&:hover > td {
			background-color: var(--bg-hover);
		}
	}

	.dt.striped tbody tr:nth-child(even) > td {
		background-color: var(--bg-panel-raised);
	}

	// A run of adjacent selected rows reads as one block: each boundary is drawn
	// once, by the *lower* row's top edge, and the run's closing edge is drawn by
	// the row that follows it; so neighbours never stack two borders.
	tbody tr.selected > td {
		background-color: var(--bg-selected);
		border-top-color: var(--link);
		border-bottom-color: transparent;

		// The run's side edges are painted, not bordered: a coloured side border
		// miters into the transparent bottom border and bites a notch out of every
		// cell corner. A gradient anchored to the border box has square ends.
		&:first-child,
		&:nth-last-child(2) {
			background-origin: border-box;
			background-clip: border-box;
			background-repeat: no-repeat;
		}

		&:first-child {
			background-image: linear-gradient(to right, var(--link) 0.125rem, transparent 0.125rem);
		}

		&:nth-last-child(2) {
			background-image: linear-gradient(to left, var(--link) 0.125rem, transparent 0.125rem);
		}

		// a single-column table needs both edges on the same cell
		&:first-child:nth-last-child(2) {
			background-image:
				linear-gradient(to right, var(--link) 0.125rem, transparent 0.125rem),
				linear-gradient(to left, var(--link) 0.125rem, transparent 0.125rem);
		}
	}

	tbody tr.after-selected > td {
		border-top-color: var(--link);
	}

	tbody tr.selected:last-child > td {
		border-bottom-color: var(--link);
	}

	// Dim is de-emphasis only, so the row keeps its hover and its pointer; it can
	// still be selected, and the verb that un-dims it is the one being looked for.
	tbody tr.dim {
		color: var(--text-secondary);
	}

	// A locked row has nothing to click: no hover lift, no pointer, no checkbox.
	tbody tr.locked {
		cursor: default;

		&:hover > td {
			background-color: transparent;
		}
	}

	// ---- trailing filler ----
	// It exists only to absorb the space left over when the columns are narrower
	// than the viewport, so the header strip, the striped rows and the row rules
	// still reach the right edge without a real column being stretched. It shares
	// the row's stripe and hover, but stays outside the selection block; those
	// edges belong to the last real column.
	.filler {
		padding: 0;
	}

	tbody tr.selected > td.filler,
	tbody tr.after-selected > td.filler {
		background-color: transparent;
		background-image: none;
		border-top-color: transparent;
		border-bottom-color: var(--border-divider);
	}

	// ---- pinned columns ----
	td.sticky,
	th.sticky {
		position: sticky;
		z-index: 1;
		background-color: var(--bg-panel);
	}

	td.sticky-last,
	th.sticky-last {
		position: sticky;
		right: 0;
		z-index: 1;
		background-color: var(--bg-panel);
	}

	// a pinned header cell scrolls in both axes, so it outranks the pinned body
	th.sticky,
	th.sticky-last {
		z-index: 3;
		background-color: var(--bg-table-header);
	}

	tbody tr:hover > td.sticky,
	tbody tr:hover > td.sticky-last {
		background-color: var(--bg-hover);
	}

	tbody tr.selected > td.sticky,
	tbody tr.selected > td.sticky-last {
		background-color: var(--bg-selected);
	}

	.empty {
		padding: 2.5rem 1rem;
		text-align: center;
	}

	.et {
		font-weight: 700;
		color: var(--text-heading);
	}

	.ec {
		color: var(--text-secondary);
		font-size: 0.875rem;
		margin-top: 0.25rem;
	}

	.ea {
		display: flex;
		justify-content: center;
		margin-top: 0.875rem;
	}

	// ---- preferences dialog ----
	.prefs {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: 0 2rem;
	}

	.pcol.right {
		border-left: 0.1rem solid var(--border-divider);
		padding-left: 2rem;
	}

	.pgroup + .pgroup {
		margin-top: 1.25rem;
	}

	.ptitle {
		font-weight: 700;
		color: var(--text-heading);
		margin-bottom: 0.25rem;
	}

	.phint {
		color: var(--text-secondary);
		font-size: 0.8125rem;
		margin-bottom: 0.5rem;
	}

	.prow {
		display: flex;
		align-items: center;
		gap: 0.625rem;

		// off-scale on purpose: 3px, the reference inset for these rows
		padding: 0.1875rem 0;
		cursor: pointer;

		// a row with a description stacks its two lines beside the control
		&.top {
			align-items: flex-start;
			margin-bottom: 0.375rem;
		}

		b {
			font-weight: 400;
			color: var(--text);
			display: block;
		}

		em {
			font-style: normal;
			color: var(--text-secondary);
			font-size: 0.8125rem;
			display: block;
		}
	}

	.clist {
		display: flex;
		flex-direction: column;
	}

	.crow {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.375rem 0.25rem;
		border-bottom: 0.1rem solid var(--border-divider);

		&.dragging {
			opacity: 0.4;
		}

		.grip {
			color: var(--text-secondary);
			cursor: grab;
			display: inline-flex;
		}
	}

	.cname {
		@include ellipsis;

		flex: 1;
	}
</style>
