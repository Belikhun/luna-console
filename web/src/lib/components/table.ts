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
	stickyLast: false
};

/** Page sizes offered in the preferences dialog. */
export const PAGE_SIZES = [5, 10, 15, 20, 25, 50, 100];

/** Read a table's stored preferences, falling back to the defaults. */
export function loadPrefs(tableId: string | undefined): TablePrefs {
	if (!tableId || typeof localStorage === 'undefined') {
		return { ...DEFAULT_PREFS };
	}

	try {
		const raw = localStorage.getItem(`mrds.table.${tableId}`);

		if (raw) {
			return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
		}
	} catch {
		// unreadable or corrupt entry — fall back to the defaults
	}

	return { ...DEFAULT_PREFS };
}

/** Persist a table's preferences. Tables without an id are not remembered. */
export function savePrefs(tableId: string | undefined, prefs: TablePrefs): void {
	if (!tableId || typeof localStorage === 'undefined') {
		return;
	}

	localStorage.setItem(`mrds.table.${tableId}`, JSON.stringify(prefs));
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
