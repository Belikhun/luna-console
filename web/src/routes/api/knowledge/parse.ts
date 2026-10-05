// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import type { KnowledgeInput, KnowledgeScope } from '$core/mcp';

/** A knowledge item's editable fields from a request body; core validates the values. */
export function parseKnowledge(body: Record<string, unknown>): Omit<KnowledgeInput, 'kind'> {
	const scope: KnowledgeScope | undefined = typeof body.scope === 'string'
		? (body.scope === 'console' || body.scope === ''
			? { kind: 'console' }
			: { kind: 'token', token: body.scope })
		: undefined;

	return {
		title: String(body.title ?? ''),
		body: String(body.body ?? ''),
		description: typeof body.description === 'string' ? body.description : undefined,
		tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
		pinned: typeof body.pinned === 'boolean' ? body.pinned : undefined,
		enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
		scope,
		expiresAt: typeof body.expiresAt === 'number' ? body.expiresAt : null
	};
}
