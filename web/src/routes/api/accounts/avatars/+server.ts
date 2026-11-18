// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';

import { listAccounts } from '$core/accounts';

/** How many names one request may ask about; a screen asks for the actors it shows. */
const MAX_NAMES = 100;

/**
 * GET ?names=a,b → each named account's picture, keyed by username.
 *
 * Any signed-in operator may ask: the names are already on the screen beside
 * the picture (an event's actor, a resource's creator), and the image route
 * itself is open to every session. Only what `AccountAvatar` needs is returned.
 */
export async function GET({ url }) {
	const wanted = new Set(
		(url.searchParams.get('names') ?? '')
			.split(',')
			.map((name) => name.trim())
			.filter(Boolean)
			.slice(0, MAX_NAMES)
	);

	if (wanted.size === 0) {
		return json({ people: {} });
	}

	const accounts = await listAccounts();
	const people: Record<string, { id: string; username: string; avatar: unknown }> = {};

	for (const account of accounts) {
		if (wanted.has(account.username)) {
			people[account.username] = { id: account.id, username: account.username, avatar: account.avatar ?? null };
		}
	}

	return json({ people });
}
