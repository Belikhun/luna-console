// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';
import * as luna from '$core/services/luna';

/**
 * GET ?limit=&offset=&search=&action= → a page of the whole network's
 * moderation history, newest first. Answers { available: false } when the
 * proxy is down or runs a LunaCore build without the global log endpoint.
 */
export async function GET({ url }) {
	try {
		const result = await luna.moderationLog({
			search: url.searchParams.get('search') ?? '',
			action: url.searchParams.get('action') ?? '',
			limit: Number(url.searchParams.get('limit') ?? 100),
			offset: Number(url.searchParams.get('offset') ?? 0)
		});

		if (!result.ok) {
			return json({ available: false, error: result.error ?? 'unknown error' });
		}

		return json({ available: true, ...result.data });
	} catch (err) {
		// a daemon predating the lunaApi.moderationLog op rejects the RPC itself
		return json({ available: false, error: (err as Error).message });
	}
}
