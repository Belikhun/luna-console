// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { rotateMcpToken } from '$core/mcp';
import { errorMessage } from '$lib/server/http';
import { journal } from '$lib/server/session';

/** POST → a new bearer for the token, shown once; the old one stops working now. */
export async function POST({ params, locals }) {
	const actor = locals.account?.username;

	try {
		const rotated = await rotateMcpToken(params.id, actor);

		journal(`MCP token ${rotated.token.name} rotated`, { actor, level: 'warn' });

		return json(rotated);
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
