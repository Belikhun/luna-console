// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { TAG_KEY_PATTERN, TAG_VALUE_PATTERN } from '$shared/iam/resources';

/** A resource's tags, as the store keeps them. */
export type TagMap = Record<string, string>;

/** One chip of the editor. */
export interface TagEntry {
	key: string;
	value: string;
}

/** The tags as chips, in key order so a re-render never shuffles them. */
export function tagEntries(tags: TagMap): TagEntry[] {
	return Object.keys(tags)
		.sort((a, b) => a.localeCompare(b))
		.map((key) => ({ key, value: tags[key] ?? '' }));
}

/** One editable row of the tag editor; `uid` keys it while its key is being typed. */
export interface TagDraftRow {
	uid: number;
	key: string;
	value: string;
	/** the key this row was opened with; null for a row the operator added */
	original: string | null;
	/** the value it was opened with ('' for an added row or a mixed bulk row) */
	originalValue: string;
	/** marked for removal; only a row with an `original` can be */
	removed: boolean;
}

/** What the row editor reads of a row; the bulk editor's rows add the `mixed` state. */
export interface TagEditorRow extends TagDraftRow {
	mixed?: boolean;
	edited?: boolean;
}

/** Where a row stands against what it was opened with. */
export type TagRowState = 'blank' | 'same' | 'new' | 'changed' | 'removed';

/** What is wrong with one row, as language keys, per field. */
export interface TagRowFault {
	key?: string;
	value?: string;
}

let draftUid = 0;

/** A fresh, empty row. */
export function blankTagRow(): TagDraftRow {
	draftUid += 1;

	return {
		uid: draftUid,
		key: '',
		value: '',
		original: null,
		originalValue: '',
		removed: false
	};
}

/** A tag map as editable rows, in key order. */
export function draftRows(tags: TagMap): TagDraftRow[] {
	return tagEntries(tags).map((entry) => ({
		...blankTagRow(),
		key: entry.key,
		value: entry.value,
		original: entry.key,
		originalValue: entry.value
	}));
}

/** Whether a row is untouched blank space, which saving ignores rather than refuses. */
export function isBlankRow(row: { key: string; value: string }): boolean {
	return row.key.trim() === '' && row.value.trim() === '';
}

/** Where a row stands: added, changed, marked for removal, untouched or blank. */
export function rowState(row: TagEditorRow): TagRowState {
	if (row.removed) {
		return 'removed';
	}

	if (row.original === null) {
		return isBlankRow(row)
			? 'blank'
			: 'new';
	}

	if (row.key.trim() !== row.original) {
		return 'changed';
	}

	if (row.mixed) {
		return row.edited
			? 'changed'
			: 'same';
	}

	return row.value.trim() !== row.originalValue
		? 'changed'
		: 'same';
}

/** Put a row back as it was opened; only for a row with an `original`. */
export function revertRow(row: TagEditorRow): void {
	row.key = row.original ?? row.key;
	row.value = row.originalValue;
	row.removed = false;

	if (row.mixed) {
		row.edited = false;
	}
}

/** How many rows would add, change and remove a tag. */
export function changeCounts(rows: TagEditorRow[]): { add: number; change: number; remove: number } {
	const counts = { add: 0, change: 0, remove: 0 };

	for (const row of rows) {
		const state = rowState(row);

		if (state === 'new') {
			counts.add += 1;
		} else if (state === 'changed') {
			counts.change += 1;
		} else if (state === 'removed') {
			counts.remove += 1;
		}
	}

	return counts;
}

/**
 * The rows measured against the record after a save that landed in part: what
 * was written loses its mark, what was not keeps it. A removed row whose key is
 * gone is dropped; a key of the record no row stands for is appended.
 */
export function rebaseRows(rows: TagDraftRow[], tags: TagMap): TagDraftRow[] {
	const out: TagDraftRow[] = [];

	for (const row of rows) {
		const key = row.key.trim();
		let original: string | null = null;

		if (row.original !== null && row.original in tags) {
			original = row.original;
		} else if (key in tags) {
			original = key;
		}

		if (original === null && row.removed) {
			continue;
		}

		out.push({
			...row,
			original,
			originalValue: original === null
				? ''
				: tags[original] ?? '',
			removed: original === null
				? false
				: row.removed
		});
	}

	// a key counts as represented by the row opened with it, or by a live row now carrying it
	const represented = new Set<string>();

	for (const row of out) {
		if (row.original !== null) {
			represented.add(row.original);
		}

		if (!row.removed && !isBlankRow(row)) {
			represented.add(row.key.trim());
		}
	}

	for (const entry of tagEntries(tags)) {
		if (represented.has(entry.key)) {
			continue;
		}

		out.push({
			...blankTagRow(),
			key: entry.key,
			value: entry.value,
			original: entry.key,
			originalValue: entry.value
		});
	}

	return out;
}

/**
 * Keys that differ from another row's only in case (`Env` beside `env`), per
 * row uid: the other key. Only valid keys typed once count, so a row already
 * showing a fault gets no second remark.
 */
export function caseTwins(rows: TagDraftRow[]): Record<number, string> {
	const out: Record<number, string> = {};
	const live = rows.filter((row) => !row.removed && !isBlankRow(row));
	const counts = new Map<string, number>();

	for (const row of live) {
		const key = row.key.trim();

		counts.set(key, (counts.get(key) ?? 0) + 1);
	}

	for (const row of live) {
		const key = row.key.trim();

		if (tagKeyFault(key) || (counts.get(key) ?? 0) > 1) {
			continue;
		}

		const folded = key.toLowerCase();
		const twin = live.find((other) => {
			const otherKey = other.key.trim();

			return other.uid !== row.uid && otherKey !== key && otherKey.toLowerCase() === folded;
		});

		if (twin) {
			out[row.uid] = twin.key.trim();
		}
	}

	return out;
}

/**
 * Tags pasted as lines of `key=value` or two spreadsheet columns, or null when
 * the text is a single plain line (an ordinary paste into the field). A line
 * splits at its first tab, else its first `=`, else is a key alone.
 */
export function parsePastedTags(text: string): TagEntry[] | null {
	if (!/[\n\t]/.test(text)) {
		return null;
	}

	const out: TagEntry[] = [];

	for (const line of text.split(/\r?\n/)) {
		if (line.trim() === '') {
			continue;
		}

		const tab = line.indexOf('\t');
		const eq = line.indexOf('=');
		const at = tab >= 0
			? tab
			: eq;

		if (at < 0) {
			out.push({ key: line.trim(), value: '' });

			continue;
		}

		out.push({
			key: line.slice(0, at).trim(),
			value: line.slice(at + 1).trim()
		});
	}

	return out.length > 0
		? out
		: null;
}

/** The fault of one key, or undefined when it is a valid tag key. */
export function tagKeyFault(key: string): string | undefined {
	if (key === '') {
		return 'web.tagEditor.keyRequired';
	}

	if (!TAG_KEY_PATTERN.test(key)) {
		return 'web.tagEditor.badKey';
	}

	if (key.toLowerCase().startsWith('luna:')) {
		return 'web.tagEditor.reservedKey';
	}

	return undefined;
}

/** The fault of one value, or undefined when it is a valid tag value. */
export function tagValueFault(value: string): string | undefined {
	return TAG_VALUE_PATTERN.test(value)
		? undefined
		: 'web.tagEditor.badValue';
}

/**
 * Per-row faults of a set of rows: the patterns the daemon enforces, plus a key
 * typed twice. `skipValue` names rows whose value is not being written (a bulk
 * row still showing "multiple values").
 */
export function draftFaults(
	rows: Array<{ uid: number; key: string; value: string; removed?: boolean }>,
	skipValue: (uid: number) => boolean = () => false
): Record<number, TagRowFault> {
	const out: Record<number, TagRowFault> = {};
	const seen = new Map<string, number>();

	for (const row of rows) {
		if (row.removed || isBlankRow(row)) {
			continue;
		}

		const key = row.key.trim();
		const fault: TagRowFault = {};
		const keyFault = tagKeyFault(key);

		if (keyFault) {
			fault.key = keyFault;
		} else if (seen.has(key)) {
			fault.key = 'web.tagEditor.duplicateKey';
		}

		seen.set(key, row.uid);

		if (!skipValue(row.uid)) {
			const valueFault = tagValueFault(row.value.trim());

			if (valueFault) {
				fault.value = valueFault;
			}
		}

		if (fault.key || fault.value) {
			out[row.uid] = fault;
		}
	}

	return out;
}

/** The rows as a tag map, trimmed, blank rows and rows marked for removal left out. */
export function draftTags(rows: TagDraftRow[]): TagMap {
	const out: TagMap = {};

	for (const row of rows) {
		if (!row.removed && !isBlankRow(row)) {
			out[row.key.trim()] = row.value.trim();
		}
	}

	return out;
}

/** What turning one tag map into another takes: keys to set and keys to remove. */
export interface TagDiff {
	set: TagMap;
	remove: string[];
}

/** The writes that take `before` to `after`; a renamed key is a remove plus a set. */
export function diffTags(before: TagMap, after: TagMap): TagDiff {
	const set: TagMap = {};
	const remove: string[] = [];

	for (const [key, value] of Object.entries(after)) {
		if (before[key] !== value) {
			set[key] = value;
		}
	}

	for (const key of Object.keys(before)) {
		if (!(key in after)) {
			remove.push(key);
		}
	}

	return { set, remove: remove.sort((a, b) => a.localeCompare(b)) };
}

/** Whether a diff changes anything. */
export function diffIsEmpty(diff: TagDiff): boolean {
	return Object.keys(diff.set).length === 0 && diff.remove.length === 0;
}

/**
 * One row of the bulk editor. `original` is the key the row started as (null
 * for a row the operator added); `mixed` says the selected resources disagree
 * on it (different values, or only some carry it), and until `edited` such a
 * row leaves every resource's own value alone.
 */
export interface BulkTagRow extends TagDraftRow {
	mixed: boolean;
	edited: boolean;
	/** each distinct value across the selection (null: resources without the key), most common first */
	spread: Array<{ value: string | null; count: number }>;
}

/** One change the bulk editor would make to one resource. */
export interface TagChange {
	key: string;
	kind: 'add' | 'change' | 'remove';
	from?: string;
	to?: string;
}

/** The rows the bulk editor opens with: every key across the selection. */
export function bulkRows(selection: Array<{ tags: TagMap }>): BulkTagRow[] {
	const keys = new Set<string>();

	for (const item of selection) {
		for (const key of Object.keys(item.tags)) {
			keys.add(key);
		}
	}

	return [...keys]
		.sort((a, b) => a.localeCompare(b))
		.map((key) => {
			const carriers = selection.filter((item) => key in item.tags);
			const values = new Set(carriers.map((item) => item.tags[key]));
			const mixed = values.size > 1 || carriers.length < selection.length;
			const first = selection[0]?.tags[key] ?? '';
			const shared = mixed
				? ''
				: first;

			return {
				...blankTagRow(),
				key,
				value: shared,
				original: key,
				originalValue: shared,
				mixed,
				edited: false,
				spread: spreadOf(selection, key)
			};
		});
}

/** How one key's values spread across the selection, most common first. */
function spreadOf(selection: Array<{ tags: TagMap }>, key: string): BulkTagRow['spread'] {
	const counts = new Map<string | null, number>();

	for (const item of selection) {
		const value = key in item.tags
			? item.tags[key] ?? ''
			: null;

		counts.set(value, (counts.get(value) ?? 0) + 1);
	}

	return [...counts.entries()]
		.map(([value, count]) => ({ value, count }))
		.sort((a, b) => b.count - a.count);
}

/** A blank row the operator added to the bulk editor. */
export function blankBulkRow(): BulkTagRow {
	return {
		...blankTagRow(),
		mixed: false,
		edited: true,
		spread: []
	};
}

/** One resource's tags after the bulk editor's rows are applied to them. */
export function applyBulkRows(tags: TagMap, rows: BulkTagRow[]): TagMap {
	const after: TagMap = { ...tags };
	const removed = rows.flatMap((row) => (
		row.removed && row.original !== null
			? [row.original]
			: []
	));

	for (const key of removed) {
		delete after[key];
	}

	for (const row of rows) {
		if (row.removed || isBlankRow(row)) {
			continue;
		}

		const key = row.key.trim();
		const value = row.value.trim();
		const keeps = row.mixed && !row.edited;

		if (row.original !== null && row.original !== key) {
			const own = after[row.original];

			delete after[row.original];

			if (!keeps) {
				after[key] = value;
			} else if (own !== undefined) {
				after[key] = own;
			}

			continue;
		}

		if (!keeps) {
			after[key] = value;
		}
	}

	return after;
}

/** The changes a diff makes, as review lines. */
export function changesOf(before: TagMap, diff: TagDiff): TagChange[] {
	const out: TagChange[] = [];

	for (const key of Object.keys(diff.set).sort((a, b) => a.localeCompare(b))) {
		out.push(
			key in before
				? { key, kind: 'change', from: before[key], to: diff.set[key] }
				: { key, kind: 'add', to: diff.set[key] }
		);
	}

	for (const key of diff.remove) {
		out.push({ key, kind: 'remove', from: before[key] });
	}

	return out;
}
