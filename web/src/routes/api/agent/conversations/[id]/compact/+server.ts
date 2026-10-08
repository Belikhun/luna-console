// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { ensureConnected } from '$client/socket';
import { errorMessage, jsonBody } from '$lib/server/http';
import { loopbackOrigin } from '$lib/server/agent/origin';
import { AgentRunError, MAX_COMPACT_FOCUS, startRun } from '$lib/server/agent/runner';
import { DEFAULT_AGENT_MODE, isAgentMode } from '$shared/agent';

/**
 * POST { focus?, locale?, mode?, model?, effort? } → { ok, joined }: summarise the conversation's
 * history, as `/compact` does in Claude Code. `focus` says what the summary
 * should keep. With a run going it waits its turn in that run's queue; with
 * none it starts one that only compacts. The outcome arrives on the stream as
 * a `compact` event, or as an error when the session could not do it.
 */
export async function POST({ params, request, url, locals }) {
	if (!locals.account) {
		throw error(401, 'sign in first');
	}

	const body = await jsonBody(request);
	const focus = String(body.focus ?? '').trim();

	if (focus.length > MAX_COMPACT_FOCUS) {
		throw error(400, `a compaction focus is limited to ${MAX_COMPACT_FOCUS} characters`);
	}

	const info = await ensureConnected();
	const mode = isAgentMode(body.mode)
		? body.mode
		: DEFAULT_AGENT_MODE;

	try {
		const joined = await startRun({
			conversationId: params.id,
			owner: locals.account.username,
			text: focus,
			locale: body.locale === 'vi' ? 'Vietnamese' : 'English',
			origin: loopbackOrigin(url),
			machine: info.name,
			mode,
			model: typeof body.model === 'string' ? body.model.trim() : undefined,
			effort: typeof body.effort === 'string' ? body.effort : undefined,
			compact: true
		});

		return json({ ok: true, joined });
	} catch (err) {
		const code = err instanceof AgentRunError
			? err.code
			: undefined;

		return json({ ok: false, code, error: errorMessage(err) }, { status: 409 });
	}
}
