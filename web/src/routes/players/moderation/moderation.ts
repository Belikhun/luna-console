// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/** Shapes and reading helpers the moderation screen and its log tab share. */

import { firewallHref, looksLikeRange } from '$lib/firewall';
import { t } from '$lib/i18n.svelte';
import type { Series } from '$lib/components/chart';

/** One backend's answer to the lists request. */
export interface InstanceSummary {
	name: string;
	state: string;
	whitelistEnabled: boolean;
	enforceWhitelist: boolean;
	error?: string;
}

export interface BanRow {
	name: string;
	uuid: string;
	reason: string;
	source: string;
	created: string;
	expires: string;
	instances: string[];
}

export interface IpBanRow {
	ip: string;
	reason: string;
	source: string;
	created: string;
	expires: string;
	instances: string[];
}

export interface WhitelistRow {
	name: string;
	uuid: string;
	instances: string[];
}

export interface OpRow {
	name: string;
	uuid: string;
	level: number;
	bypassesPlayerLimit: boolean;
	instances: string[];
}

/** One line of LunaCore's network moderation log. */
export interface LogEntry {
	id: number;
	action: string;
	actor: string;
	reason: string;
	server: string;
	details: string;
	targetUuid: string;
	targetName: string;
	atEpochMillis: number;
}

export const MODERATION_TABS = ['logs', 'bans', 'whitelist', 'ops', 'ipbans'] as const;

export type ModerationTab = (typeof MODERATION_TABS)[number];

/** The screen's address for a tab; the log is the bare path. */
export function moderationHref(tab: ModerationTab): string {
	return tab === 'logs'
		? '/players/moderation'
		: `/players/moderation?tab=${tab}`;
}

/**
 * What an action does to its target, which is what the log colours and charts
 * by. LunaCore's action ids are open-ended, so anything unrecognised is `other`.
 */
export const ACTION_KINDS = ['ban', 'restrict', 'lift', 'access', 'other'] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

/** The kind an action id belongs to, read off the id's own words. */
export function actionKind(action: string): ActionKind {
	const id = action.toLowerCase();

	// before `ban` and `mute`: "unban" and "unmute" contain them
	if (id.includes('pardon') || id.includes('unban') || id.includes('unmute')) {
		return 'lift';
	}

	if (id.includes('ban')) {
		return 'ban';
	}

	if (id.includes('kick') || id.includes('mute') || id.includes('warn')) {
		return 'restrict';
	}

	if (id === 'op' || id === 'deop' || id.startsWith('ops-') || id.startsWith('whitelist')) {
		return 'access';
	}

	return 'other';
}

/** The `StatusBadge` state a kind is drawn with; `other` wears no badge. */
export const KIND_STATES: Readonly<Record<ActionKind, string>> = {
	ban: 'failed',
	restrict: 'warning',
	lift: 'ok',
	access: 'info',
	other: 'unknown'
};

/** A kind's colour in a chart: the same meaning its badge carries. */
export const KIND_COLORS: Readonly<Record<ActionKind, string>> = {
	ban: 'var(--chart-critical)',
	restrict: 'var(--chart-warning)',
	lift: 'var(--chart-good)',
	access: 'var(--chart-1)',
	other: 'var(--chart-muted)'
};

/** An action's name for a reader; the id itself for one this console has no words for. */
export function actionLabel(action: string): string {
	const key = `web.moderation.action.${action}`;
	const label = t(key);

	return label === key
		? action
		: label;
}

/** Whether an entry acted on an address rather than a player; an address has no profile to open. */
export function targetIsAddress(entry: Pick<LogEntry, 'targetUuid' | 'targetName'>): boolean {
	return !entry.targetUuid && looksLikeRange(entry.targetName);
}

/** Where an entry's target can be looked at: the firewall's check for an address, a profile for a player. */
export function targetHref(entry: Pick<LogEntry, 'targetUuid' | 'targetName'>): string | null {
	if (!entry.targetUuid && !entry.targetName) {
		return null;
	}

	if (targetIsAddress(entry)) {
		return firewallHref('check', { address: entry.targetName.split('/')[0] });
	}

	return `/players/${entry.targetUuid || entry.targetName}`;
}

const DAY_MS = 86_400_000;

/** Past this many days the chart counts by week, or its columns thin to hairlines. */
const MAX_DAILY_BUCKETS = 120;

/** The shortest span drawn, so a log one day old is not a single wide column. */
const MIN_DAILY_BUCKETS = 14;

/** Entries counted per day or per week and split by kind, ready for `StackedBars`. */
export interface LogBuckets {
	series: Series[];
	from: number;
	to: number;
	weekly: boolean;
}

function startOfDay(at: number): Date {
	const day = new Date(at);

	day.setHours(0, 0, 0, 0);

	return day;
}

/**
 * Bucket the loaded entries from the oldest one's day to today, in the
 * browser's own days. A bucket nothing happened in is a zero, not a gap: the
 * log was listening.
 */
export function bucketLog(entries: readonly LogEntry[], now: number = Date.now()): LogBuckets | null {
	if (entries.length === 0) {
		return null;
	}

	const oldest = entries.reduce((least, entry) => Math.min(least, entry.atEpochMillis), now);
	const today = startOfDay(now);
	const days = Math.round((today.getTime() - startOfDay(oldest).getTime()) / DAY_MS) + 1;
	const weekly = days > MAX_DAILY_BUCKETS;

	const step = weekly
		? 7
		: 1;

	const count = weekly
		? Math.ceil(days / 7)
		: Math.max(days, MIN_DAILY_BUCKETS);

	// stepping by calendar date keeps a bucket a whole local day across a clock change
	const starts: number[] = [];
	const cursor = new Date(today);

	cursor.setDate(cursor.getDate() - (count - 1) * step);

	for (let index = 0; index < count; index++) {
		starts.push(cursor.getTime());
		cursor.setDate(cursor.getDate() + step);
	}

	const end = cursor.getTime();
	const counts = new Map<ActionKind, number[]>();

	for (const entry of entries) {
		const kind = actionKind(entry.action);
		let slot = starts.length - 1;

		while (slot > 0 && (starts[slot] ?? 0) > entry.atEpochMillis) {
			slot--;
		}

		const row = counts.get(kind) ?? starts.map(() => 0);

		row[slot] = (row[slot] ?? 0) + 1;
		counts.set(kind, row);
	}

	const series: Series[] = ACTION_KINDS
		.filter((kind) => counts.has(kind))
		.map((kind) => ({
			key: kind,
			unit: 'count' as const,
			points: starts.map((start, index): [number, number | null] => [start, counts.get(kind)?.[index] ?? 0])
		}));

	return { series, from: starts[0] ?? end, to: end, weekly };
}
