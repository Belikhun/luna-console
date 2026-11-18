// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';
import * as firewall from '$core/firewall';
import { clientIp } from '$lib/server/session';

/**
 * GET → the firewall's rules, settings, countries and headline counts, plus
 * the reader's own address (rule and ban forms warn before shutting it out).
 * `reachable` false means the proxy did not answer; `supported` false means
 * it answered without a firewall, an older LunaCore.
 */
export async function GET({ request, getClientAddress }) {
	const you = clientIp(request, getClientAddress()) ?? null;

	try {
		const result = await firewall.firewallOverview();

		if (!result.ok || !result.data) {
			return json({
				reachable: result.status !== 0,
				supported: result.status !== 404,
				error: result.error ?? 'unknown error',
				you
			});
		}

		return json({ reachable: true, supported: true, ...result.data, you });
	} catch (err) {
		// a daemon predating the firewall ops rejects the RPC itself
		return json({ reachable: false, supported: false, error: (err as Error).message, you });
	}
}
