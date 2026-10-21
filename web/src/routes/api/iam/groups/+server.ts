// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { createGroup, listGroups } from '$core/iam';
import { errorMessage, jsonBody } from '$lib/server/http';
import { journal } from '$lib/server/session';
import { scopeGroups } from '$lib/server/authz';

/** GET → every group with its members and attachments. */
export async function GET({ locals }) {
	return json({ groups: await scopeGroups(locals, await listGroups()) });
}

/** POST { name, description?, policies?, members? } → create a group. */
export async function POST({ request, locals }) {
	const body = await jsonBody(request);

	try {
		const group = await createGroup(
			{
				name: String(body.name ?? ''),
				description: body.description !== undefined ? String(body.description) : undefined,
				policies: Array.isArray(body.policies) ? body.policies.map(String) : undefined,
				members: Array.isArray(body.members) ? body.members.map(String) : undefined
			},
			locals.account?.username
		);

		journal(`group ${group.name} created`, { actor: locals.account?.username });

		return json({ group });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
