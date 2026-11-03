// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import {
	flagAgentConversation,
	getAgentConversation,
	leaveAgentConversation,
	removeAgentConversation,
	renameAgentConversation,
	setAgentAllowedTools
} from '$core/agent';
import type { AgentConversationView } from '$core/agent';
import { errorMessage, jsonBody } from '$lib/server/http';
import { dropWaiting, runActor, stopRun } from '$lib/server/agent/runner';
import { forgetConversation } from '$lib/server/agent/background';
import { conversationViewers } from '$lib/server/agent/presence';
import { conversationFor, conversationPeople, redactEntries } from '$lib/server/agent/sharing';

/** GET → the conversation and its saved transcript, as the caller's role may see it. */
export async function GET({ params, locals }) {
	const { account } = await conversationFor(locals, params.id);
	const conversation = await getAgentConversation(params.id, account);

	if (!conversation) {
		throw error(404, 'no such conversation');
	}

	const entries = await redactEntries(conversation.entries, account, conversation);
	const actor = runActor(params.id);

	return json({
		conversation: { ...conversation, entries },
		running: actor !== null,
		actor,
		viewers: conversationViewers(params.id),
		people: await conversationPeople(conversation, conversation.entries)
	});
}

/**
 * PATCH { title?, pinned?, archived?, allowedTools? } → the conversation. A
 * title and the tools allowed here take a writer; pins and archiving are the
 * caller's own list and anyone who can open the conversation may set them.
 */
export async function PATCH({ params, request, locals }) {
	const { account } = await conversationFor(locals, params.id);
	const body = await jsonBody(request);
	let conversation: AgentConversationView | undefined;

	try {
		if (typeof body.title === 'string') {
			conversation = await renameAgentConversation(params.id, account, body.title);
		}

		if (typeof body.pinned === 'boolean' || typeof body.archived === 'boolean') {
			conversation = await flagAgentConversation(params.id, account, {
				...(typeof body.pinned === 'boolean' ? { pinned: body.pinned } : {}),
				...(typeof body.archived === 'boolean' ? { archived: body.archived } : {})
			});
		}

		if (Array.isArray(body.allowedTools)) {
			conversation = await setAgentAllowedTools(params.id, account, body.allowedTools.map(String));
		}
	} catch (err) {
		throw error(400, errorMessage(err));
	}

	return json({ conversation });
}

/**
 * DELETE → { removed } or { left }. The owner deletes the conversation for
 * everyone it was shared with, stopping a run that is going; anyone else only
 * takes it off their own list.
 */
export async function DELETE({ params, locals }) {
	const { account, conversation } = await conversationFor(locals, params.id);

	try {
		if (conversation.role !== 'owner') {
			await leaveAgentConversation(params.id, account);

			return json({ left: true });
		}

		stopRun(params.id, account);
		dropWaiting(params.id);
		await removeAgentConversation(params.id, account);
		forgetConversation(params.id);

		return json({ removed: true });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
