// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { deletePolicy, getPolicy, iamAudit, updatePolicy } from '$core/iam';
import { errorMessage, jsonBody } from '$lib/server/http';
import { journal } from '$lib/server/session';
import { can, scopePolicies } from '$lib/server/authz';

/**
 * GET → one policy with the trail that names it. An account can open a policy
 * that reaches it; it sees the accounts and groups it may describe among those
 * the policy is attached to, and no trail.
 */
export async function GET({ params, locals }) {
	const policy = await getPolicy(params.name);

	if (!policy) {
		throw error(404, `no policy named ${params.name}`);
	}

	const [[scoped], readsAudit] = await Promise.all([scopePolicies(locals, [policy]), can(locals, 'iam:ReadAudit')]);
	const audit = readsAudit
		? await iamAudit({ target: policy.name, limit: 200 })
		: [];

	return json({ policy: scoped ?? policy, audit });
}

/** PATCH { name?, description?, yaml? } → edit a managed policy. */
export async function PATCH({ params, request, locals }) {
	const body = await jsonBody(request);

	try {
		const policy = await updatePolicy(
			params.name,
			{
				name: body.name !== undefined ? String(body.name) : undefined,
				description: body.description !== undefined ? String(body.description) : undefined,
				yaml: body.yaml !== undefined ? String(body.yaml) : undefined
			},
			locals.account?.username
		);

		journal(`policy ${policy.name} updated`, { actor: locals.account?.username });

		return json({ policy });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}

/** DELETE → remove a managed policy nothing is attached to. */
export async function DELETE({ params, locals }) {
	try {
		await deletePolicy(params.name, locals.account?.username);

		journal(`policy ${params.name} deleted`, { actor: locals.account?.username });

		return json({ ok: true });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
