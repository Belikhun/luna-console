// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import * as firewall from '$core/firewall';
import * as luna from '$core/services/luna';
import { pushEvent } from '$lib/server/luna';

/**
 * GET → active bans, with the country of each address.
 * GET ?history=1[&ip=] → bans that ended, newest first.
 */
export async function GET({ url }) {
	try {
		if (url.searchParams.get('history')) {
			const limit = Number(url.searchParams.get('limit') ?? 500);
			const result = await firewall.ipBanHistory({ ip: url.searchParams.get('ip') ?? undefined, limit });

			if (!result.ok || !result.data) {
				return json({ available: false, error: result.error ?? 'unknown error' });
			}

			const countries = await firewall.addressCountries(result.data.bans.map((ban) => ban.ip)).catch(() => ({}));

			return json({ available: true, ...result.data, countries });
		}

		const result = await luna.networkIpBans();

		if (!result.ok || !result.data) {
			return json({ available: false, error: result.error ?? 'unknown error' });
		}

		const countries = await firewall.addressCountries(result.data.bans.map((ban) => ban.ip)).catch(() => ({}));

		return json({ available: true, ...result.data, countries });
	} catch (err) {
		return json({ available: false, error: (err as Error).message });
	}
}

interface BanOutcome {
	ip: string;
	ok: boolean;
	error?: string;
	kicked?: string[];
}

/**
 * POST { action: add, ips[], reason?, expiresAt? } → ban each address or prefix.
 * POST { action: remove, ips[] } → lift each ban. One outcome per address.
 */
export async function POST({ request, locals }) {
	const body = await request.json();
	const action = String(body.action ?? '');
	const reason = String(body.reason ?? '');
	const expiresAt = Number(body.expiresAt ?? 0);
	const actor = locals.account?.username ?? 'console';
	const ips: string[] = Array.isArray(body.ips)
		? body.ips.map(String).filter((ip: string) => ip.trim() !== '')
		: [];

	if (action !== 'add' && action !== 'remove') {
		throw error(400, 'action must be add or remove');
	}

	if (ips.length === 0) {
		throw error(400, 'ips is required');
	}

	const outcomes: BanOutcome[] = [];

	for (const ip of ips) {
		try {
			if (action === 'add') {
				const result = await luna.addNetworkIpBan(ip, { reason, actor, expiresAt: expiresAt > 0 ? expiresAt : undefined });

				outcomes.push({
					ip,
					ok: result.ok,
					...(result.ok ? { kicked: result.data?.kicked ?? [] } : { error: result.error ?? 'ban failed' })
				});

				continue;
			}

			const result = await luna.removeNetworkIpBan(ip, { actor });

			outcomes.push({
				ip,
				ok: result.ok,
				...(result.ok ? {} : { error: result.error ?? 'lift failed' })
			});
		} catch (err) {
			outcomes.push({ ip, ok: false, error: (err as Error).message });
		}
	}

	const okCount = outcomes.filter((outcome) => outcome.ok).length;

	pushEvent(
		'proxy',
		'action',
		`network ip ${action === 'add' ? 'ban' : 'pardon'} applied to ${okCount}/${outcomes.length} address(es)`,
		{ reason: reason || undefined }
	);

	return json({ ok: true, outcomes });
}
