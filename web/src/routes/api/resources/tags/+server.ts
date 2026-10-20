// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { tagResource, untagResource } from '$core/resources';
import { errorMessage, jsonBody } from '$lib/server/http';
import { journal } from '$lib/server/session';

/** PUT { id, tags: { k: v } } → set tags on a resource, keeping the others. */
export async function PUT({ request, locals }) {
	const body = await jsonBody(request);
	const id = String(body.id ?? '');
	const tags = body.tags && typeof body.tags === 'object' ? body.tags : {};

	try {
		const resource = await tagResource(id, tags, locals.account?.username ?? null);

		journal(`tagged ${id}: ${Object.keys(tags).join(', ')}`, { actor: locals.account?.username });

		return json({ resource });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}

/** DELETE { id, keys: string[] } → remove tags by key. */
export async function DELETE({ request, locals }) {
	const body = await jsonBody(request);
	const id = String(body.id ?? '');
	const keys = Array.isArray(body.keys) ? body.keys.map(String) : [];

	try {
		const resource = await untagResource(id, keys, locals.account?.username ?? null);

		journal(`untagged ${id}: ${keys.join(', ')}`, { actor: locals.account?.username });

		return json({ resource });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
