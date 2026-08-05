// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import * as luna from '$core/services/luna';
import { pushEvent } from '$lib/server/luna';

/** GET → every LuckPerms group, heaviest weight first. */
export async function GET() {
	const result = await luna.permissionGroups();

	if (!result.ok) {
		return json({ available: false, error: result.error ?? 'unknown error' });
	}

	return json({ available: true, ...result.data });
}

/** POST { name, weight?, displayName? } → create a group. */
export async function POST({ request }) {
	const body = await request.json();
	const name = String(body.name ?? '').trim();

	if (!name) {
		throw error(400, 'name is required');
	}

	const result = await luna.createPermissionGroup(name, {
		...(body.weight !== undefined ? { weight: Number(body.weight) } : {}),
		...(body.displayName ? { displayName: String(body.displayName) } : {})
	});

	if (result.ok) {
		pushEvent('proxy', 'action', `permission group created: ${name}`);
	}

	return json(result);
}
