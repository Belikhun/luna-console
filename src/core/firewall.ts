// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The network firewall, as luna drives it: LunaCore on the proxy enforces
 * (`shared/firewall.ts` says how), and this module reads and changes what it
 * holds over LunaCore's HTTP API, and keeps its country prefixes current.
 *
 * The proxy has no GeoIP database. A country a rule names reaches it as the
 * list of prefixes DB-IP places in that country, sent by `syncCountries`
 * after every rule change and once a day, so a new month's database reaches
 * the proxy without anybody touching a rule. Countries no rule names any more
 * are dropped from the proxy in the same pass.
 */

import type {
	EndedBan,
	FirewallActivity,
	FirewallOverview,
	FirewallRuleInput,
	FirewallSettings,
	FirewallVerdict,
} from "../shared/firewall";
import { isCountryCode } from "../shared/firewall";
import { t } from "../shared/i18n";
import { countryPrefixes, downloadGeoDatabase, geoDatabase, loadGeoDatabase, releaseOf, visitorCountry } from "./geoip";
import { call, type LunaResult } from "./services/luna";

/** A long country list is several megabytes of text; give the proxy time to store it. */
const COUNTRY_TIMEOUT_MS = 60_000;

/** The rules, settings, countries and headline counts. */
export async function firewallOverview(): Promise<LunaResult<FirewallOverview>> {
	return await call<FirewallOverview>("/network/firewall");
}

/** Change some settings; the rest keep their values. Answers the settings as stored. */
export async function updateFirewallSettings(
	values: Partial<FirewallSettings>,
): Promise<LunaResult<{ settings: FirewallSettings }>> {
	const form: Record<string, string> = {};

	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) {
			continue;
		}

		form[key] = Array.isArray(value)
			? value.join("\n")
			: String(value);
	}

	return await call<{ settings: FirewallSettings }>("/network/firewall/settings", { form });
}

/**
 * Add a rule, or replace the one with this id, then bring the proxy's
 * countries in line with what the rules name.
 */
export async function saveFirewallRule(
	rule: FirewallRuleInput,
	actor: string,
): Promise<LunaResult<{ saved: boolean; countries: CountrySync }>> {
	const countries = rule.countries.map((code) => code.trim().toUpperCase());
	const bad = countries.find((code) => !isCountryCode(code));

	if (bad !== undefined) {
		return { ok: false, status: 400, error: t("core.firewall.badCountry", { code: bad }) };
	}

	const form: Record<string, string> = {
		action: "save",
		rule: rule.action,
		enabled: String(rule.enabled),
		addresses: rule.addresses.join("\n"),
		countries: countries.join(","),
		note: rule.note,
		actor,
	};

	if (rule.id) {
		form.id = rule.id;
	}

	const result = await call<{ saved: boolean }>("/network/firewall/rules", { form });

	if (!result.ok) {
		return { ok: false, status: result.status, error: result.error };
	}

	return { ok: true, status: result.status, data: { saved: true, countries: await syncCountries() } };
}

/** Turn a rule on or off. */
export async function setFirewallRuleEnabled(id: string, enabled: boolean): Promise<LunaResult<{ changed: boolean }>> {
	const action = enabled
		? "enable"
		: "disable";

	return await call<{ changed: boolean }>("/network/firewall/rules", { form: { action, id } });
}

/** Remove a rule, then drop the countries nothing names any more. */
export async function removeFirewallRule(id: string): Promise<LunaResult<{ removed: boolean }>> {
	const result = await call<{ removed: boolean }>("/network/firewall/rules", { form: { action: "remove", id } });

	if (result.ok) {
		await syncCountries();
	}

	return result;
}

/** Refusals per hour, the latest refusals and the most refused addresses over a window. */
export async function firewallActivity(
	opts: { from?: number; to?: number; ip?: string; limit?: number } = {},
): Promise<LunaResult<FirewallActivity>> {
	const query = new URLSearchParams();

	for (const [key, value] of Object.entries(opts)) {
		if (value !== undefined && value !== "") {
			query.set(key, String(value));
		}
	}

	const suffix = query.size > 0
		? `?${query}`
		: "";

	return await call<FirewallActivity>(`/network/firewall/activity${suffix}`);
}

/** What the firewall would do with an address, plus the country luna's own database places it in. */
export async function checkFirewallAddress(
	ip: string,
): Promise<LunaResult<FirewallVerdict & { geoCountry: string | null }>> {
	const result = await call<FirewallVerdict>(`/network/firewall/check?ip=${encodeURIComponent(ip.trim())}`);

	if (!result.ok || !result.data) {
		return result as LunaResult<FirewallVerdict & { geoCountry: string | null }>;
	}

	await ensureGeoLoaded();

	return {
		...result,
		data: { ...result.data, geoCountry: result.data.valid ? visitorCountry(result.data.ip) : null },
	};
}

/** Bans that no longer hold, newest first; one address's when `ip` is given. */
export async function ipBanHistory(
	opts: { ip?: string; limit?: number } = {},
): Promise<LunaResult<{ total: number; bans: EndedBan[] }>> {
	const query = new URLSearchParams();

	if (opts.ip) {
		query.set("ip", opts.ip);
	}

	if (opts.limit) {
		query.set("limit", String(opts.limit));
	}

	const suffix = query.size > 0
		? `?${query}`
		: "";

	return await call<{ total: number; bans: EndedBan[] }>(`/network/ip-bans/history${suffix}`);
}

/** The country of an address by luna's own database, for screens that show one; null when unknown. */
export async function addressCountries(ips: string[]): Promise<Record<string, string | null>> {
	await ensureGeoLoaded();

	const out: Record<string, string | null> = {};

	for (const ip of ips) {
		out[ip] = visitorCountry(ip);
	}

	return out;
}

/** What a sync did with each country. */
export interface CountrySync {
	/** The GeoIP release the prefixes came from; null without a database */
	release: string | null;
	sent: string[];
	removed: string[];
	/** Countries the database does not hold */
	unknown: string[];
	error?: string;
}

let geoLoading: Promise<unknown> | null = null;

/** Load the newest download from disk once, and download one when there is none. */
async function ensureGeoLoaded(): Promise<void> {
	if (geoDatabase()) {
		return;
	}

	geoLoading ??= (async () => {
		const loaded = await loadGeoDatabase();

		if (!loaded) {
			await downloadGeoDatabase();
		}
	})().finally(() => {
		geoLoading = null;
	});

	await geoLoading;
}

/**
 * Bring the proxy's countries in line with the rules: send the prefixes of
 * each country a rule names whose copy on the proxy is missing or from an
 * older release, and drop the ones nothing names. Downloads a newer database
 * when this month's is not on disk yet; a failed download keeps the one held.
 */
export async function syncCountries(): Promise<CountrySync> {
	const out: CountrySync = { release: null, sent: [], removed: [], unknown: [] };
	const overview = await firewallOverview();

	if (!overview.ok || !overview.data) {
		out.error = overview.error ?? t("core.firewall.unavailable");

		return out;
	}

	const named = new Set<string>();

	for (const rule of overview.data.rules) {
		for (const code of rule.countries) {
			named.add(code.toUpperCase());
		}
	}

	try {
		await ensureGeoLoaded();

		if (named.size > 0 && geoDatabase()?.release !== releaseOf(new Date())) {
			await downloadGeoDatabase().catch(() => null);
		}
	} catch (err) {
		out.error = (err as Error).message;
	}

	const geo = geoDatabase();

	out.release = geo?.release ?? null;

	for (const code of Object.keys(overview.data.countries)) {
		if (named.has(code)) {
			continue;
		}

		const result = await call("/network/firewall/countries", { form: { action: "remove", code } });

		if (result.ok) {
			out.removed.push(code);
		}
	}

	if (!geo) {
		return out;
	}

	for (const code of named) {
		const held = overview.data.countries[code];

		if (held && held.release === geo.release) {
			continue;
		}

		const prefixes = countryPrefixes(code);
		const all = [...prefixes.v4, ...prefixes.v6];

		if (all.length === 0) {
			out.unknown.push(code);

			continue;
		}

		const result = await call(
			"/network/firewall/countries",
			{ form: { code, release: geo.release, prefixes: all.join("\n") }, timeoutMs: COUNTRY_TIMEOUT_MS },
		);

		if (result.ok) {
			out.sent.push(code);
		} else {
			out.error = result.error ?? t("core.firewall.countryFailed", { code });
		}
	}

	return out;
}
