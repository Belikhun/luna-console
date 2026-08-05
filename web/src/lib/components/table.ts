// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/** Column definition for DataTable. */
export interface Column {
	id: string;
	label: string;
	/** initial width in px (resizable at runtime) */
	width?: number;
	minWidth?: number;
	sortable?: boolean;
	align?: 'left' | 'center' | 'right';
	/** hidden by default (can be enabled via table preferences) */
	hidden?: boolean;
}

/** One choice inside a filter group. */
export interface TableFilterOption<T = any> {
	value: string;
	label: string;
	/** omit on the group's "any value" entry, which matches everything */
	match?: (row: T) => boolean;
}

/**
 * Predefined attribute filter offered next to the table's search box. Each
 * group renders as one inline-labelled select (e.g. "Filter instance state" /
 * "Filter instance type"); the active options of every group are ANDed
 * together. The first option is the default.
 */
export interface TableFilterGroup<T = any> {
	id: string;
	label: string;
	options: TableFilterOption<T>[];
}

/** How many leading columns stay pinned while scrolling horizontally. */
export type StickyFirst = 0 | 1 | 2;

export interface TablePrefs {
	/** resized column widths in px, keyed by column id */
	widths: Record<string, number>;
	hidden: string[];
	/** column ids in display order; unknown/missing ids fall back to declaration order */
	order?: string[];
	pageSize?: number;
	wrapLines?: boolean;
	striped?: boolean;
	compact?: boolean;
	stickyFirst?: StickyFirst;
	stickyLast?: boolean;
	/** id of the sorted column, or null while the table is in its natural order */
	sortCol?: string | null;
	sortDir?: 'asc' | 'desc';
}

export const DEFAULT_PREFS: TablePrefs = {
	widths: {},
	hidden: [],
	order: undefined,
	pageSize: undefined,
	wrapLines: false,
	striped: false,
	compact: false,
	stickyFirst: 1,
	stickyLast: false,
	sortCol: null,
	sortDir: 'asc'
};

/** Page sizes offered in the preferences dialog. */
export const PAGE_SIZES = [5, 10, 15, 20, 25, 50, 100];

/** Read a table's stored preferences, falling back to the defaults. */
export function loadPrefs(tableId: string | undefined): TablePrefs {
	if (!tableId || typeof localStorage === 'undefined') {
		return { ...DEFAULT_PREFS };
	}

	try {
		const raw = localStorage.getItem(`luna.table.${tableId}`);
		const parsed = raw ? JSON.parse(raw) : null;

		if (parsed && typeof parsed === 'object') {
			return { ...DEFAULT_PREFS, ...parsed, widths: sanitizeWidths(parsed.widths) };
		}
	} catch {
		// unreadable or corrupt entry; fall back to the defaults
	}

	return { ...DEFAULT_PREFS };
}

// stored widths feed the table's own width, so a corrupt entry would break the
// layout rather than just look wrong; anything not a usable length is dropped
function sanitizeWidths(stored: unknown): Record<string, number> {
	if (!stored || typeof stored !== 'object') {
		return {};
	}

	const out: Record<string, number> = {};

	for (const [id, width] of Object.entries(stored)) {
		if (typeof width === 'number' && Number.isFinite(width) && width > 0) {
			out[id] = width;
		}
	}

	return out;
}

/** Persist a table's preferences. Tables without an id are not remembered. */
export function savePrefs(tableId: string | undefined, prefs: TablePrefs): void {
	if (!tableId || typeof localStorage === 'undefined') {
		return;
	}

	localStorage.setItem(`luna.table.${tableId}`, JSON.stringify(prefs));
}

/** Apply a stored column order, keeping columns the order doesn't mention. */
export function applyOrder(columns: Column[], order: string[] | undefined): Column[] {
	if (!order?.length) {
		return columns;
	}

	const known = new Map(columns.map((column) => [column.id, column]));
	const out: Column[] = [];

	for (const id of order) {
		const column = known.get(id);

		if (column) {
			out.push(column);
			known.delete(id);
		}
	}

	return [...out, ...known.values()];
}
