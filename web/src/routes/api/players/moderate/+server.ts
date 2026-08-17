// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { loadCluster, managedInstances } from '$core/config';
import { applyAccessChange } from '$core/playerlists';
import type { AccessChange, AccessChangeResult, AccessListKind } from '$core/playerlists';
import * as luna from '$core/services/luna';
import { pushEvent } from '$lib/server/luna';

/** Which access list each moderation verb edits, and in which direction. */
const LIST_VERBS: Record<string, { list: AccessListKind; action: 'add' | 'remove' }> = {
	ban: { list: 'bans', action: 'add' },
	pardon: { list: 'bans', action: 'remove' },
	'ban-ip': { list: 'ban-ips', action: 'add' },
	'pardon-ip': { list: 'ban-ips', action: 'remove' },
	'whitelist-add': { list: 'whitelist', action: 'add' },
	'whitelist-remove': { list: 'whitelist', action: 'remove' },
	op: { list: 'ops', action: 'add' },
	deop: { list: 'ops', action: 'remove' }
};

export interface ModerationOutcome {
	target: string;
	instance: string;
	ok: boolean;
	/** false when the command was sent but the server has not persisted it yet */
	verified?: boolean;
	error?: string;
}

/**
 * A target as the callers send it: the display name plus, when the caller
 * knows it, the exact profile id, so the action lands on that profile even
 * when two share the name. Bare strings stay accepted.
 */
interface ModerationTarget {
	name: string;
	uuid?: string;
}

function parseTargets(raw: unknown): ModerationTarget[] {
	if (!Array.isArray(raw)) {
		return [];
	}

	const out: ModerationTarget[] = [];

	for (const entry of raw) {
		if (typeof entry === 'string' && entry) {
			out.push({ name: entry });
			continue;
		}

		if (entry && typeof entry === 'object') {
			const name = String((entry as any).name ?? '');
			const uuid = (entry as any).uuid ? String((entry as any).uuid) : undefined;

			if (name || uuid) {
				out.push({ name: name || uuid!, ...(uuid ? { uuid } : {}) });
			}
		}
	}

	return out;
}

/**
 * POST { action, targets[], instances?[], reason? } → one moderation verb
 * applied to a set of players across a set of instances.
 *
 * `kick` and `message`-style live verbs go through LunaCore and ignore
 * `instances`; access-list verbs (ban, whitelist, op, …) fan out per instance
 * through the daemon, which routes each to the instance's owner. Every action
 * is recorded in the player's moderation log so the history stays complete.
 */
export async function POST({ request }) {
	const body = await request.json();
	const action = String(body.action ?? '');
	const reason = String(body.reason ?? '');
	const targets = parseTargets(body.targets);

	if (!action) {
		throw error(400, 'action is required');
	}

	if (targets.length === 0) {
		throw error(400, 'targets is required');
	}

	const outcomes: ModerationOutcome[] = [];

	if (action === 'kick') {
		for (const target of targets) {
			// LunaCore's resolvePlayer takes a UUID or a name; the id wins
			const result = await luna.kick(target.uuid ?? target.name, reason);

			outcomes.push({
				target: target.name,
				instance: '',
				ok: result.ok,
				...(result.ok ? {} : { error: result.error ?? 'kick failed' })
			});

			if (result.ok) {
				void luna.recordModeration({
					action: 'kick',
					targetName: target.name,
					...(target.uuid ? { targetUuid: target.uuid } : {}),
					actor: 'console',
					reason
				});
			}
		}

		pushEvent('proxy', 'action', `kicked ${outcomes.filter((entry) => entry.ok).length} player(s)`);

		return json({ ok: true, outcomes });
	}

	const verb = LIST_VERBS[action];

	if (!verb) {
		throw error(400, `unknown action: ${action}`);
	}

	const cfg = await loadCluster();
	const managed = managedInstances(cfg);
	const instances: string[] = Array.isArray(body.instances) ? body.instances.map(String) : [];

	if (instances.length === 0) {
		throw error(400, 'instances is required for access-list actions');
	}

	for (const name of instances) {
		if (!managed[name]) {
			throw error(400, `unknown instance: ${name}`);
		}
	}

	for (const target of targets) {
		const applied: AccessChangeResult[] = [];

		for (const name of instances) {
			const change: AccessChange = {
				list: verb.list,
				action: verb.action,
				target: target.name,
				...(target.uuid && verb.list !== 'ban-ips' ? { uuid: target.uuid } : {}),
				reason,
				actor: 'console'
			};

			try {
				const result = await applyAccessChange(cfg, name, change);

				applied.push(result);
				outcomes.push({
					target: target.name,
					instance: name,
					ok: result.ok,
					...(result.verified === false ? { verified: false } : {}),
					...(result.ok ? {} : { error: result.error ?? 'change failed' })
				});
			} catch (err) {
				outcomes.push({ target: target.name, instance: name, ok: false, error: (err as Error).message });
			}
		}

		const succeeded = applied.filter((result) => result.ok).map((result) => result.instance);

		if (succeeded.length > 0) {
			void luna.recordModeration({
				action,
				targetName: target.name,
				...(target.uuid && verb.list !== 'ban-ips' ? { targetUuid: target.uuid } : {}),
				actor: 'console',
				reason,
				server: succeeded.join(', ')
			});
		}
	}

	const okCount = outcomes.filter((entry) => entry.ok).length;

	pushEvent('proxy', 'action', `${action} applied to ${okCount}/${outcomes.length} target-instance pair(s)`);

	return json({ ok: true, outcomes });
}
