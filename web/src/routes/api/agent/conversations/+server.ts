// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { createAgentConversation, listAgentConversations } from '$core/agent';
import { errorMessage, jsonBody } from '$lib/server/http';
import { isRunning } from '$lib/server/agent/runner';

/**
 * The signed-in account's own conversations with Mèo Béo. Nobody lists anybody
 * else's: a conversation can hold what its owner asked about, and the MCP call
 * log already records every action taken on anyone's behalf.
 */

function owner(locals: App.Locals): string {
	if (!locals.account) {
		throw error(401, 'sign in first');
	}

	return locals.account.username;
}

/** GET → conversations, newest first, each marked when a run is in progress. */
export async function GET({ locals }) {
	const conversations = await listAgentConversations(owner(locals));

	return json({
		conversations: conversations.map((conversation) => ({
			...conversation,
			running: isRunning(conversation.id)
		}))
	});
}

/** POST { title? } → a new, empty conversation. */
export async function POST({ request, locals }) {
	const body = await jsonBody(request);

	try {
		return json({ conversation: await createAgentConversation(owner(locals), String(body.title ?? '')) });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
