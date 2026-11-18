// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import * as firewall from '$core/firewall';
import type { FirewallRuleInput } from '$shared/firewall';
import { pushEvent } from '$lib/server/luna';

interface RuleOutcome {
	id: string;
	ok: boolean;
	error?: string;
}

/**
 * POST { action: save, rule } → add or replace one rule, then send the
 * countries the rules name to the proxy.
 * POST { action: enable|disable|remove, ids[] } → one outcome per rule.
 */
export async function POST({ request, locals }) {
	const body = await request.json();
	const action = String(body.action ?? '');
	const actor = locals.account?.username ?? 'console';

	if (action === 'save') {
		const rule = body.rule as FirewallRuleInput | undefined;

		if (!rule || (rule.action !== 'allow' && rule.action !== 'deny')) {
			throw error(400, 'rule.action must be allow or deny');
		}

		const result = await firewall.saveFirewallRule({
			id: rule.id,
			action: rule.action,
			enabled: rule.enabled !== false,
			addresses: Array.isArray(rule.addresses) ? rule.addresses.map(String) : [],
			countries: Array.isArray(rule.countries) ? rule.countries.map(String) : [],
			note: String(rule.note ?? '')
		}, actor);

		if (!result.ok || !result.data) {
			throw error(result.status || 502, result.error ?? 'the proxy did not store the rule');
		}

		pushEvent('proxy', 'action', rule.id ? 'firewall rule changed' : 'firewall rule added');

		return json({ ok: true, countries: result.data.countries });
	}

	if (action !== 'enable' && action !== 'disable' && action !== 'remove') {
		throw error(400, 'action must be save, enable, disable or remove');
	}

	const ids: string[] = Array.isArray(body.ids)
		? body.ids.map(String).filter((id: string) => id.trim() !== '')
		: [];

	if (ids.length === 0) {
		throw error(400, 'ids is required');
	}

	const outcomes: RuleOutcome[] = [];

	for (const id of ids) {
		try {
			const result = action === 'remove'
				? await firewall.removeFirewallRule(id)
				: await firewall.setFirewallRuleEnabled(id, action === 'enable');

			outcomes.push({
				id,
				ok: result.ok,
				...(result.ok ? {} : { error: result.error ?? 'change failed' })
			});
		} catch (err) {
			outcomes.push({ id, ok: false, error: (err as Error).message });
		}
	}

	const okCount = outcomes.filter((outcome) => outcome.ok).length;

	pushEvent('proxy', 'action', `firewall rules ${action}d: ${okCount}/${outcomes.length}`);

	return json({ ok: true, outcomes });
}
