// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/** What `AccountAvatar` needs of an account; an `AccountSummary` has all of it. */
export interface AvatarSubject {
	id: string;
	username: string;
	displayName?: string;
	avatar:
		| { source: 'upload'; version: number }
		| { source: 'minecraft'; uuid: string; playerName: string | null }
		| null;
}

/** The uploaded image to show for an account, or null; a skin face is drawn on a canvas instead. */
export function avatarUrl(account: AvatarSubject): string | null {
	const avatar = account.avatar;

	if (avatar?.source === 'upload') {
		return `/api/accounts/${encodeURIComponent(account.id)}/avatar?v=${avatar.version}`;
	}

	return null;
}

/** One or two letters for an account with no picture: from the display name's words, else the username. */
export function initialsOf(account: AvatarSubject): string {
	const words = (account.displayName || account.username).split(/[\s._-]+/).filter(Boolean);
	const first = words[0]?.[0] ?? '?';
	const second = words.length > 1 ? words[words.length - 1]![0] : '';

	return `${first}${second ?? ''}`;
}
