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
