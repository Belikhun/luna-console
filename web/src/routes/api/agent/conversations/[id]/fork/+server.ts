// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { forkAgentConversation } from '$core/agent';
import { errorMessage, jsonBody } from '$lib/server/http';
import { requireRole } from '$lib/server/agent/sharing';

/**
 * POST { before? } → { conversation }: branch this conversation into a new one
 * the caller owns, keeping what came before the message `before` (its uuid)
 * names, or all of it when omitted. The new one's first answer resumes the session at that point,
 * so the agent remembers exactly what the copy shows. Only the owner may: a
 * branch hands the model the whole history, including tool results someone it
 * was shared with was not shown.
 */
export async function POST({ params, request, locals }) {
	const { account } = await requireRole(locals, params.id, ['owner']);
	const body = await jsonBody(request);
	const before = typeof body.before === 'string' && body.before
		? body.before.slice(0, 64)
		: undefined;

	try {
		return json({ conversation: await forkAgentConversation(params.id, account, before) });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
