// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { error } from '@sveltejs/kit';

import { publicSnapshot } from '$lib/server/publicsnapshot';
import { avatarResponse } from '$lib/server/avatars';

/**
 * GET /api/public/avatar/<kind>/<size>/<subject>.png → a rendered avatar.
 *
 * This is the endpoint other software points at: luna-messenger's Discord
 * webhooks, and anything else that needs a player's face as an image URL. It is
 * ungated for the same reason the public skin route is: a skin is public
 * information the game hands to every client in the lobby, and a Discord
 * embed's image is fetched by Discord, which carries no session.
 *
 * A shared cache may hold it, and should: an avatar's pixels only change when
 * the player changes their skin, and the ETag changes with it.
 */

export async function GET({ params, url, request }) {
	if (!(await publicSnapshot())) {
		throw error(404, 'not found');
	}

	return await avatarResponse(
		params.path,
		url.searchParams,
		'public, max-age=600',
		request.headers.get('if-none-match')
	);
}
