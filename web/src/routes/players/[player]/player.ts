// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/** Shapes the player profile screen and its tabs share. */

import type { PlaySessionRow } from '$lib/players';
import type { PlayerSnapshot } from '$core/playerdata';

/** A player's profile as the directory answers it. */
export interface Detail {
	uuid: string;
	username: string;
	firstSeenAtEpochMillis: number;
	lastSeenAtEpochMillis: number;
	lastServer: string;
	lastAddress: string;
	lastClientVersion: string;
	onlineMode: boolean;
	sessionCount: number;
	online: boolean;
	server: string;
	pingMillis: number;
	sessionMillis: number;
	totalPlayMillis: number;
	skinTexture: string | null;
	playtimeByServer: Array<{ server: string; playMillis: number; stints: number }>;
	sessionTotal: number;
	chatTotal: number;
	commandTotal: number;
	moderationTotal: number;
	permissions: {
		available: boolean;
		primaryGroup?: string;
		primaryGroupDisplay?: string;
		prefix?: string;
		suffix?: string;
	};
}

export type Session = PlaySessionRow;

export interface ChatEntry {
	id: number;
	server: string;
	type: string;
	content: string;
	atEpochMillis: number;
}

export interface ModEntry {
	id: number;
	action: string;
	actor: string;
	reason: string;
	server: string;
	details: string;
	atEpochMillis: number;
}

export interface PermNode {
	key: string;
	value: boolean;
	type: string;
	expiryEpochMillis: number;
	contexts: Array<{ key: string; value: string }>;
}

/** Which login mode (Mojang or luna-auth password) the player is on and will get next. */
export interface LoginModeInfo {
	proxyOnlineMode: boolean;
	mixedMode: boolean;
	current: '' | 'online' | 'offline';
	preference: { mode: 'online' | 'offline'; rememberForever: boolean; expiresAtEpochMillis: number } | null;
	premium: {
		status: 'premium' | 'not_premium' | 'unknown';
		onlineUuid: string;
		source: string;
		checkedAtEpochMillis: number;
		error: string;
	};
	next: 'online' | 'offline' | 'ask' | 'online-if-premium';
	preferenceHours: number;
}

export interface AuthInfo {
	uuid: string;
	username: string;
	online: boolean;
	authenticated: boolean;
	registered: boolean;
	locked: boolean;
	lockedUntilEpochMillis: number;
	failedAttempts: number;
	lastIp: string;
	lastLoginAtEpochMillis: number;
	createdAtEpochMillis: number;
	temporaryPassword: boolean;
	temporaryPasswordUntilEpochMillis: number;
	temporaryPasswordExpired: boolean;
	session: {
		hasSession: boolean;
		connected: boolean;
		createdAtEpochMillis: number;
		expiresAtEpochMillis: number;
		ip: string;
	};
	/** Absent on luna-auth builds that predate login-mode reporting */
	loginMode?: LoginModeInfo;
}

export interface VaultInfo {
	uuid: string;
	username: string;
	online: boolean;
	hasAccount: boolean;
	balanceMinor: number;
	balance: number;
	balanceFormatted: string;
	rank: number;
	accountCount: number;
	currency: { symbol: string; grouping: boolean; scale: number };
	summary: {
		transactionCount: number;
		receivedMinor: number;
		receivedFormatted: string;
		sentMinor: number;
		sentFormatted: string;
		netMinor: number;
		netFormatted: string;
		firstAtEpochMillis: number;
		lastAtEpochMillis: number;
	};
}

export interface VaultTx {
	id: string;
	direction: 'in' | 'out' | 'self';
	counterpartyUuid: string;
	counterpartyName: string;
	system: boolean;
	amountMinor: number;
	amountFormatted: string;
	source: string;
	details: string;
	atEpochMillis: number;
}

/** The player on the backend they are connected to, as that backend's own player screen reads them. */
export interface LiveOnInstance {
	instance: string;
	/** Connected to this very backend, by the proxy's roster */
	online: boolean;
	live: { pingMillis: number; sessionMillis: number; clientVersion: string } | null;
	detail: {
		/** What the backend last saved; null until its first save of this player */
		snapshot: PlayerSnapshot | null;
		advancements: { done: number; total: number } | null;
	};
}

/** Where a player stands on the backends' access lists, by list. */
export interface AccessStanding {
	banned: string[];
	operator: string[];
	whitelisted: string[];
}

/** The profile's tabs, in bar order; `chat` is offered only to accounts that may read it. */
export const PLAYER_TABS = ['overview', 'account', 'economy', 'sessions', 'chat', 'permissions', 'moderation'] as const;

export type PlayerTab = (typeof PLAYER_TABS)[number];

/** Moderation actions that took something away, which a log draws in the failed colour. */
export const PUNITIVE_ACTIONS = ['ban', 'kick', 'ban-ip', 'bans-add'];

/** The badge state a moderation entry is drawn in. */
export function moderationState(action: string): string {
	return PUNITIVE_ACTIONS.includes(action)
		? 'failed'
		: 'passed';
}
