// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { jsonBody } from '$lib/server/http';
import { journal } from '$lib/server/session';
import { decideCall } from '$lib/server/agent/runner';

/** POST { toolUseId, allow } → { ok }. Only the conversation's owner can decide its calls. */
export async function POST({ params, request, locals }) {
	if (!locals.account) {
		throw error(401, 'sign in first');
	}

	const body = await jsonBody(request);
	const allow = body.allow === true;
	const toolUseId = String(body.toolUseId ?? '');
	const actor = locals.account.username;

	if (!decideCall(params.id, actor, toolUseId, allow)) {
		throw error(404, 'nothing is waiting for that decision');
	}

	journal(`${allow ? 'approved' : 'denied'} a Mèo Béo tool call`, {
		actor,
		detail: `${params.id} · ${String(body.tool ?? toolUseId)}`
	});

	return json({ ok: true });
}
