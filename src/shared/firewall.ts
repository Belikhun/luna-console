// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The network firewall's shapes, shared by the daemon, the CLI and the console.
 *
 * The firewall lives in LunaCore on the proxy: it answers every login and every
 * server-list ping before anything else does, so nothing it refuses reaches a
 * backend, the player directory or the chat relay. Backends are not reachable
 * from outside (they bind loopback, or a follower's address only the proxy
 * dials), which is why the proxy is the one place a rule has to hold.
 *
 * A connection is decided in this order: a ban refuses it, a protected range
 * lets it through, an allow rule lets it through (past the detectors too), a
 * deny rule refuses it, and last the detectors may turn what they saw into an
 * automatic ban. luna's part is the console and the GeoIP database: the proxy
 * holds no database of its own, so luna sends it the prefixes of every country
 * a rule names (`core/firewall.ts`).
 */

/** Ranges never refused and never banned: loopback, private, CGNAT, link-local, ULA. */
export const PROTECTED_RANGES: readonly string[] = [
	"127.0.0.0/8",
	"10.0.0.0/8",
	"172.16.0.0/12",
	"192.168.0.0/16",
	"100.64.0.0/10",
	"169.254.0.0/16",
	"::1/128",
	"fc00::/7",
	"fe80::/10",
];

/** What a rule does with a matching connection. */
export type FirewallAction = "allow" | "deny";

/**
 * One operator rule. It matches when every matcher it gives matches: an
 * address in `addresses` (when there are any) and a country in `countries`
 * (when there are any).
 */
export interface FirewallRule {
	id: string;
	action: FirewallAction;
	enabled: boolean;
	/** Addresses or prefixes, canonical text */
	addresses: string[];
	/** ISO 3166 two-letter codes */
	countries: string[];
	note: string;
	createdBy: string;
	createdAtEpochMillis: number;
	updatedAtEpochMillis: number;
	/** Connections it decided since it was made */
	hits: number;
	lastHitAtEpochMillis: number;
}

/** The detectors that ban on their own. */
export type FirewallDetector = "loginFlood" | "pingScan" | "suspiciousNames" | "failedLogins";

/** Every detector, in the order the console lists them. */
export const FIREWALL_DETECTORS: readonly FirewallDetector[] = [
	"loginFlood",
	"pingScan",
	"failedLogins",
	"suspiciousNames",
];

/** Why a connection was refused: a ban, a deny rule, or the detector that caught it. */
export type RefusalReason = "ban" | "rule" | FirewallDetector;

/** The firewall's settings, as LunaCore stores them. */
export interface FirewallSettings {
	/** Off: bans still hold, rules and detectors do nothing */
	enabled: boolean;
	loginFlood: boolean;
	/** Login attempts a minute one address may make */
	loginFloodPerMinute: number;
	pingScan: boolean;
	/** Server-list pings within `pingScanMinutes` that ban */
	pingScanCount: number;
	pingScanMinutes: number;
	suspiciousNames: boolean;
	/** Regular expressions a username is refused for */
	namePatterns: string[];
	failedLogins: boolean;
	/** Wrong passwords within `failedLoginMinutes`, across any accounts, that ban */
	failedLoginCount: number;
	failedLoginMinutes: number;
	/** Answer a refused ping with an empty entry rather than the real one */
	hidePingFromRefused: boolean;
	/** The first automatic ban's length */
	banMinutes: number;
	/** Each repeat ban is this many times the last */
	repeatMultiplier: number;
	/** The longest an automatic ban gets */
	maxBanDays: number;
	/** Extra ranges never refused, beside `PROTECTED_RANGES` */
	protect: string[];
}

/** One country the proxy holds prefixes for. */
export interface FirewallCountry {
	/** The GeoIP release the prefixes came from, `YYYY-MM` */
	release: string;
	prefixes: number;
}

/** Everything the firewall screen opens with. */
export interface FirewallOverview {
	/** False when LunaCore has no database, so nothing can be stored */
	available: boolean;
	settings: FirewallSettings;
	protectedRanges: string[];
	rules: FirewallRule[];
	countries: Record<string, FirewallCountry>;
	stats: {
		activeBans: number;
		automaticBans: number;
		refused24h: number;
	};
}

/** Where a ban came from: an operator, or the detector that decided it. */
export type BanSource = "manual" | FirewallDetector;

/** An address or prefix the proxy refuses. */
export interface FirewallBan {
	/** An address or a prefix, canonical text */
	ip: string;
	reason: string;
	actor: string;
	source: BanSource;
	/** How many times this address has been banned, this one included */
	strikes: number;
	createdAtEpochMillis: number;
	/** 0 = permanent */
	expiresAtEpochMillis: number;
	/** Refused connection attempts since the ban was placed */
	hits: number;
	lastHitAtEpochMillis: number;
}

/** How a ban ended. */
export type BanEnd = "expired" | "lifted" | "replaced";

/** A ban that no longer holds, kept for the record. */
export interface EndedBan {
	ip: string;
	reason: string;
	actor: string;
	source: BanSource;
	strikes: number;
	createdAtEpochMillis: number;
	expiresAtEpochMillis: number;
	hits: number;
	endedAtEpochMillis: number;
	ended: BanEnd;
	endedBy: string;
}

/** Refusals in one hour for one reason. */
export interface RefusalHour {
	/** The hour's start, epoch ms */
	hour: number;
	reason: RefusalReason;
	count: number;
}

/** Refusals of one address for one reason within one minute. */
export interface Refusal {
	at: number;
	ip: string;
	username: string;
	/** What was refused: a login or a server-list ping */
	kind: "login" | "ping";
	reason: RefusalReason;
	/** The ban's address, the rule's id, or what the detector counted */
	detail: string;
	count: number;
}

/** An address among the most refused in a window. */
export interface TopRefused {
	ip: string;
	count: number;
	lastAt: number;
	username: string;
}

/** The firewall's activity over a window. */
export interface FirewallActivity {
	from: number;
	to: number;
	hourly: RefusalHour[];
	recent: Refusal[];
	top: TopRefused[];
}

/** What the firewall would do with one address now, and why. */
export interface FirewallVerdict {
	ip: string;
	valid: boolean;
	protected: boolean;
	ban: FirewallBan | null;
	allowedBy: FirewallRule | null;
	deniedBy: FirewallRule[];
	/** The countries the proxy places it in, from the prefixes it holds */
	countries: string[];
	enabled: boolean;
	outcome: "banned" | "allowed" | "denied" | "invalid";
	/** Earlier bans of this address */
	strikes: number;
}

/** A rule as the console writes it. */
export interface FirewallRuleInput {
	/** Absent for a new rule */
	id?: string;
	action: FirewallAction;
	enabled: boolean;
	addresses: string[];
	countries: string[];
	note: string;
}

/** Where the DB-IP credit links, wherever its country data is shown. */
export const DBIP_ATTRIBUTION_URL = "https://db-ip.com";

/** Whether a two-letter code is shaped like a country. */
export function isCountryCode(code: string): boolean {
	return /^[A-Z]{2}$/.test(code);
}

/**
 * How long an automatic ban lasts: the first one `banMinutes`, each repeat
 * `repeatMultiplier` times the last, never past `maxBanDays`. Milliseconds.
 * The proxy computes the same; the console uses it to show the ladder.
 */
export function autobanLengthMs(settings: FirewallSettings, strike: number): number {
	const minutes = settings.banMinutes * settings.repeatMultiplier ** Math.max(0, strike - 1);
	const capped = Math.min(minutes, settings.maxBanDays * 24 * 60);

	return Math.round(capped * 60_000);
}
