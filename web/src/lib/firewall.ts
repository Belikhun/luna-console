// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * What the firewall's screens share: how a rule reads in one line, country
 * names, the list fields of the forms, the ban ladder and links between tabs.
 */

import { regionName } from '$lib/countries';
import { currentLanguage, t } from '$lib/i18n.svelte';
import { anyCidrContains, parseAddress, parseCidr } from '$shared/cidr';
import type { FirewallRule, FirewallSettings, RefusalReason } from '$shared/firewall';

/** The screen's tabs, in the bar's order; `activity` is the one without `?tab=`. */
export const FIREWALL_TABS = ['activity', 'bans', 'rules', 'autoban', 'check'] as const;

export type FirewallTab = (typeof FIREWALL_TABS)[number];

/** Every refusal reason, in the chart's stacking order. */
export const REFUSAL_REASONS: readonly RefusalReason[] = ['ban', 'rule', 'loginFlood', 'pingScan', 'failedLogins', 'suspiciousNames'];

/** The widest prefix a ban may name; wider ranges are a deny rule's job. */
export const BAN_MAX_V4_PREFIX = 16;
export const BAN_MAX_V6_PREFIX = 32;

type Query = Record<string, string | number | null | undefined>;

/** The firewall screen on a tab, with that tab's own query. */
export function firewallHref(tab: FirewallTab = 'activity', query: Query = {}): string {
	const search = new URLSearchParams();

	if (tab !== 'activity') {
		search.set('tab', tab);
	}

	for (const [key, value] of Object.entries(query)) {
		if (value === undefined || value === null || value === '') {
			continue;
		}

		search.set(key, String(value));
	}

	const text = search.toString();

	return text
		? `/network/firewall?${text}`
		: '/network/firewall';
}

/** A country's name in the console's language; the code itself when the browser knows none. */
export function countryName(code: string, language: string = currentLanguage()): string {
	return regionName(code, language);
}

/** A list field's entries: one per line, commas also separate, blanks dropped, repeats kept once. */
export function parseList(text: string): string[] {
	const seen = new Set<string>();

	for (const part of text.split(/[\n,]/)) {
		const entry = part.replace(/#.*$/, '').trim();

		if (entry !== '') {
			seen.add(entry);
		}
	}

	return [...seen];
}

/** Whether the text is one IPv4 or IPv6 address. */
export function looksLikeAddress(text: string): boolean {
	return !text.includes('/') && parseAddress(text.trim()) !== null;
}

/** Whether the text is an address or a prefix a rule can name. */
export function looksLikeRange(text: string): boolean {
	return parseCidr(text) !== null;
}

/** Whether the text is something a ban can name: an address, or a prefix no wider than a /16 (a /32 for IPv6). */
export function looksLikeBanTarget(text: string): boolean {
	const cidr = parseCidr(text.trim());

	if (!cidr) {
		return false;
	}

	const widest = cidr.family === 4
		? BAN_MAX_V4_PREFIX
		: BAN_MAX_V6_PREFIX;

	return cidr.prefix >= widest;
}

/** Whether a prefix, as text, holds an address; false when either does not parse. */
export function cidrContains(cidr: string, address: string): boolean {
	return anyCidrContains([cidr], address);
}

/** How many addresses a prefix holds, for the line under it; null for a single address. */
export function prefixSize(text: string): number | null {
	const cidr = parseCidr(text);

	if (!cidr) {
		return null;
	}

	const bits = cidr.family === 4
		? 32
		: 128;

	if (cidr.prefix === bits) {
		return null;
	}

	return 2 ** (bits - cidr.prefix);
}

/** How many values a matcher shows before the rest folds into a count. */
const SUMMARY_VALUES = 2;

function shortList(values: readonly string[]): string {
	const shown = values.slice(0, SUMMARY_VALUES).join(', ');
	const rest = values.length - SUMMARY_VALUES;

	return rest > 0
		? `${shown} +${rest}`
		: shown;
}

/** A rule in one line of text, for a menu's heading, a confirmation and the search. */
export function ruleSummary(rule: Pick<FirewallRule, 'addresses' | 'countries'>): string {
	const parts: string[] = [];

	if (rule.addresses.length > 0) {
		parts.push(shortList(rule.addresses));
	}

	if (rule.countries.length > 0) {
		parts.push(shortList(rule.countries));
	}

	return parts.join(' + ');
}

/** A rule's name where one rule is talked about: its note, else what it matches. */
export function ruleTitle(rule: Pick<FirewallRule, 'note' | 'addresses' | 'countries'>): string {
	return rule.note.trim() !== ''
		? rule.note
		: ruleSummary(rule);
}

/** What refused a connection, in words. */
export function reasonLabel(reason: string): string {
	return t(`web.firewall.reasons.${reason}`);
}

/** One rung of the automatic ban ladder. */
export interface LadderStep {
	/** Which ban of the same address this is, from 1 */
	n: number;
	ms: number;
	/** The longest a ban gets: every later ban lasts this long too */
	capped: boolean;
}

/** How many bans the ladder spells out before it jumps to the longest one. */
const LADDER_STEPS = 4;

/**
 * How long each ban of one address lasts: the first four, then the first one
 * that reaches the longest length. Settings that never reach it (a multiplier
 * of 1) give the four alone.
 */
export function banLadder(settings: Pick<FirewallSettings, 'banMinutes' | 'repeatMultiplier' | 'maxBanDays'>): LadderStep[] {
	const cap = settings.maxBanDays * 1440;
	const steps: LadderStep[] = [];

	if (!(settings.banMinutes >= 1) || !(settings.repeatMultiplier >= 1) || !(cap >= 1)) {
		return steps;
	}

	for (let n = 1; n <= 64; n++) {
		const minutes = settings.banMinutes * settings.repeatMultiplier ** (n - 1);

		if (minutes >= cap) {
			steps.push({ n, ms: cap * 60_000, capped: true });

			break;
		}

		if (n <= LADDER_STEPS) {
			steps.push({ n, ms: minutes * 60_000, capped: false });
		}

		if (settings.repeatMultiplier === 1 && n >= LADDER_STEPS) {
			break;
		}
	}

	return steps;
}

/** A piece of a sentence cut at its placeholders: plain text, or the place one of them takes. */
export type SentencePart = { text: string } | { slot: string };

// characters no translation holds, wrapped round a slot's number
const SLOT_OPEN = '\u0001';
const SLOT_CLOSE = '\u0002';

/**
 * A language string cut at several placeholders, in the translation's own
 * word order, so a control can stand in each: "more than [20] logins a
 * minute". `tSplit` does this for one placeholder.
 */
export function sentenceParts(key: string, slots: readonly string[]): SentencePart[] {
	const marks = Object.fromEntries(slots.map((slot, index) => [slot, `${SLOT_OPEN}${index}${SLOT_CLOSE}`]));
	const text = t(key, marks);
	const parts: SentencePart[] = [];

	for (const piece of text.split(/(\u0001\d+\u0002)/)) {
		if (piece === '') {
			continue;
		}

		const slot = piece.startsWith(SLOT_OPEN)
			? slots[Number(piece.slice(1, -1))]
			: undefined;

		parts.push(slot === undefined
			? { text: piece }
			: { slot });
	}

	return parts;
}

/** A length of time in the console's compact style, to the minute: `10m`, `2h 40m`, `3d 4h`. */
export function fmtSpan(ms: number): string {
	const minutes = Math.round(ms / 60_000);

	if (minutes < 60) {
		return `${minutes}m`;
	}

	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;

	if (hours < 24) {
		return restMinutes === 0
			? `${hours}h`
			: `${hours}h ${restMinutes}m`;
	}

	const days = Math.floor(hours / 24);
	const restHours = hours % 24;

	return restHours === 0
		? `${days}d`
		: `${days}d ${restHours}h`;
}
