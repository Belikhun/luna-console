// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import {
	getMcpToken,
	listKnowledge,
	mcpAudit,
	readMcpCalls,
	removeMcpToken,
	setMcpTokenEnabled,
	updateMcpToken
} from '$core/mcp';
import { errorMessage, jsonBody } from '$lib/server/http';
import { journal } from '$lib/server/session';
import { parseScope } from '../scope';

/** GET → one token with its recent calls, its knowledge and its audit trail. */
export async function GET({ params }) {
	const token = await getMcpToken(params.id);

	if (!token) {
		throw error(404, `no MCP token named ${params.id}`);
	}

	const [calls, knowledge, audit] = await Promise.all([
		readMcpCalls({ token: token.id, limit: 500 }),
		listKnowledge({ scope: token.id }),
		mcpAudit({ token: token.id, limit: 300 })
	]);

	return json({ token, calls: calls.calls, callsTruncated: calls.truncated, knowledge, audit });
}

/** PATCH { name?, description?, expiresAt?, scope?, enabled? } → the updated token. */
export async function PATCH({ params, request, locals }) {
	const body = await jsonBody(request);
	const actor = locals.account?.username;

	try {
		let token = await updateMcpToken(
			params.id,
			{
				name: typeof body.name === 'string' ? body.name : undefined,
				description: typeof body.description === 'string' ? body.description : undefined,
				expiresAt: 'expiresAt' in body
					? (typeof body.expiresAt === 'number' ? body.expiresAt : null)
					: undefined,
				scope: parseScope(body.scope)
			},
			actor
		);

		if (typeof body.enabled === 'boolean' && body.enabled !== token.enabled) {
			token = await setMcpTokenEnabled(token.id, body.enabled, actor);

			journal(`MCP token ${token.name} ${body.enabled ? 'enabled' : 'disabled'}`, { actor });
		}

		return json({ token });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}

/** DELETE → remove the token and every knowledge item scoped to it. */
export async function DELETE({ params, locals }) {
	const actor = locals.account?.username;

	try {
		const result = await removeMcpToken(params.id, actor);

		journal(`MCP token ${result.removed.name} removed`, {
			actor,
			level: 'warn',
			detail: result.knowledgeRemoved > 0 ? `${result.knowledgeRemoved} knowledge item(s) removed with it` : undefined
		});

		return json(result);
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
