// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { jsonBody } from '$lib/server/http';
import { deliverPanelAnswer } from '$lib/server/agent/runner';

/**
 * POST { request, ok, page, error? } → { ok }. The panel's answer to a
 * `navigate` event: where the operator's console landed. Only the
 * conversation's owner can answer, and only a request still waiting.
 */
export async function POST({ params, request, locals }) {
	if (!locals.account) {
		throw error(401, 'sign in first');
	}

	const body = await jsonBody(request);

	const delivered = deliverPanelAnswer(params.id, locals.account.username, String(body.request ?? ''), {
		ok: body.ok === true,
		page: String(body.page ?? '').slice(0, 500),
		...(body.error ? { error: String(body.error).slice(0, 500) } : {})
	});

	if (!delivered) {
		throw error(404, 'nothing is waiting for that navigation');
	}

	return json({ ok: true });
}
