// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import * as luna from '$core/services/luna';
import { pushEvent } from '$lib/server/luna';

/**
 * POST { channel, target? } → put a connected player in a chat channel.
 *
 * The channel is luna-messenger's state on the proxy, which changes it and tells
 * the player in game. `target` names the other player of a direct channel. The
 * answer is LunaCore's: the channel before and after, or its refusal (the player
 * or the recipient is not connected, the proxy runs no chat router).
 */
export async function POST({ params, request, locals }) {
	const body = await request.json();
	const channel = String(body.channel ?? '').trim().toLowerCase();
	const target = String(body.target ?? '').trim();

	if (channel !== 'network' && channel !== 'server' && channel !== 'direct') {
		throw error(400, 'channel must be network, server or direct');
	}

	if (channel === 'direct' && !target) {
		throw error(400, 'target is required for a direct channel');
	}

	const result = await luna.setChatChannel(
		params.player,
		channel,
		channel === 'direct' ? target : '',
		locals.account?.username ?? ''
	);

	if (!result.ok) {
		// 404 with no player in the message is a LunaCore build without the route
		const missingRoute = result.status === 404 && !/not connected/.test(result.error ?? '');

		return json({
			ok: false,
			supported: !missingRoute,
			error: missingRoute
				? 'the proxy\'s LunaCore build cannot set chat channels yet'
				: result.error ?? 'unknown error'
		});
	}

	if (result.data?.changed) {
		const where = channel === 'direct'
			? `a direct message with ${result.data.channel?.targetName ?? target}`
			: `the ${channel} channel`;

		pushEvent('proxy', 'action', `${result.data.username} put in ${where} from the console`);
	}

	return json({ ok: true, ...result.data });
}
