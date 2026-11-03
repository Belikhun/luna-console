// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { jsonBody } from '$lib/server/http';
import { journal } from '$lib/server/session';
import { decideCall } from '$lib/server/agent/runner';
import type { AgentAnswers } from '$lib/server/agent/runner';

/** The longest answer an operator can type into a question. */
const MAX_ANSWER = 2000;

/** The `answers` field as question → answer strings, or undefined when it is absent or malformed. */
function readAnswers(value: unknown): AgentAnswers | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}

	const answers: AgentAnswers = {};

	for (const [question, answer] of Object.entries(value)) {
		if (typeof answer !== 'string' || !answer.trim()) {
			return undefined;
		}

		answers[question] = answer.trim().slice(0, MAX_ANSWER);
	}

	return Object.keys(answers).length > 0
		? answers
		: undefined;
}

/** The longest reason an operator can give for a denial. */
const MAX_REASON = 500;

/**
 * POST { toolUseId, allow, answers?, always?, reason? } → { ok }. Only the
 * account whose run made the call can decide it, since it runs on their
 * authority. `answers` answers a question the agent asked, `always` stops this
 * tool asking again in this conversation for them, and `reason` tells the
 * agent why a call was denied.
 */
export async function POST({ params, request, locals }) {
	if (!locals.account) {
		throw error(401, 'sign in first');
	}

	const body = await jsonBody(request);
	const allow = body.allow === true;
	const toolUseId = String(body.toolUseId ?? '');
	const actor = locals.account.username;
	const answers = readAnswers(body.answers);

	const reason = typeof body.reason === 'string' && body.reason.trim()
		? body.reason.trim().slice(0, MAX_REASON)
		: undefined;
	const always = allow && body.always === true;

	if (!decideCall(params.id, actor, toolUseId, allow, { answers, always, reason })) {
		throw error(404, 'nothing is waiting for that decision');
	}

	const verb = answers
		? 'answered a Mèo Béo question'
		: `${allow ? (always ? 'allowed for the conversation' : 'approved') : 'denied'} a Mèo Béo tool call`;

	journal(verb, {
		actor,
		detail: `${params.id} · ${String(body.tool ?? toolUseId)}${reason ? ` · ${reason}` : ''}`
	});

	return json({ ok: true });
}
