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

/** The image to show for an account, or null when it draws initials. */
export function avatarUrl(account: AvatarSubject, px: number): string | null {
	const avatar = account.avatar;

	if (avatar?.source === 'upload') {
		return `/api/accounts/${encodeURIComponent(account.id)}/avatar?v=${avatar.version}`;
	}

	if (avatar?.source === 'minecraft') {
		return `/api/avatar/face/${px}/${avatar.uuid}.png`;
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
