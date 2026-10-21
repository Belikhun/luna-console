// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { error } from '@sveltejs/kit';

import { dfetch } from '$client/socket';
import { SSE_HEADERS } from '$lib/server/http';
import { scopeStream } from '$lib/server/fleetscope';

/**
 * GET → SSE stream of the whole fleet's health, piped through from the daemon.
 * The hub already holds every daemon's latest heartbeat sample, so the console
 * follows one stream instead of polling a row per machine.
 */
export async function GET({ request, locals }) {
	const upstream = await dfetch('/daemons/stream', { signal: request.signal });

	if (!upstream.ok || !upstream.body) {
		throw error(502, `daemon refused the fleet stream (${upstream.status})`);
	}

	// a machine's rows name every instance on it; an account sees only its own
	return new Response(scopeStream(locals.account?.username, upstream.body), { headers: SSE_HEADERS });
}
