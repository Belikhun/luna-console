// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { api } from '$lib/api';
import type { AvatarSubject } from '$lib/components/accountavatar';

/**
 * Account pictures by username, for the places that only know an actor's name
 * (an event's "by"). Names asked for in the same tick go out as one request,
 * each name is asked about once per page load, and a name that is not an
 * account keeps its plain fallback.
 */

const known: Record<string, AvatarSubject | null> = $state({});
const pending = new Set<string>();

let timer: ReturnType<typeof setTimeout> | null = null;

async function flush(): Promise<void> {
	timer = null;

	const names = [...pending];

	pending.clear();

	if (names.length === 0) {
		return;
	}

	try {
		const data = await api<{ people: Record<string, AvatarSubject> }>(
			`/accounts/avatars?names=${encodeURIComponent(names.join(','))}`
		);

		for (const name of names) {
			known[name] = data.people[name] ?? null;
		}
	} catch {
		for (const name of names) {
			known[name] = null;
		}
	}
}

/**
 * The account behind a username, once it has been looked up: a subject for
 * `AccountAvatar`, or null while unknown or when the name is not an account.
 *
 * @param username the actor's name as recorded
 * @returns the avatar subject, or null
 */
export function accountPerson(username: string): AvatarSubject | null {
	if (!(username in known) && !pending.has(username)) {
		pending.add(username);
		timer ??= setTimeout(() => void flush(), 0);
	}

	return known[username] ?? null;
}
