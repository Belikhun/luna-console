import { json, error } from '@sveltejs/kit';

import { loadCluster, managedInstances } from '$core/config';
import { getAccessLists, applyAccessChange, setWhitelistEnabled } from '$core/playerlists';
import type { AccessChange, AccessListKind } from '$core/playerlists';
import * as luna from '$core/services/luna';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

const LISTS: AccessListKind[] = ['whitelist', 'ops', 'bans', 'ban-ips'];

/** GET → the instance's whitelist, operators, bans and IP bans in one read. */
export async function GET({ params }) {
	const cfg = await loadCluster();

	if (!managedInstances(cfg)[params.name]) {
		throw error(404, 'unknown instance');
	}

	try {
		return json(await getAccessLists(cfg, params.name));
	} catch (err) {
		throw error(502, errorMessage(err));
	}
}

/**
 * POST → one change to the instance's access lists:
 * `{ kind: "change", list, action, target, reason?, level? }` edits a list,
 * `{ kind: "whitelist", enabled }` toggles whitelist enforcement.
 * Both are audit-logged, and list changes land in the player's moderation log.
 */
export async function POST({ params, request }) {
	const cfg = await loadCluster();

	if (!managedInstances(cfg)[params.name]) {
		throw error(404, 'unknown instance');
	}

	const body = await request.json();
	const kind = String(body.kind ?? 'change');

	if (kind === 'whitelist') {
		const enabled = Boolean(body.enabled);
		const result = await setWhitelistEnabled(cfg, params.name, enabled);

		pushEvent(params.name, 'action', `whitelist turned ${enabled ? 'on' : 'off'}`);

		return json({ ok: true, result });
	}

	const list = String(body.list ?? '') as AccessListKind;
	const action = String(body.action ?? '');
	const target = String(body.target ?? '').trim();

	if (!LISTS.includes(list)) {
		throw error(400, `unknown list: ${list}`);
	}

	if (action !== 'add' && action !== 'remove') {
		throw error(400, `unknown action: ${action}`);
	}

	if (!target) {
		throw error(400, 'target is required');
	}

	const change: AccessChange = {
		list,
		action,
		target,
		reason: String(body.reason ?? ''),
		actor: 'console',
		...(body.level !== undefined ? { level: Number(body.level) } : {})
	};

	const result = await applyAccessChange(cfg, params.name, change);

	if (result.ok) {
		pushEvent(params.name, 'action', `${list} ${action}: ${target}`);

		// Best-effort: the moderation log lives in LunaCore's database; the file
		// edit stands even when the proxy is down.
		void luna.recordModeration({
			action: `${list}-${action}`,
			targetName: target,
			actor: 'console',
			reason: change.reason,
			server: params.name
		});
	}

	return json({ ok: result.ok, result });
}
