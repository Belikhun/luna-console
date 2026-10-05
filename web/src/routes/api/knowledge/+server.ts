// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { createKnowledge, listKnowledge, listMcpTokens } from '$core/mcp';
import type { KnowledgeKind } from '$core/mcp';
import { errorMessage, jsonBody } from '$lib/server/http';
import { journal } from '$lib/server/session';
import { parseKnowledge } from './parse';

/** GET ?kind=&scope= → knowledge items, plus the tokens a scope can name. */
export async function GET({ url }) {
	const kind = url.searchParams.get('kind') as KnowledgeKind | null;
	const scope = url.searchParams.get('scope');

	const [items, tokens] = await Promise.all([
		listKnowledge({ kind: kind ?? undefined, scope: scope ?? undefined }),
		listMcpTokens()
	]);

	return json({ items, tokens: tokens.map((token) => ({ id: token.id, name: token.name })) });
}

/** POST { kind, title, body, description?, tags?, pinned?, enabled?, scope?, expiresAt? } → create. */
export async function POST({ request, locals }) {
	const body = await jsonBody(request);
	const actor = locals.account?.username;

	try {
		const input = parseKnowledge(body);
		const item = await createKnowledge({ ...input, kind: body.kind as KnowledgeKind }, actor);

		journal(`${item.kind} "${item.title}" created`, { actor });

		return json({ item });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
