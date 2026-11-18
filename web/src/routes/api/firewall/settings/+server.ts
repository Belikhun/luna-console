// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import * as firewall from '$core/firewall';
import type { FirewallSettings } from '$shared/firewall';
import { pushEvent } from '$lib/server/luna';

/** POST { values } → change some settings; answers them as stored. */
export async function POST({ request }) {
	const body = await request.json();
	const values = (body.values ?? {}) as Partial<FirewallSettings>;

	if (typeof values !== 'object' || Object.keys(values).length === 0) {
		throw error(400, 'values is required');
	}

	const result = await firewall.updateFirewallSettings(values);

	if (!result.ok || !result.data) {
		throw error(result.status || 502, result.error ?? 'the proxy did not store the settings');
	}

	pushEvent('proxy', 'action', 'firewall settings changed');

	return json({ ok: true, settings: result.data.settings });
}
