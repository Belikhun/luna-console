// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import {
	addAccessKey,
	addMinecraftIdentity,
	getAccount,
	removeIdentity,
	setIdentityDisabled
} from '$core/accounts';
import { errorMessage, jsonBody } from '$lib/server/http';
import { journal } from '$lib/server/session';

/**
 * An account's identities: the credentials attached to it.
 *
 * A new access key answers with its secret **once**. Nothing stores it, and no
 * later request can produce it; the screen has to show it there and then, which is
 * why the response shape is deliberately different from every other route's.
 */

/** POST { kind: "accessKey" | "minecraft", label?, uuid?, playerName? } → add one. */
export async function POST({ params, request, locals }) {
	const body = await jsonBody(request);
	const account = await getAccount(params.id);

	if (!account) {
		throw error(404, `no console account named ${params.id}`);
	}

	const kind = String(body.kind ?? '');

	try {
		if (kind === 'accessKey') {
			const created = await addAccessKey(
				account.id,
				String(body.label ?? ''),
				locals.account?.username
			);

			journal(`access key created for ${account.username}`, {
				actor: locals.account?.username,
				detail: created.identity.label
			});

			return json(created);
		}

		if (kind === 'minecraft') {
			const identity = await addMinecraftIdentity(
				account.id,
				String(body.uuid ?? ''),
				String(body.playerName ?? ''),
				locals.account?.username
			);

			journal(`minecraft identity linked to ${account.username}`, {
				actor: locals.account?.username,
				detail: identity.label
			});

			return json({ identity });
		}
	} catch (err) {
		throw error(400, errorMessage(err));
	}

	// a console password is set through its own route, which has the current-password
	// rule this one has no business duplicating
	throw error(400, `an identity is an accessKey or a minecraft link, not ${kind || 'nothing'}`);
}

/** PATCH { identity, disabled } → retire or restore one identity, keeping its trail. */
export async function PATCH({ params, request, locals }) {
	const body = await jsonBody(request);
	const account = await getAccount(params.id);

	if (!account) {
		throw error(404, `no console account named ${params.id}`);
	}

	try {
		await setIdentityDisabled(
			account.id,
			String(body.identity ?? ''),
			!!body.disabled,
			locals.account?.username
		);
	} catch (err) {
		throw error(400, errorMessage(err));
	}

	return json({ ok: true });
}

/** DELETE ?identity= → remove one identity outright. */
export async function DELETE({ params, url, locals }) {
	const account = await getAccount(params.id);

	if (!account) {
		throw error(404, `no console account named ${params.id}`);
	}

	const identityId = url.searchParams.get('identity') ?? '';
	const identity = account.identities.find((entry) => entry.id === identityId);

	// the last password identity is the account's only way in, and removing it
	// silently would leave an enabled account nobody can sign in as
	if (identity?.kind === 'password') {
		throw error(
			400,
			'a console password is replaced by setting a new one, not by removing it'
		);
	}

	try {
		await removeIdentity(account.id, identityId, locals.account?.username);
	} catch (err) {
		throw error(400, errorMessage(err));
	}

	journal(`identity removed from ${account.username}`, {
		actor: locals.account?.username,
		detail: identity?.label
	});

	return json({ ok: true });
}
