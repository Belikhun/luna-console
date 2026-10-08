// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { errorMessage, jsonBody } from '$lib/server/http';
import { journal } from '$lib/server/session';
import { AgentRunError, updateRun } from '$lib/server/agent/runner';
import { isAgentMode } from '$shared/agent';

/**
 * PATCH { mode?, model?, effort? } → { updated }: change the conversation's run
 * while it goes. The mode applies from the agent's next tool call, the model and
 * effort from its next response. `updated` is false when nothing is running,
 * which is not an error: the picks still apply to the next message.
 */
export async function PATCH({ params, request, locals }) {
	if (!locals.account) {
		throw error(401, 'sign in first');
	}

	const body = await jsonBody(request);
	const actor = locals.account.username;
	const mode = isAgentMode(body.mode)
		? body.mode
		: undefined;

	let updated = false;

	try {
		updated = await updateRun(params.id, actor, {
			mode,
			model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined,
			effort: typeof body.effort === 'string' && body.effort ? body.effort : undefined
		});
	} catch (err) {
		const code = err instanceof AgentRunError
			? err.code
			: undefined;

		return json({ updated: false, code, error: errorMessage(err) }, { status: 409 });
	}

	// switching a running agent to bypass lets everything after it run unasked,
	// which is the same line in the journal a bypass message gets
	if (updated && mode === 'bypass') {
		journal(`Mèo Béo switched to bypass mode in ${params.id}`, { actor, level: 'warn' });
	}

	return json({ updated });
}
