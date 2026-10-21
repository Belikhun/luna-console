// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { createPolicy, listPolicies } from '$core/iam';
import { errorMessage, jsonBody } from '$lib/server/http';
import { journal } from '$lib/server/session';
import { scopePolicies } from '$lib/server/authz';

/** GET → every policy, built-ins first. */
export async function GET({ locals }) {
	return json({ policies: await scopePolicies(locals, await listPolicies()) });
}

/** POST { name, description?, yaml } → create a managed policy. */
export async function POST({ request, locals }) {
	const body = await jsonBody(request);

	try {
		const policy = await createPolicy(
			{
				name: String(body.name ?? ''),
				description: body.description !== undefined ? String(body.description) : undefined,
				yaml: String(body.yaml ?? '')
			},
			locals.account?.username
		);

		journal(`policy ${policy.name} created`, { actor: locals.account?.username });

		return json({ policy });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
