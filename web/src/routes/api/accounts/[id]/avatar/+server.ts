// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { getAccount, readAccountAvatar, setAccountAvatar } from '$core/accounts';
import type { AvatarChoice } from '$core/accounts';
import { errorMessage, jsonBody } from '$lib/server/http';
import { journal } from '$lib/server/session';

/**
 * An account's picture. GET serves an uploaded one (a Minecraft face is drawn by
 * `/api/avatar`, and initials by the client); PUT changes where it comes from.
 * The console crops and shrinks an upload in the browser, so what arrives here
 * is already a small square image.
 */

/** GET → the uploaded image, cached for good once the URL carries its version. */
export async function GET({ params, url }) {
	const avatar = await readAccountAvatar(params.id);

	if (!avatar) {
		throw error(404, 'no uploaded picture');
	}

	const versioned = url.searchParams.get('v') === String(avatar.version);

	return new Response(Buffer.from(avatar.dataBase64, 'base64'), {
		headers: {
			'content-type': avatar.type,
			'cache-control': versioned
				? 'private, max-age=31536000, immutable'
				: 'private, no-cache',
			etag: `"${avatar.version}"`
		}
	});
}

/** PUT { source: "upload", data } | { source: "minecraft", identity? } | { source: "initials" } | { source: "auto" } → { account }. */
export async function PUT({ params, request, locals }) {
	const body = await jsonBody(request);
	const account = await getAccount(params.id);

	if (!account) {
		throw error(404, `no console account named ${params.id}`);
	}

	let choice: AvatarChoice;

	switch (body.source) {
		case 'upload':
			choice = { source: 'upload', dataBase64: String(body.data ?? '') };
			break;

		case 'minecraft':
			choice = { source: 'minecraft', identity: body.identity ? String(body.identity) : undefined };
			break;

		case 'initials':
			choice = { source: 'initials' };
			break;

		case 'auto':
			choice = { source: 'auto' };
			break;

		default:
			throw error(400, 'source must be upload, minecraft, initials or auto');
	}

	try {
		const updated = await setAccountAvatar(account.id, choice, locals.account?.username);

		journal(`console account ${updated.username} picture changed (${choice.source})`, { actor: locals.account?.username });

		return json({ account: updated });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
