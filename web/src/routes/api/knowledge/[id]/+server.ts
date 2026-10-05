// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { getKnowledge, listMcpTokens, removeKnowledge, updateKnowledge } from '$core/mcp';
import type { KnowledgePatch } from '$core/mcp';
import { errorMessage, jsonBody } from '$lib/server/http';
import { journal } from '$lib/server/session';
import { parseKnowledge } from '../parse';

/** GET → one knowledge item, plus the tokens a scope can name. */
export async function GET({ params }) {
	const [item, tokens] = await Promise.all([getKnowledge(params.id), listMcpTokens()]);

	if (!item) {
		throw error(404, `no knowledge item ${params.id}`);
	}

	return json({ item, tokens: tokens.map((token) => ({ id: token.id, name: token.name })) });
}

/** PATCH { title?, body?, description?, tags?, pinned?, enabled?, scope?, expiresAt? } → updated item. */
export async function PATCH({ params, request, locals }) {
	const body = await jsonBody(request);
	const actor = locals.account?.username;
	const parsed = parseKnowledge(body);

	// only the fields the body actually carries; a PATCH that omits the body must
	// not blank it
	const patch: KnowledgePatch = {};

	for (const key of Object.keys(parsed) as Array<keyof typeof parsed>) {
		if (key in body) {
			(patch as Record<string, unknown>)[key] = parsed[key];
		}
	}

	try {
		const item = await updateKnowledge(params.id, patch, actor);

		journal(`${item.kind} "${item.title}" updated`, { actor });

		return json({ item });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}

/** DELETE → remove it. */
export async function DELETE({ params, locals }) {
	const actor = locals.account?.username;

	try {
		const item = await removeKnowledge(params.id, actor);

		journal(`${item.kind} "${item.title}" removed`, { actor, level: 'warn' });

		return json({ item });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
