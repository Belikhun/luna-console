// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import { resendResourcePacks } from '$core/respacks';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';
import type { RespackResendScope } from '$core/respacks';

/**
 * POST { scope?, players? } -> re-offer resource packs to players.
 *
 * The pack in the path narrows *who* is picked (who failed it, who is missing
 * it); what a picked player receives is their whole applicable set, because
 * that is the only thing luna-pack's resend does.
 */
export async function POST({ params, request }) {
	const body = await request.json();
	const players = Array.isArray(body.players) ? body.players.map((name: unknown) => String(name)) : [];
	const scope = body.scope ? (String(body.scope) as RespackResendScope) : undefined;

	try {
		const result = await resendResourcePacks({
			pack: params.key,
			players,
			scope
		});

		if (result.sent) {
			pushEvent(
				'packs',
				'action',
				`resource packs resent to ${result.sent} player(s) from ${params.key}`
			);
		}

		return json({ ok: true, ...result });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
