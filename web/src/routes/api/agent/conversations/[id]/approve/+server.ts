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

/**
 * POST { toolUseId, allow, answers? } → { ok }. Only the conversation's owner
 * can decide its calls; `answers` answers a question the agent asked.
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

	if (!decideCall(params.id, actor, toolUseId, allow, answers)) {
		throw error(404, 'nothing is waiting for that decision');
	}

	const verb = answers
		? 'answered a Mèo Béo question'
		: `${allow ? 'approved' : 'denied'} a Mèo Béo tool call`;

	journal(verb, {
		actor,
		detail: `${params.id} · ${String(body.tool ?? toolUseId)}`
	});

	return json({ ok: true });
}
