// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import type { KnowledgeItem, KnowledgeKind } from '$core/mcp';

/** The editable fields of a knowledge item, as the form holds them. */
export interface KnowledgeDraft {
	kind: KnowledgeKind;
	/** `"console"` or a token id */
	scope: string;
	title: string;
	description: string;
	/** Comma-separated, as typed */
	tags: string;
	body: string;
	pinned: boolean;
	enabled: boolean;
}

export function emptyDraft(kind: KnowledgeKind, scope = 'console'): KnowledgeDraft {
	return { kind, scope, title: '', description: '', tags: '', body: '', pinned: kind === 'context', enabled: true };
}

export function draftOf(item: KnowledgeItem): KnowledgeDraft {
	return {
		kind: item.kind,
		scope: item.scope.kind === 'console'
			? 'console'
			: item.scope.token,
		title: item.title,
		description: item.description,
		tags: item.tags.join(', '),
		body: item.body,
		pinned: item.pinned,
		enabled: item.enabled
	};
}

/** The request body a draft becomes. */
export function draftBody(draft: KnowledgeDraft): Record<string, unknown> {
	return {
		kind: draft.kind,
		scope: draft.scope,
		title: draft.title.trim(),
		description: draft.description.trim(),
		tags: draft.tags
			.split(',')
			.map((tag) => tag.trim())
			.filter((tag) => tag !== ''),
		body: draft.body,
		pinned: draft.pinned,
		enabled: draft.enabled
	};
}

/** Where an item's scope points, as one line. */
export function scopeName(item: KnowledgeItem, tokens: Array<{ id: string; name: string }>): string {
	if (item.scope.kind === 'console') {
		return '';
	}

	const tokenId = item.scope.token;

	return tokens.find((token) => token.id === tokenId)?.name ?? tokenId;
}
