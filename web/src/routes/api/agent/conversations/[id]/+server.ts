// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { getAgentConversation, removeAgentConversation, renameAgentConversation } from '$core/agent';
import { errorMessage, jsonBody } from '$lib/server/http';
import { isRunning, stopRun } from '$lib/server/agent/runner';

function owner(locals: App.Locals): string {
	if (!locals.account) {
		throw error(401, 'sign in first');
	}

	return locals.account.username;
}

/** GET → the conversation and its saved transcript. */
export async function GET({ params, locals }) {
	const conversation = await getAgentConversation(params.id, owner(locals));

	if (!conversation) {
		throw error(404, 'no such conversation');
	}

	return json({ conversation, running: isRunning(params.id) });
}

/** PATCH { title } → the renamed conversation. */
export async function PATCH({ params, request, locals }) {
	const body = await jsonBody(request);

	try {
		return json({ conversation: await renameAgentConversation(params.id, owner(locals), String(body.title ?? '')) });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}

/** DELETE → the removed conversation; a run still going is stopped first. */
export async function DELETE({ params, locals }) {
	const who = owner(locals);

	stopRun(params.id, who);

	try {
		return json({ conversation: await removeAgentConversation(params.id, who) });
	} catch (err) {
		throw error(404, errorMessage(err));
	}
}
