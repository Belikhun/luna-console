// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import { resendResourcePacks } from '$core/respacks';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';
import type { RespackResendScope } from '$core/respacks';

/**
 * POST { players?, scope? } -> re-offer resource packs to players.
 *
 * The pack-agnostic form, for the screens that are about *people* rather than
 * about one pack: a player gets every pack that applies to them, which is the
 * only thing luna-pack's resend does anyway. The per-pack route under
 * `/respacks/<key>/resend` is the same call with the pack narrowing who is
 * picked.
 */
export async function POST({ request }) {
	const body = await request.json();
	const players = Array.isArray(body.players) ? body.players.map((name: unknown) => String(name)) : [];
	const scope = body.scope ? (String(body.scope) as RespackResendScope) : undefined;

	try {
		const result = await resendResourcePacks({ players, scope });

		if (result.sent) {
			pushEvent('packs', 'action', `resource packs resent to ${result.sent} player(s)`);
		}

		return json({ ok: true, ...result });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
