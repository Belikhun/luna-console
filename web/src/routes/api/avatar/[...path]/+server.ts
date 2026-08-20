// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { avatarResponse } from '$lib/server/avatars';

/**
 * GET /api/avatar/<kind>/<size>/<subject>.png → a rendered avatar.
 *
 * The console's own copy of the renderer, behind the session gate, so a page
 * can use a server-drawn avatar without the public site being involved. The
 * pixels and the caches are the same as the public endpoint's; what differs is
 * the gate and that the response is not offered to shared caches.
 */

export async function GET({ params, url, request }) {
	return await avatarResponse(
		params.path,
		url.searchParams,
		'private, max-age=300',
		request.headers.get('if-none-match')
	);
}
