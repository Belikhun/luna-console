// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { addGroupMembers, removeGroupMembers } from '$core/iam';
import { errorMessage, jsonBody } from '$lib/server/http';
import { journal } from '$lib/server/session';

/** POST { members: string[] } → add accounts (ids or usernames) to the group. */
export async function POST({ params, request, locals }) {
	const body = await jsonBody(request);
	const members = Array.isArray(body.members) ? body.members.map(String) : [];

	try {
		const group = await addGroupMembers(params.name, members, locals.account?.username);

		journal(`group ${group.name}: added ${members.join(', ')}`, { actor: locals.account?.username });

		return json({ group });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}

/** DELETE { members: string[] } → remove accounts from the group. */
export async function DELETE({ params, request, locals }) {
	const body = await jsonBody(request);
	const members = Array.isArray(body.members) ? body.members.map(String) : [];

	try {
		const group = await removeGroupMembers(params.name, members, locals.account?.username);

		journal(`group ${group.name}: removed ${members.join(', ')}`, { actor: locals.account?.username });

		return json({ group });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
