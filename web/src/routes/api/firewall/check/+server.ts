// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import * as firewall from '$core/firewall';

/** GET ?ip= → what the firewall would do with one address, its bans before, and why. */
export async function GET({ url }) {
	const ip = (url.searchParams.get('ip') ?? '').trim();

	if (ip === '') {
		throw error(400, 'ip is required');
	}

	const [verdict, history] = await Promise.all([
		firewall.checkFirewallAddress(ip),
		firewall.ipBanHistory({ ip, limit: 50 }).catch(() => null)
	]);

	if (!verdict.ok || !verdict.data) {
		throw error(verdict.status || 502, verdict.error ?? 'the proxy did not answer');
	}

	return json({ ...verdict.data, history: history?.ok ? history.data?.bans ?? [] : [] });
}
