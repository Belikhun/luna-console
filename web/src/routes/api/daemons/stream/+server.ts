import { error } from '@sveltejs/kit';

import { dfetch } from '$client/socket';
import { SSE_HEADERS } from '$lib/server/http';

/**
 * GET → SSE stream of the whole fleet's health, piped through from the daemon.
 * The hub already holds every daemon's latest heartbeat sample, so the console
 * follows one stream instead of polling a row per machine.
 */
export async function GET({ request }) {
	const upstream = await dfetch('/daemons/stream', { signal: request.signal });

	if (!upstream.ok || !upstream.body) {
		throw error(502, `daemon refused the fleet stream (${upstream.status})`);
	}

	return new Response(upstream.body, { headers: SSE_HEADERS });
}
