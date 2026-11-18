// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The GeoIP database behind the firewall's country rules: DB-IP's free "IP to
 * Country Lite" (CC BY 4.0), one gzipped CSV of `start,end,country` rows a
 * month, IPv4 and IPv6 together.
 *
 * The newest download is parsed into sorted ranges held in memory, which is
 * what an address lookup reads. A country a rule names is turned into the
 * fewest prefixes covering its ranges (adjacent ranges merged first), which
 * the kernel's sets are written from. Every machine keeps its own copy under
 * `.cache/geoip/` in its cluster root, since each one writes its own table;
 * only this module reads the files, and `core/firewall.ts` decides when to
 * refresh. `LUNA_GEOIP_URL` points a test cluster at a stand-in server.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { cidrContains, formatCidr, parseAddress, parseCidr, rangeToCidrs, type Cidr } from "../shared/cidr";
import { PROTECTED_RANGES } from "../shared/firewall";
import { t } from "../shared/i18n";
import { root } from "./config";

/** One family's ranges, sorted by start; a country is an index into `countries`. */
interface FamilyTable {
	start: bigint[];
	end: bigint[];
	country: Uint16Array;
}

interface GeoTable {
	release: string;
	rows: number;
	bytes: number;
	countries: string[];
	v4: FamilyTable;
	v6: FamilyTable;
}

/** DB-IP's monthly download; `{yyyy}` and `{mm}` are the release. */
const GEOIP_URL = "https://download.db-ip.com/free/dbip-country-lite-{yyyy}-{mm}.csv.gz";

/** Where this machine keeps its downloads. */
export function geoipDir(): string {
	return join(root(), ".cache", "geoip");
}

let table: GeoTable | null = null;

/** Prefixes per country of the table in memory, computed when first asked. */
const prefixCache = new Map<string, { v4: string[]; v6: string[] }>();

const FILE_PATTERN = /^dbip-country-lite-(\d{4})-(\d{2})\.csv\.gz$/;

function fileName(release: string): string {
	return `dbip-country-lite-${release}.csv.gz`;
}

/** The release months on disk, newest first. */
async function releasesOnDisk(): Promise<string[]> {
	if (!existsSync(geoipDir())) {
		return [];
	}

	const out: string[] = [];

	for (const name of await readdir(geoipDir())) {
		const match = FILE_PATTERN.exec(name);

		if (match) {
			out.push(`${match[1]}-${match[2]}`);
		}
	}

	return out.sort().reverse();
}

/**
 * Parse a download into the table. Rows whose two ends are of different
 * families, or whose country is not two letters (DB-IP's `ZZ` included), are
 * skipped.
 */
function parseDatabase(release: string, gzipped: Uint8Array<ArrayBuffer>): GeoTable {
	const text = new TextDecoder().decode(Bun.gunzipSync(gzipped));
	const countries: string[] = [];
	const countryIndex = new Map<string, number>();
	const rows: Record<4 | 6, { start: bigint[]; end: bigint[]; country: number[] }> = {
		4: { start: [], end: [], country: [] },
		6: { start: [], end: [], country: [] },
	};
	let count = 0;

	for (const line of text.split("\n")) {
		const [startText, endText, codeText] = line.trim().split(",");

		if (!startText || !endText || !codeText) {
			continue;
		}

		const code = codeText.replace(/"/g, "").toUpperCase();

		if (!/^[A-Z]{2}$/.test(code) || code === "ZZ") {
			continue;
		}

		const start = parseAddress(startText.replace(/"/g, ""));
		const end = parseAddress(endText.replace(/"/g, ""));

		if (!start || !end || start.family !== end.family || end.value < start.value) {
			continue;
		}

		let index = countryIndex.get(code);

		if (index === undefined) {
			index = countries.length;
			countries.push(code);
			countryIndex.set(code, index);
		}

		const family = rows[start.family];

		family.start.push(start.value);
		family.end.push(end.value);
		family.country.push(index);
		count++;
	}

	if (count === 0) {
		throw new Error(t("core.firewall.geoEmpty"));
	}

	const build = (family: { start: bigint[]; end: bigint[]; country: number[] }): FamilyTable => {
		const order = family.start.map((_, index) => index);

		// DB-IP sorts its rows, but nothing here depends on that
		order.sort((left, right) => {
			const a = family.start[left]!;
			const b = family.start[right]!;

			return a < b
				? -1
				: a > b
					? 1
					: 0;
		});

		return {
			start: order.map((index) => family.start[index]!),
			end: order.map((index) => family.end[index]!),
			country: Uint16Array.from(order.map((index) => family.country[index]!)),
		};
	};

	return {
		release,
		rows: count,
		bytes: gzipped.byteLength,
		countries,
		v4: build(rows[4]),
		v6: build(rows[6]),
	};
}

/** What the database in memory is, for the status. */
export interface GeoDatabaseInfo {
	release: string;
	rows: number;
	bytes: number;
}

function info(geo: GeoTable): GeoDatabaseInfo {
	return { release: geo.release, rows: geo.rows, bytes: geo.bytes };
}

/** Load the newest download on disk into memory; null when there is none or none parses. */
export async function loadGeoDatabase(): Promise<GeoDatabaseInfo | null> {
	for (const release of await releasesOnDisk()) {
		try {
			const bytes = new Uint8Array(await Bun.file(join(geoipDir(), fileName(release))).arrayBuffer());

			table = parseDatabase(release, bytes);
			prefixCache.clear();

			return info(table);
		} catch {
			// a damaged file: try the month before
		}
	}

	return null;
}

/** The database in memory, or null. */
export function geoDatabase(): GeoDatabaseInfo | null {
	return table
		? info(table)
		: null;
}

/** The release month of a date, `2026-11`. */
export function releaseOf(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function previousRelease(release: string): string {
	const [year, month] = release.split("-").map(Number) as [number, number];
	const date = new Date(year, month - 2, 1);

	return releaseOf(date);
}

function urlOf(release: string): string {
	const [year = "", month = ""] = release.split("-");

	const template = process.env.LUNA_GEOIP_URL?.trim() || GEOIP_URL;

	return template.replace("{yyyy}", year).replace("{mm}", month);
}

/** Downloads read at most this much: the real file is a few megabytes. */
const MAX_DOWNLOAD = 256 * 1024 * 1024;

async function fetchRelease(release: string): Promise<Uint8Array<ArrayBuffer> | null> {
	const response = await fetch(urlOf(release), { signal: AbortSignal.timeout(180_000) });

	if (response.status === 404) {
		return null;
	}

	if (!response.ok) {
		throw new Error(t("core.firewall.geoHttp", { status: response.status }));
	}

	const body = new Uint8Array(await response.arrayBuffer());

	if (body.byteLength > MAX_DOWNLOAD) {
		throw new Error(t("core.firewall.geoTooLarge"));
	}

	return body;
}

/** Keep the newest two downloads. */
async function pruneDownloads(): Promise<void> {
	const releases = await releasesOnDisk();

	for (const release of releases.slice(2)) {
		await rm(join(geoipDir(), fileName(release)), { force: true });
	}
}

/**
 * Download this month's database (last month's when this month's is not out
 * yet), check that it parses, keep it on disk and swap it in. A failure
 * leaves the database in memory as it was and throws with the reason.
 */
export async function downloadGeoDatabase(now = new Date()): Promise<GeoDatabaseInfo> {
	const current = releaseOf(now);
	let release = current;
	let body = await fetchRelease(current);

	if (!body) {
		release = previousRelease(current);
		body = await fetchRelease(release);
	}

	if (!body) {
		throw new Error(t("core.firewall.geoNotFound", { release: current }));
	}

	const parsed = parseDatabase(release, body);

	await mkdir(geoipDir(), { recursive: true });

	const temp = join(geoipDir(), `.${randomBytes(6).toString("hex")}.tmp`);

	try {
		await writeFile(temp, body);
		await rename(temp, join(geoipDir(), fileName(release)));
	} catch (err) {
		await rm(temp, { force: true });

		throw err;
	}

	table = parsed;
	prefixCache.clear();
	await pruneDownloads();

	return info(parsed);
}

function search(family: FamilyTable, value: bigint): number {
	let low = 0;
	let high = family.start.length - 1;

	while (low <= high) {
		const middle = (low + high) >> 1;

		if (family.start[middle]! <= value) {
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}

	return high;
}

/** Loopback, private, CGNAT and link-local ranges: no visitor's country, whatever a database says. */
const PRIVATE_RANGES: Cidr[] = PROTECTED_RANGES
	.map((range) => parseCidr(range))
	.filter((cidr): cidr is Cidr => cidr !== null);

/**
 * The country an address is in, for what a person reads (a ban, a check):
 * null for a loopback or private address, which no country holds, as well
 * as where `lookupCountry` has none. One binary search.
 */
export function visitorCountry(address: string): string | null {
	const parsed = parseAddress(address);

	if (!parsed || PRIVATE_RANGES.some((cidr) => cidrContains(cidr, parsed))) {
		return null;
	}

	return lookupCountry(address);
}

/**
 * The country the database places an address in, or null without a database
 * or for an address it does not place. Rule matching reads this, the same
 * ranges the kernel's sets are written from.
 */
export function lookupCountry(address: string): string | null {
	if (!table) {
		return null;
	}

	const parsed = parseAddress(address);

	if (!parsed) {
		return null;
	}

	const family = parsed.family === 4
		? table.v4
		: table.v6;
	const index = search(family, parsed.value);

	if (index < 0 || family.end[index]! < parsed.value) {
		return null;
	}

	return table.countries[family.country[index]!] ?? null;
}

function familyPrefixes(familyId: 4 | 6, family: FamilyTable, index: number): string[] {
	const out: Cidr[] = [];
	let runStart: bigint | null = null;
	let runEnd = 0n;

	for (let row = 0; row < family.start.length; row++) {
		if (family.country[row] !== index) {
			continue;
		}

		const start = family.start[row]!;
		const end = family.end[row]!;

		if (runStart !== null && start <= runEnd + 1n) {
			if (end > runEnd) {
				runEnd = end;
			}

			continue;
		}

		if (runStart !== null) {
			out.push(...rangeToCidrs(familyId, runStart, runEnd));
		}

		runStart = start;
		runEnd = end;
	}

	if (runStart !== null) {
		out.push(...rangeToCidrs(familyId, runStart, runEnd));
	}

	return out.map(formatCidr);
}

/** A country's prefixes, per family; empty without a database or for a code it does not hold. */
export function countryPrefixes(code: string): { v4: string[]; v6: string[] } {
	const cached = prefixCache.get(code);

	if (cached) {
		return cached;
	}

	const index = table?.countries.indexOf(code) ?? -1;

	if (!table || index < 0) {
		return { v4: [], v6: [] };
	}

	const prefixes = {
		v4: familyPrefixes(4, table.v4, index),
		v6: familyPrefixes(6, table.v6, index),
	};

	prefixCache.set(code, prefixes);

	return prefixes;
}
