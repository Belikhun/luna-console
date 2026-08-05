// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import * as luna from '$core/services/luna';
import { pushEvent } from '$lib/server/luna';

/** GET → the player's LuckPerms data: primary group, memberships, nodes. */
export async function GET({ params }) {
	const result = await luna.permissionUser(params.player);

	if (!result.ok) {
		return json({ available: false, error: result.error ?? 'unknown error' });
	}

	return json({ available: true, ...result.data });
}

/**
 * POST { op: "node" | "group", ... } → edit the player's permissions.
 *
 * `node` carries { action, key, value?, expirySeconds?, contexts? };
 * `group` carries { action: add|remove|set, group }.
 */
export async function POST({ params, request }) {
	const body = await request.json();
	const op = String(body.op ?? '');

	if (op === 'node') {
		const result = await luna.editUserNode(params.player, {
			action: body.action === 'remove' ? 'remove' : 'add',
			key: String(body.key ?? ''),
			...(body.value !== undefined ? { value: Boolean(body.value) } : {}),
			...(body.expirySeconds ? { expirySeconds: Number(body.expirySeconds) } : {}),
			...(body.contexts ? { contexts: body.contexts } : {})
		});

		if (result.ok) {
			pushEvent('proxy', 'action', `permission node ${body.action} on ${params.player}: ${body.key}`);
		}

		return json(result);
	}

	if (op === 'group') {
		const action = String(body.action ?? '');

		if (action !== 'add' && action !== 'remove' && action !== 'set') {
			throw error(400, `unknown group action: ${action}`);
		}

		const result = await luna.editUserGroups(params.player, action, String(body.group ?? ''));

		if (result.ok) {
			pushEvent('proxy', 'action', `group ${action} on ${params.player}: ${body.group}`);
		}

		return json(result);
	}

	throw error(400, `unknown op: ${op}`);
}
