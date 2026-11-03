// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { error } from '@sveltejs/kit';

import { agentImagePath, getAgentConversation } from '$core/agent';
import type { AgentEntry } from '$core/agent';
import { liveImageEntry } from '$lib/server/agent/runner';
import { conversationFor, toolVisibility } from '$lib/server/agent/sharing';

const TYPES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp'
};

/**
 * GET → an image a tool result carried (a screenshot, a picture the agent
 * read), for the chat to show beside the call. Whoever may see that call's
 * result may see its pictures, except a screenshot, which is its actor's own
 * screen; anyone else gets the same 404 as for a name that is not there.
 */
export async function GET({ params, locals }) {
	const { account, conversation } = await conversationFor(locals, params.id);
	const saved = await getAgentConversation(params.id, account);
	const entry = saved?.entries.find(
		(item): item is Extract<AgentEntry, { kind: 'tool' }> => item.kind === 'tool' && !!item.images?.includes(params.name)
	) ?? liveImageEntry(params.id, params.name);

	if (!entry) {
		throw error(404, 'no such image');
	}

	const seen = await toolVisibility(account, conversation)(entry.id, entry.name, entry.input, entry.actor);

	if (!seen.images) {
		throw error(404, 'no such image');
	}

	const path = await agentImagePath(params.id, account, params.name).catch(() => null);
	const file = path ? Bun.file(path) : null;

	if (!file || !(await file.exists())) {
		throw error(404, 'no such image');
	}

	const extension = params.name.slice(params.name.lastIndexOf('.') + 1);

	return new Response(file, {
		headers: {
			'content-type': TYPES[extension] ?? 'application/octet-stream',
			// a name is never reused for other bytes, so a browser may keep it
			'cache-control': 'private, max-age=31536000, immutable'
		}
	});
}
