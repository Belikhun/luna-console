// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { createAgentConversation, listAgentConversations } from '$core/agent';
import { errorMessage, jsonBody } from '$lib/server/http';
import { runActor } from '$lib/server/agent/runner';
import { conversationViewers } from '$lib/server/agent/presence';

/**
 * The conversations the signed-in account may open: its own, and those other
 * accounts shared with it. Nobody lists anybody else's otherwise: a
 * conversation can hold what its owner asked about, and the MCP call log
 * already records every action taken on anyone's behalf.
 */

function account(locals: App.Locals): string {
	if (!locals.account) {
		throw error(401, 'sign in first');
	}

	return locals.account.username;
}

/** GET → conversations, newest first, each with whether a run goes, as whom, and who has it open. */
export async function GET({ locals }) {
	const conversations = await listAgentConversations(account(locals));

	return json({
		conversations: conversations.map((conversation) => {
			const actor = runActor(conversation.id);

			return {
				...conversation,
				running: actor !== null,
				actor,
				viewers: conversationViewers(conversation.id)
			};
		})
	});
}

/** POST { title? } → a new, empty conversation. */
export async function POST({ request, locals }) {
	const body = await jsonBody(request);

	try {
		return json({ conversation: await createAgentConversation(account(locals), String(body.title ?? '')) });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
