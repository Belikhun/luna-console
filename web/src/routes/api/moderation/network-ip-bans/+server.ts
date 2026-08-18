// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import * as luna from '$core/services/luna';
import { pushEvent } from '$lib/server/luna';

/**
 * Network-level IP bans: enforced by the proxy at pre-login, so a banned
 * address never reaches a backend, the player directory or the chat relay.
 * LunaCore records each change in the moderation log itself.
 */

/** GET → every address the proxy refuses, newest first. */
export async function GET() {
	try {
		const result = await luna.networkIpBans();

		if (!result.ok) {
			return json({ available: false, error: result.error ?? 'unknown error' });
		}

		return json({ available: true, ...result.data });
	} catch (err) {
		// a daemon predating the lunaApi.networkIpBans op rejects the RPC itself
		return json({ available: false, error: (err as Error).message });
	}
}

interface NetworkBanOutcome {
	ip: string;
	ok: boolean;
	error?: string;
}

/** POST { action: add|remove, ips[], reason? } → change bans, one outcome per address. */
export async function POST({ request }) {
	const body = await request.json();
	const action = String(body.action ?? '');
	const reason = String(body.reason ?? '');
	const ips: string[] = Array.isArray(body.ips)
		? body.ips.map(String).filter((ip: string) => ip.trim().length > 0)
		: [];

	if (action !== 'add' && action !== 'remove') {
		throw error(400, 'action must be add or remove');
	}

	if (ips.length === 0) {
		throw error(400, 'ips is required');
	}

	const outcomes: NetworkBanOutcome[] = [];

	for (const ip of ips) {
		try {
			const result = action === 'add'
				? await luna.addNetworkIpBan(ip, { reason, actor: 'console' })
				: await luna.removeNetworkIpBan(ip, { actor: 'console' });

			outcomes.push({
				ip,
				ok: result.ok,
				...(result.ok ? {} : { error: result.error ?? 'change failed' })
			});
		} catch (err) {
			outcomes.push({ ip, ok: false, error: (err as Error).message });
		}
	}

	const okCount = outcomes.filter((outcome) => outcome.ok).length;

	pushEvent(
		'proxy',
		'action',
		`network ip ${action === 'add' ? 'ban' : 'pardon'} applied to ${okCount}/${outcomes.length} address(es)`
	);

	return json({ ok: true, outcomes });
}
