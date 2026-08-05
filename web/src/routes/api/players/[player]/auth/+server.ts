// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import * as luna from '$core/services/luna';
import { pushEvent } from '$lib/server/luna';

/** GET → the player's authentication state, as luna-auth holds it. */
export async function GET({ params }) {
	const result = await luna.authAccount(params.player);

	if (!result.ok) {
		return json({ available: false, error: result.error ?? 'unknown error' });
	}

	return json({ available: true, ...result.data });
}

/**
 * POST { action, … } → administer the player's password.
 *
 * `temporary` accepts an optional password (the proxy generates one when it is
 * omitted) and `expiresInMinutes`; `password` requires one. The plaintext of a
 * generated password comes back in this response and nowhere else, so it is
 * deliberately not written to the event log; only the fact of the change is.
 */
export async function POST({ params, request }) {
	const body = await request.json();
	const action = String(body.action ?? '');

	if (
		action !== 'reset' &&
		action !== 'temporary' &&
		action !== 'password' &&
		action !== 'unlock' &&
		action !== 'logout'
	) {
		throw error(400, `unknown action: ${action}`);
	}

	const result = await luna.setAuth(params.player, {
		action,
		...(body.password ? { password: String(body.password) } : {}),
		...(body.expiresInMinutes ? { expiresInMinutes: Number(body.expiresInMinutes) } : {}),
		...(body.username ? { username: String(body.username) } : {}),
		actor: 'console'
	});

	if (result.ok) {
		pushEvent('proxy', 'action', `auth ${action} on ${params.player}`);
	}

	return json(result);
}
