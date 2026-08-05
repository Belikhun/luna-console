// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import * as luna from '$core/services/luna';
import { pushEvent } from '$lib/server/luna';

/** GET ?limit=&offset= → a page of the player's moderation history. */
export async function GET({ params, url }) {
	const result = await luna.playerModeration(params.player, {
		limit: Number(url.searchParams.get('limit') ?? 25),
		offset: Number(url.searchParams.get('offset') ?? 0)
	});

	if (!result.ok) {
		return json({ available: false, error: result.error ?? 'unknown error' });
	}

	return json({ available: true, ...result.data });
}

/** POST { action?, reason } → record a manual moderation note for the player. */
export async function POST({ params, request }) {
	const body = await request.json();
	const reason = String(body.reason ?? '').trim();

	if (!reason) {
		throw error(400, 'reason is required');
	}

	const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.player);

	const result = await luna.recordModeration({
		action: String(body.action ?? 'note'),
		...(isUuid ? { targetUuid: params.player } : { targetName: params.player }),
		actor: 'console',
		reason
	});

	if (result.ok) {
		pushEvent('proxy', 'action', `moderation note recorded for ${params.player}`);
	}

	return json(result);
}
