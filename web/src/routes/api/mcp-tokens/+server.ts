// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { createMcpToken, listMcpTokens, mcpAudit } from '$core/mcp';
import { errorMessage, jsonBody } from '$lib/server/http';
import { journal } from '$lib/server/session';
import { parseScope } from './scope';

/**
 * The MCP screen's token rows and audit trail, and minting a token.
 *
 * Every token here is already masked; `$core/mcp` has no bridge that returns a
 * digest. A new token answers with its bearer **once**, the only time it exists
 * outside the client that will hold it.
 */

/** GET → every token and the management audit trail, for one load. */
export async function GET({ url }) {
	const [tokens, audit] = await Promise.all([
		listMcpTokens(),
		mcpAudit({ limit: Number(url.searchParams.get('audit') ?? 300) })
	]);

	return json({ tokens, audit });
}

/** POST { name, description?, expiresAt?, scope? } → { token, bearer }. */
export async function POST({ request, locals }) {
	const body = await jsonBody(request);
	const actor = locals.account?.username;

	try {
		const created = await createMcpToken(
			{
				name: String(body.name ?? ''),
				description: body.description ? String(body.description) : undefined,
				expiresAt: typeof body.expiresAt === 'number' ? body.expiresAt : null,
				scope: parseScope(body.scope)
			},
			actor
		);

		journal(`MCP token ${created.token.name} created`, { actor, detail: created.token.tools.join(', ') });

		return json(created);
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
