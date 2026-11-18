// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import * as firewall from '$core/firewall';
import { METRICS_RANGES, rangeMs, type MetricsRange } from '$shared/metricsrange';

/**
 * GET ?range=24h|7d|30d|90d[&ip=] → refusals per hour, the latest refusals and
 * the most refused addresses, with the country of each address shown.
 */
export async function GET({ url }) {
	const range = url.searchParams.get('range') ?? '24h';

	if (!(METRICS_RANGES as readonly string[]).includes(range)) {
		throw error(400, 'unknown range');
	}

	const span = rangeMs(range as MetricsRange);

	const to = Date.now();
	const from = to - span;
	const ip = url.searchParams.get('ip') ?? undefined;

	try {
		const result = await firewall.firewallActivity({ from, to: to + 1, ip, limit: 500 });

		if (!result.ok || !result.data) {
			return json({ available: false, error: result.error ?? 'unknown error' });
		}

		const addresses = new Set<string>();

		for (const row of [...result.data.recent, ...result.data.top]) {
			addresses.add(row.ip);
		}

		const countries = await firewall.addressCountries([...addresses]).catch(() => ({}));

		return json({ available: true, ...result.data, countries });
	} catch (err) {
		return json({ available: false, error: (err as Error).message });
	}
}
