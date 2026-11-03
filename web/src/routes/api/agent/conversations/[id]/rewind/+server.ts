// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { rewindAgentConversation } from '$core/agent';
import { errorMessage, jsonBody } from '$lib/server/http';
import { journal } from '$lib/server/session';
import { isRunning } from '$lib/server/agent/runner';
import { requireRole } from '$lib/server/agent/sharing';

/**
 * POST { before } → { conversation }: drop the message `before` (its uuid)
 * names and everything after it, and have the next answer branch the session
 * from just before it, which is how "edit and resend" and "retry" work. Refused while a
 * run goes, since that run is still writing the part being dropped. What the
 * agent already did on the cluster stays done.
 */
export async function POST({ params, request, locals }) {
	const { account } = await requireRole(locals, params.id, ['owner', 'collaborator']);
	const body = await jsonBody(request);
	const before = String(body.before ?? '').slice(0, 64);

	if (!before) {
		throw error(400, 'name the message to rewind to (before)');
	}

	if (isRunning(params.id)) {
		return json({ ok: false, code: 'running', error: 'stop the answer that is running first' }, { status: 409 });
	}

	try {
		const conversation = await rewindAgentConversation(params.id, account, before);

		journal('rewound a Mèo Béo conversation', { actor: account, detail: `${params.id} · before ${before}` });

		return json({ ok: true, conversation });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
