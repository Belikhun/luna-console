// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Player facts the console draws the same way on every screen.
 *
 * The latency bands are the thresholds the proxy's own tab list uses, so a ping
 * the console paints amber is one the player sees amber too.
 */

/** Latency bands, in ms. */
export const PING_FAIR = 120;
export const PING_POOR = 250;

/** The band a ping falls in, as the class name the screens colour by. */
export function pingClass(ping: number): 'good' | 'fair' | 'poor' {
	if (ping < PING_FAIR) {
		return 'good';
	}

	return ping < PING_POOR ? 'fair' : 'poor';
}

/** Activity windows the player tables filter and count by. */
export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
export const MONTH_MS = 30 * DAY_MS;

/** The design tokens a per-backend breakdown cycles through, in order. */
export const BACKEND_COLORS = [
	'var(--link)',
	'var(--success)',
	'var(--warning)',
	'var(--info)',
	'var(--error)'
];

/** The colour of the backend at `index` in a breakdown. */
export function backendColor(index: number): string {
	return BACKEND_COLORS[index % BACKEND_COLORS.length] ?? 'var(--link)';
}

/** The badge state a game mode is drawn in: survival is the calm one. */
export function gameModeState(mode: string | undefined): string {
	if (mode === 'survival') {
		return 'ok';
	}

	if (mode === 'creative') {
		return 'warning';
	}

	return mode === 'spectator'
		? 'stopped'
		: 'info';
}

/** Block coordinates as the game's F3 screen rounds them. */
export function blockCoords(position: { x: number; y: number; z: number } | undefined): string {
	if (!position) {
		return '';
	}

	return `${Math.round(position.x)}, ${Math.round(position.y)}, ${Math.round(position.z)}`;
}

/** A play session as the directory records one. */
export interface PlaySessionRow {
	id: number;
	server: string;
	connectedAtEpochMillis: number;
	disconnectedAtEpochMillis: number;
	durationMillis: number;
	open: boolean;
}

/**
 * Play sessions as one reading per day each session touched, so a calendar
 * shades a day by the time actually played on it: a session running past
 * midnight is split at the boundary instead of being credited whole to the day
 * it started in, which is what a long night would otherwise look like.
 *
 * @param sessions the sessions to spread over their days
 * @returns one point per session and day, valued in milliseconds
 */
export function playPointsOf(sessions: PlaySessionRow[]): Array<{ at: number; value: number }> {
	const points: Array<{ at: number; value: number }> = [];

	for (const session of sessions) {
		const startAt = session.connectedAtEpochMillis;

		// an open session is still running, so it counts up to now; a closed one
		// with no disconnect timestamp falls back to its own recorded duration
		const endAt = session.open
			? Date.now()
			: session.disconnectedAtEpochMillis > startAt
				? session.disconnectedAtEpochMillis
				: startAt + Math.max(0, session.durationMillis);

		if (endAt <= startAt) {
			// a session with nothing on the clock still says the player was here
			points.push({ at: startAt, value: 0 });
			continue;
		}

		let cursor = startAt;

		while (cursor < endAt) {
			const date = new Date(cursor);
			const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
			const until = Math.min(endAt, midnight);

			points.push({ at: cursor, value: until - cursor });
			cursor = until;
		}
	}

	return points;
}

/** Where a player stands on one server's access lists. */
export interface AccessFlags {
	operator: boolean;
	whitelisted: boolean;
	banned: boolean;
}

/** One server's access lists, reduced to what a player row needs to look itself up. */
export interface AccessIndex {
	whitelistEnabled: boolean;
	whitelist: Set<string>;
	ops: Set<string>;
	bans: Set<string>;
}

/** The keys a list entry is found under: its uuid when it has one, and its name. */
function accessKeys(entry: { uuid?: string; name?: string }): string[] {
	const keys: string[] = [];

	if (entry.uuid) {
		keys.push(entry.uuid.toLowerCase());
	}

	if (entry.name) {
		keys.push(`name:${entry.name.toLowerCase()}`);
	}

	return keys;
}

/**
 * Index a server's access lists by uuid and by name, since a list entry added
 * before the player ever joined carries a name alone.
 *
 * @param lists the lists as `/api/instances/<name>/access` answers them
 */
export function accessIndexOf(lists: {
	whitelistEnabled?: boolean;
	whitelist?: Array<{ uuid?: string; name?: string }>;
	ops?: Array<{ uuid?: string; name?: string }>;
	bans?: Array<{ uuid?: string; name?: string }>;
}): AccessIndex {
	return {
		whitelistEnabled: lists.whitelistEnabled ?? false,
		whitelist: new Set((lists.whitelist ?? []).flatMap(accessKeys)),
		ops: new Set((lists.ops ?? []).flatMap(accessKeys)),
		bans: new Set((lists.bans ?? []).flatMap(accessKeys))
	};
}

/** One player's standing in an access index, by uuid first and name second. */
export function accessFlagsOf(index: AccessIndex | null, player: { uuid?: string; name?: string }): AccessFlags | null {
	if (!index) {
		return null;
	}

	const keys = accessKeys(player);
	const inSet = (set: Set<string>): boolean => keys.some((key) => set.has(key));

	return {
		operator: inSet(index.ops),
		whitelisted: inSet(index.whitelist),
		banned: inSet(index.bans)
	};
}

/** One server's access lists as its screen last read them. */
export interface AccessSnapshot {
	/** stopped | starting | running | unknown */
	state: string;
	whitelistEnabled: boolean;
	enforceWhitelist: boolean;
	whitelist: Array<{ uuid: string; name: string }>;
	ops: Array<{ uuid: string; name: string; level: number; bypassesPlayerLimit: boolean }>;
	bans: Array<{ uuid: string; name: string; created: string; source: string; expires: string; reason?: string }>;
	ipBans: Array<{ ip: string; created: string; source: string; expires: string; reason?: string }>;
}
