// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { deleteGroup, getGroup, iamAudit, updateGroup } from '$core/iam';
import { errorMessage, jsonBody } from '$lib/server/http';
import { journal } from '$lib/server/session';
import { can, scopeGroups } from '$lib/server/authz';

/**
 * GET → one group with the trail that names it. A member can open its own
 * group; it sees the members it may describe (itself) and no trail.
 */
export async function GET({ params, locals }) {
	const group = await getGroup(params.name);

	if (!group) {
		throw error(404, `no group named ${params.name}`);
	}

	const [[scoped], readsAudit] = await Promise.all([scopeGroups(locals, [group]), can(locals, 'iam:ReadAudit')]);
	const audit = readsAudit
		? await iamAudit({ target: `group ${group.name}`, limit: 200 })
		: [];

	return json({ group: scoped ?? group, audit });
}

/** PATCH { name?, description? } → rename or describe the group. */
export async function PATCH({ params, request, locals }) {
	const body = await jsonBody(request);

	try {
		const group = await updateGroup(
			params.name,
			{
				name: body.name !== undefined ? String(body.name) : undefined,
				description: body.description !== undefined ? String(body.description) : undefined
			},
			locals.account?.username
		);

		journal(`group ${group.name} updated`, { actor: locals.account?.username });

		return json({ group });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}

/** DELETE → remove the group; its members lose what it granted. */
export async function DELETE({ params, locals }) {
	try {
		await deleteGroup(params.name, locals.account?.username);

		journal(`group ${params.name} deleted`, { actor: locals.account?.username });

		return json({ ok: true });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
