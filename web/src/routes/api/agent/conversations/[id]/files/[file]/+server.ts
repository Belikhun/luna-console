// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { error } from '@sveltejs/kit';

import { agentSharedFilePath, getAgentConversation } from '$core/agent';
import type { AgentSharedFile } from '$core/agent';
import { liveSharedFile } from '$lib/server/agent/runner';
import { conversationFor } from '$lib/server/agent/sharing';

/**
 * GET [?inline=1] → a file Mèo Béo shared from its scratch folder, as a
 * download, or shown in place for the chat's own picture viewer. Anyone
 * who can open the conversation may take it, as they read the agent's replies;
 * a server's file is never served here, since the chat links those to the
 * instance's own file route, which checks the reader's permissions.
 */
export async function GET({ params, locals, url }) {
	const { account } = await conversationFor(locals, params.id);
	const saved = await getAgentConversation(params.id, account);
	let file: AgentSharedFile | null = null;

	for (const entry of saved?.entries ?? []) {
		const found = entry.kind === 'tool'
			? entry.files?.find((item) => item.id === params.file && !item.instance)
			: undefined;

		if (found) {
			file = found;
			break;
		}
	}

	file ??= liveSharedFile(params.id, params.file);

	if (!file) {
		throw error(404, 'no such file');
	}

	const path = await agentSharedFilePath(params.id, account, file.id, file.name).catch(() => null);
	const body = path ? Bun.file(path) : null;

	if (!body || !(await body.exists())) {
		throw error(404, 'no such file');
	}

	// the name as typed for browsers that read it, and an ASCII stand-in for the rest
	const ascii = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');

	return new Response(body, {
		headers: {
			'content-type': body.type || 'application/octet-stream',
			'content-length': String(body.size),
			'content-disposition': `${url.searchParams.has('inline') ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
			'cache-control': 'private, max-age=31536000, immutable'
		}
	});
}
