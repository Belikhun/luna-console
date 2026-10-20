// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { deleteInlinePolicy, putInlinePolicy, type AttachTarget } from '$core/iam';
import { errorMessage, jsonBody } from '$lib/server/http';
import { journal } from '$lib/server/session';

function targetOf(body: Record<string, unknown>): AttachTarget {
	if (typeof body.account === 'string' && body.account) {
		return { account: body.account };
	}

	if (typeof body.group === 'string' && body.group) {
		return { group: body.group };
	}

	throw error(400, 'an account or a group is required');
}

/** PUT { account | group, name, yaml } → put an inline policy on the target. */
export async function PUT({ request, locals }) {
	const body = await jsonBody(request);
	const target = targetOf(body);

	try {
		const inline = await putInlinePolicy(target, String(body.name ?? ''), String(body.yaml ?? ''), locals.account?.username);

		journal(`inline policy ${inline.name} put on ${'account' in target ? target.account : `group ${target.group}`}`, {
			actor: locals.account?.username
		});

		return json({ inline });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}

/** DELETE { account | group, name } → remove an inline policy. */
export async function DELETE({ request, locals }) {
	const body = await jsonBody(request);
	const target = targetOf(body);

	try {
		await deleteInlinePolicy(target, String(body.name ?? ''), locals.account?.username);

		journal(`inline policy ${body.name} removed from ${'account' in target ? target.account : `group ${target.group}`}`, {
			actor: locals.account?.username
		});

		return json({ ok: true });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
