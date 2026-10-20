// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { MAX_TAGS, TAG_KEY_PATTERN, TAG_VALUE_PATTERN } from '$shared/iam/resources';

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

/**
 * Why a tag could not be added, as a language key, or null when it can. The
 * daemon validates again; this is what lets the form say so before the round
 * trip.
 */
export function tagAddFault(key: string, value: string, existing: TagMap, max: number = MAX_TAGS): string | null {
	if (key === '') {
		return 'web.tagEditor.keyRequired';
	}

	if (!TAG_KEY_PATTERN.test(key)) {
		return 'web.tagEditor.badKey';
	}

	if (key.toLowerCase().startsWith('luna:')) {
		return 'web.tagEditor.reservedKey';
	}

	if (!TAG_VALUE_PATTERN.test(value)) {
		return 'web.tagEditor.badValue';
	}

	const replaces = key in existing;

	if (!replaces && Object.keys(existing).length >= max) {
		return 'web.tagEditor.tooMany';
	}

	return null;
}

/** One editable row of the tag editor; `uid` keys it while its key is being typed. */
export interface TagDraftRow {
	uid: number;
	key: string;
	value: string;
}

/** What the row editor reads of a row; the bulk editor's rows add the `mixed` state. */
export interface TagEditorRow extends TagDraftRow {
	mixed?: boolean;
	edited?: boolean;
}

/** What is wrong with one row, as language keys, per field. */
export interface TagRowFault {
	key?: string;
	value?: string;
}

let draftUid = 0;

/** A fresh, empty row. */
export function blankTagRow(): TagDraftRow {
	draftUid += 1;

	return { uid: draftUid, key: '', value: '' };
}

/** A tag map as editable rows, in key order. */
export function draftRows(tags: TagMap): TagDraftRow[] {
	return tagEntries(tags).map((entry) => ({ ...blankTagRow(), key: entry.key, value: entry.value }));
}

/** Whether a row is untouched blank space, which saving ignores rather than refuses. */
export function isBlankRow(row: { key: string; value: string }): boolean {
	return row.key.trim() === '' && row.value.trim() === '';
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
	rows: Array<{ uid: number; key: string; value: string }>,
	skipValue: (uid: number) => boolean = () => false
): Record<number, TagRowFault> {
	const out: Record<number, TagRowFault> = {};
	const seen = new Map<string, number>();

	for (const row of rows) {
		if (isBlankRow(row)) {
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

/** The rows as a tag map, trimmed, blank rows left out. */
export function draftTags(rows: TagDraftRow[]): TagMap {
	const out: TagMap = {};

	for (const row of rows) {
		if (!isBlankRow(row)) {
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
	original: string | null;
	mixed: boolean;
	edited: boolean;
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

			return {
				...blankTagRow(),
				key,
				value: mixed ? '' : first,
				original: key,
				mixed,
				edited: false
			};
		});
}

/** A blank row the operator added to the bulk editor. */
export function blankBulkRow(): BulkTagRow {
	return { ...blankTagRow(), original: null, mixed: false, edited: true };
}

/** One resource's tags after the bulk editor's rows are applied to them. */
export function applyBulkRows(tags: TagMap, rows: BulkTagRow[], removed: string[]): TagMap {
	const after: TagMap = { ...tags };

	for (const key of removed) {
		delete after[key];
	}

	for (const row of rows) {
		if (isBlankRow(row)) {
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
