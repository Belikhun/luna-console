// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import * as luna from '$core/services/luna';
import { publicSnapshot } from '$lib/server/publicsnapshot';

/**
 * GET → who is on one listed server right now.
 *
 * Projected field by field rather than forwarded. The proxy's player list
 * carries each session's remote address, virtual host and protocol version,
 * none of which a visitor has any business seeing; an allowlist cannot leak the
 * one nobody remembered to strip.
 */
export async function GET({ params }) {
	const snapshot = await publicSnapshot();

	if (!snapshot?.instances.some((instance) => instance.name === params.instance)) {
		throw error(404, 'not found');
	}

	const result = await luna.players(params.instance);

	if (!result.ok || !result.data) {
		// the proxy being unreachable is not the visitor's problem; an empty list
		// reads as "nobody is on" rather than as a broken page
		return json({ players: [] });
	}

	return json({
		players: result.data.players.map((player) => ({
			uuid: player.uuid,
			username: player.username,
			sessionMillis: player.sessionMillis
		}))
	});
}
