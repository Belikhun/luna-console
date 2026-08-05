// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';
import * as luna from '$core/services/luna';

/** GET ?type=&limit=&offset= → a page of the player's chat/command log. */
export async function GET({ params, url }) {
	const type = url.searchParams.get('type');

	const result = await luna.playerChat(params.player, {
		...(type === 'chat' || type === 'command' ? { type } : {}),
		limit: Number(url.searchParams.get('limit') ?? 25),
		offset: Number(url.searchParams.get('offset') ?? 0)
	});

	if (!result.ok) {
		return json({ available: false, error: result.error ?? 'unknown error' });
	}

	return json({ available: true, ...result.data });
}
