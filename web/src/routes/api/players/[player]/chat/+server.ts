// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';
import * as luna from '$core/services/luna';
import { noteChatRead, readableChat } from '$lib/server/chataudit';

/** GET ?type=&server=&limit=&offset= → a page of the player's chat/command log. */
export async function GET({ params, url, locals }) {
	const type = url.searchParams.get('type');
	const server = url.searchParams.get('server') ?? '';

	const result = await luna.playerChat(params.player, {
		...(type === 'chat' || type === 'command' ? { type } : {}),
		...(server ? { server } : {}),
		limit: Number(url.searchParams.get('limit') ?? 25),
		offset: Number(url.searchParams.get('offset') ?? 0)
	});

	if (!result.ok) {
		return json({ available: false, error: result.error ?? 'unknown error' });
	}

	// the player's history spans servers; only lines from servers whose chat the
	// account may read are returned, and the read is journalled
	const all = result.data?.entries ?? [];
	const entries = await readableChat(locals.account?.username, all, (entry) => entry.server);
	const withheld = all.length - entries.length;

	noteChatRead(locals.account?.username, `chat history of ${params.player}`);

	return json({ available: true, ...result.data, entries, withheld });
}
