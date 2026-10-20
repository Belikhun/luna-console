// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { attachPolicy, detachPolicy, type AttachTarget } from '$core/iam';
import { errorMessage, jsonBody } from '$lib/server/http';
import { journal } from '$lib/server/session';

/** The body names one target: { account } or { group }. */
function targetOf(body: Record<string, unknown>): AttachTarget {
	if (typeof body.account === 'string' && body.account) {
		return { account: body.account };
	}

	if (typeof body.group === 'string' && body.group) {
		return { group: body.group };
	}

	throw error(400, 'an account or a group is required');
}

/** POST { account | group, policy } → attach a managed or built-in policy. */
export async function POST({ request, locals }) {
	const body = await jsonBody(request);
	const target = targetOf(body);
	const policy = String(body.policy ?? '');

	try {
		await attachPolicy(target, policy, locals.account?.username);

		journal(`policy ${policy} attached to ${'account' in target ? target.account : `group ${target.group}`}`, {
			actor: locals.account?.username
		});

		return json({ ok: true });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}

/** DELETE { account | group, policy } → detach it. */
export async function DELETE({ request, locals }) {
	const body = await jsonBody(request);
	const target = targetOf(body);
	const policy = String(body.policy ?? '');

	try {
		await detachPolicy(target, policy, locals.account?.username);

		journal(`policy ${policy} detached from ${'account' in target ? target.account : `group ${target.group}`}`, {
			actor: locals.account?.username
		});

		return json({ ok: true });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
