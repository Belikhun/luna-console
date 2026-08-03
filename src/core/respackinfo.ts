/**
 * Everything about a resource pack that its registration does not say: what is
 * inside the zip, where the proxy tells clients to fetch it from, whether that
 * URL actually answers, which backends serve it, who is holding it right now,
 * and what the web server in front of the packs directory has been asked for.
 *
 * The pieces come from four independent places and any of them can be absent —
 * a zip may be missing, the proxy may be stopped, the access log may not be
 * readable, LunaPackLoader may be an older build. None of that is an error:
 * every section reports its own availability so the console can render the
 * parts it has (DESIGN.md §5 — an unavailable fact is shown as unavailable,
 * never as zero).
 */

import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";

import { instanceDir, managedInstances, root } from "./config";
import { getAllStatuses } from "./instances";
import type { PacksLock } from "./packslock";
import { listResourcePacks, respacksDir, type RespackRow } from "./respacks";
import * as lunaApi from "./services/luna";
import { sha512File } from "./services/download";
import type { AddonGroup, ClusterConfig } from "./types";

// -- zip reading ---------------------------------------------------------------

/** End-of-central-directory signature, and the largest tail it can hide in. */
const EOCD_SIGNATURE = 0x06054b50;
const EOCD_MAX_TAIL = 66_000;

const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_FIXED = 30;

/** A zip32 field this size means "see the zip64 record", which we do not read. */
const ZIP64_MARKER = 0xffffffff;

/** One file inside a pack zip, as its central-directory record describes it. */
export interface ZipEntry {
	name: string;
	compressedBytes: number;
	uncompressedBytes: number;
	/** 0 = stored, 8 = deflate; anything else we cannot decompress */
	method: number;
	localHeaderOffset: number;
}

/** Every entry of a zip, read from the central directory alone. */
export async function readZipEntries(path: string): Promise<ZipEntry[]> {
	const file = Bun.file(path);
	const size = file.size;

	if (size < 22) {
		throw new Error("not a zip file (too short)");
	}

	const tailSize = Math.min(size, EOCD_MAX_TAIL);
	const tail = Buffer.from(await file.slice(size - tailSize, size).arrayBuffer());

	let eocd = -1;

	for (let at = tail.length - 22; at >= 0; at--) {
		if (tail.readUInt32LE(at) === EOCD_SIGNATURE) {
			eocd = at;

			break;
		}
	}

	if (eocd < 0) {
		throw new Error("not a zip file (no end-of-central-directory record)");
	}

	const count = tail.readUInt16LE(eocd + 10);
	const directorySize = tail.readUInt32LE(eocd + 12);
	const directoryOffset = tail.readUInt32LE(eocd + 16);

	if (directoryOffset === ZIP64_MARKER || directorySize === ZIP64_MARKER) {
		throw new Error("zip64 archives are not supported");
	}

	const directory = Buffer.from(
		await file.slice(directoryOffset, directoryOffset + directorySize).arrayBuffer(),
	);

	const entries: ZipEntry[] = [];
	let at = 0;

	while (at + 46 <= directory.length && entries.length < count) {
		if (directory.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
			break;
		}

		const nameLength = directory.readUInt16LE(at + 28);
		const extraLength = directory.readUInt16LE(at + 30);
		const commentLength = directory.readUInt16LE(at + 32);

		entries.push({
			name: directory.subarray(at + 46, at + 46 + nameLength).toString("utf8"),
			method: directory.readUInt16LE(at + 10),
			compressedBytes: directory.readUInt32LE(at + 20),
			uncompressedBytes: directory.readUInt32LE(at + 24),
			localHeaderOffset: directory.readUInt32LE(at + 42),
		});

		at += 46 + nameLength + extraLength + commentLength;
	}

	return entries;
}

/**
 * Read one entry's bytes. The local header is re-read rather than trusted from
 * the central directory: only it knows how long *this* copy's name and extra
 * fields are, and the payload starts after them.
 */
export async function readZipEntry(
	path: string,
	entry: ZipEntry,
	limitBytes = 8 * 1024 * 1024,
): Promise<Buffer | undefined> {
	if (entry.uncompressedBytes > limitBytes) {
		return undefined;
	}

	if (entry.method !== 0 && entry.method !== 8) {
		return undefined;
	}

	const file = Bun.file(path);
	const header = Buffer.from(
		await file
			.slice(entry.localHeaderOffset, entry.localHeaderOffset + LOCAL_HEADER_FIXED)
			.arrayBuffer(),
	);

	if (header.length < LOCAL_HEADER_FIXED) {
		return undefined;
	}

	const start =
		entry.localHeaderOffset +
		LOCAL_HEADER_FIXED +
		header.readUInt16LE(26) +
		header.readUInt16LE(28);

	const raw = Buffer.from(await file.slice(start, start + entry.compressedBytes).arrayBuffer());

	return entry.method === 0 ? raw : inflateRawSync(raw);
}

// -- pack contents -------------------------------------------------------------

/** `pack.mcmeta` + the shape of the zip around it. */
export interface PackManifest {
	/** false when the zip could not be opened at all */
	readable: boolean;
	problem?: string;
	entries: number;
	uncompressedBytes: number;
	/** Directories at the root of the zip, e.g. assets, overlays */
	topLevel: string[];
	/** Namespaces under assets/, e.g. minecraft, luna */
	namespaces: string[];
	packFormat?: number;
	/** Formats the pack declares support for, as a rendered range */
	supportedFormats?: string;
	description?: string;
	/** The pack's own icon as a data URI, when it ships one small enough to show */
	icon?: string;
	hasIcon: boolean;
}

/** Largest pack.png we inline into the response — an icon, not a texture atlas. */
const MAX_ICON_BYTES = 512 * 1024;

/** Flatten a `pack.mcmeta` description, which may be a text component tree. */
function flattenDescription(value: unknown): string | undefined {
	if (typeof value === "string") {
		return value;
	}

	if (Array.isArray(value)) {
		return value.map(flattenDescription).filter(Boolean).join("");
	}

	if (typeof value === "object" && value !== null) {
		const node = value as Record<string, unknown>;
		const own = typeof node.text === "string" ? node.text : "";
		const extra = Array.isArray(node.extra) ? flattenDescription(node.extra) : "";

		return `${own}${extra ?? ""}`;
	}

	return undefined;
}

/** Render `supported_formats`, which is an int, a pair, or an object. */
function renderSupportedFormats(value: unknown): string | undefined {
	if (typeof value === "number") {
		return String(value);
	}

	if (Array.isArray(value) && value.length === 2) {
		return `${value[0]}–${value[1]}`;
	}

	if (typeof value === "object" && value !== null) {
		const node = value as Record<string, unknown>;
		const min = node.min_inclusive;
		const max = node.max_inclusive;

		if (typeof min === "number" && typeof max === "number") {
			return `${min}–${max}`;
		}
	}

	return undefined;
}

/** Read a pack zip's manifest, icon and shape without unpacking the whole thing. */
export async function readPackManifest(zipPath: string): Promise<PackManifest> {
	const empty: PackManifest = {
		readable: false,
		entries: 0,
		uncompressedBytes: 0,
		topLevel: [],
		namespaces: [],
		hasIcon: false,
	};

	let entries: ZipEntry[];

	try {
		entries = await readZipEntries(zipPath);
	} catch (err) {
		return { ...empty, problem: (err as Error).message };
	}

	const files = entries.filter((entry) => !entry.name.endsWith("/"));
	const topLevel = new Set<string>();
	const namespaces = new Set<string>();

	for (const entry of entries) {
		const [first, second] = entry.name.split("/");

		if (first && entry.name.includes("/")) {
			topLevel.add(first);
		}

		if (first === "assets" && second) {
			namespaces.add(second);
		}
	}

	const manifest: PackManifest = {
		readable: true,
		entries: files.length,
		uncompressedBytes: files.reduce((sum, entry) => sum + entry.uncompressedBytes, 0),
		topLevel: [...topLevel].sort(),
		namespaces: [...namespaces].sort(),
		hasIcon: entries.some((entry) => entry.name === "pack.png"),
	};

	const meta = entries.find((entry) => entry.name === "pack.mcmeta");

	if (meta) {
		try {
			const text = (await readZipEntry(zipPath, meta))?.toString("utf8") ?? "";
			const parsed = JSON.parse(text) as Record<string, unknown>;
			const pack = (parsed.pack ?? {}) as Record<string, unknown>;

			manifest.packFormat = typeof pack.pack_format === "number" ? pack.pack_format : undefined;
			manifest.description = flattenDescription(pack.description)?.trim() || undefined;
			manifest.supportedFormats = renderSupportedFormats(pack.supported_formats);
		} catch (err) {
			// a pack.mcmeta the client would also reject — worth saying so, but the
			// rest of the manifest is still good
			manifest.problem = `pack.mcmeta is unreadable: ${(err as Error).message}`;
		}
	} else {
		manifest.problem = "no pack.mcmeta — the client will reject this pack";
	}

	const icon = entries.find((entry) => entry.name === "pack.png");

	if (icon) {
		const bytes = await readZipEntry(zipPath, icon, MAX_ICON_BYTES);

		if (bytes) {
			manifest.icon = `data:image/png;base64,${bytes.toString("base64")}`;
		}
	}

	return manifest;
}

// -- where the proxy serves packs from -------------------------------------------

/** Where LunaPackLoader keeps its config, relative to the proxy directory. */
const LOADER_CONFIG = join("plugins", "lunapackloader", "config.yml");

/** How the proxy hands packs to clients. */
export interface PackServeConfig {
	/** Base URL the proxy prefixes to each pack file name */
	baseUrl: string;
	/** Directory the plugin reads pack files from, as configured */
	packPath: string;
	/** Whether that directory is the one luna manages */
	managedPath: boolean;
	/** "built-in" runs a loopback HTTP server — reachable to the proxy, nobody else */
	builtIn: boolean;
	/** Why the config could not be read, when it could not */
	problem?: string;
}

/** Read one `key: value` out of a flat YAML file without pulling in a parser. */
function readFlatScalar(yaml: string, key: string): string | undefined {
	const line = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(yaml);

	if (!line) {
		return undefined;
	}

	return line[1]!.trim().replace(/^["']|["']$/g, "");
}

/**
 * Read the proxy's LunaPackLoader configuration: the base URL clients are sent
 * to, and the directory the plugin serves from. `pack-path` is resolved the way
 * the plugin resolves it — relative to the proxy's working directory, which is
 * the instance directory the screen session starts in.
 */
export async function packServeConfig(
	cfg: ClusterConfig,
	proxyName = "proxy",
): Promise<PackServeConfig> {
	const inst = managedInstances(cfg)[proxyName];
	const proxyDir = inst ? instanceDir(inst) : join(root(), proxyName);
	const configPath = join(proxyDir, LOADER_CONFIG);

	const fallback: PackServeConfig = {
		baseUrl: "",
		packPath: "",
		managedPath: false,
		builtIn: false,
		problem: "LunaPackLoader is not installed on the proxy",
	};

	if (!existsSync(configPath)) {
		return fallback;
	}

	const yaml = await Bun.file(configPath).text();
	const rawBase = readFlatScalar(yaml, "base-url") ?? "";
	const rawPath = readFlatScalar(yaml, "pack-path") ?? "plugins/lunapackloader/packs";
	const builtIn = rawBase.trim().toLowerCase() === "built-in";
	const resolved = rawPath.startsWith("/") ? rawPath : join(proxyDir, rawPath);

	return {
		baseUrl: builtIn ? "built-in" : rawBase.replace(/\/*$/, "/"),
		packPath: resolved,
		managedPath: resolved === respacksDir(),
		builtIn,
		problem: !rawBase ? "base-url is not set in the proxy's config.yml" : undefined,
	};
}

/** The URL a client is told to download one pack from. */
export function packUrl(serve: PackServeConfig, filename: string): string | undefined {
	if (!serve.baseUrl || serve.builtIn) {
		return undefined;
	}

	return `${serve.baseUrl}${encodeURIComponent(filename)}`;
}

// -- is that URL actually reachable ------------------------------------------------

/** The result of asking the pack's own URL for the pack. */
export interface PackReachability {
	checked: boolean;
	url?: string;
	ok: boolean;
	status?: number;
	contentType?: string;
	contentLength?: number;
	/** Whether the served length matches the zip on disk */
	sizeMatches?: boolean;
	elapsedMs?: number;
	problem?: string;
	/** When this answer was measured, epoch ms */
	at?: number;
	/** True when it is the stored answer rather than one measured just now */
	cached?: boolean;
	/** What caused the measurement: nothing had one yet, an operator asked, or
	 *  the proxy logged a player failing to load the pack */
	trigger?: "first" | "manual" | "failure" | "moved";
}

/** A client that cannot fetch a pack in this long has effectively failed. */
const PROBE_TIMEOUT_MS = 8000;

/**
 * Fetch the pack's own URL the way a client would. HEAD first — a zip is not
 * something to download twice for a status line — falling back to a one-byte
 * ranged GET for servers that refuse HEAD.
 */
export async function probePackUrl(url: string, diskBytes?: number): Promise<PackReachability> {
	const started = Date.now();

	const attempt = async (method: "HEAD" | "GET"): Promise<Response> => {
		return await fetch(url, {
			method,
			headers: method === "GET" ? { Range: "bytes=0-0" } : {},
			redirect: "follow",
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
	};

	try {
		let response = await attempt("HEAD");

		if (response.status === 405 || response.status === 501) {
			response = await attempt("GET");
		}

		// a ranged GET answers 206 with its own (tiny) length, so the full size
		// comes from Content-Range when the body was ranged
		const range = response.headers.get("content-range");
		const rangeTotal = range ? Number(range.split("/")[1]) : NaN;
		const header = Number(response.headers.get("content-length"));
		const length = Number.isFinite(rangeTotal) ? rangeTotal : Number.isFinite(header) ? header : undefined;

		return {
			checked: true,
			url,
			ok: response.ok || response.status === 206,
			status: response.status,
			contentType: response.headers.get("content-type") ?? undefined,
			contentLength: length,
			sizeMatches: length !== undefined && diskBytes !== undefined ? length === diskBytes : undefined,
			elapsedMs: Date.now() - started,
		};
	} catch (err) {
		const timedOut = (err as Error)?.name === "TimeoutError";

		return {
			checked: true,
			url,
			ok: false,
			elapsedMs: Date.now() - started,
			problem: timedOut ? `no response within ${PROBE_TIMEOUT_MS}ms` : ((err as Error)?.message ?? String(err)),
		};
	}
}

// -- what the proxy says about players failing to load a pack ------------------------

/** One failed pack load, as luna-pack logged it on the proxy. */
export interface PackLoadFailure {
	at: number;
	player: string;
	/** The client's own verdict: DECLINED, FAILED_DOWNLOAD, INVALID_URL, … */
	status: string;
}

/** Recent failed loads of one pack, oldest first, or why there are none to read. */
export interface PackFailures {
	available: boolean;
	problem?: string;
	failures: PackLoadFailure[];
	/** Newest failure's timestamp, epoch ms */
	lastAt?: number;
}

/** Failures kept per pack — enough to see a pattern, not a log viewer. */
const MAX_FAILURES = 20;

/**
 * luna-pack's failure line, which is what a client refusing or failing a pack
 * ends up as on the proxy: `<player> lỗi pack <Pack Name>: <STATUS>`. The status
 * is anchored to the end of the line so a pack name containing a colon cannot
 * eat it.
 */
const FAILURE_LINE = /^\[(\d{2}):(\d{2}):(\d{2})\].*?(\S+) lỗi pack (.+?): ([A-Z_]+)\s*$/;

/**
 * Read the proxy's live log for players failing to load one pack.
 *
 * Only `latest.log` is read: a failure old enough to have rotated out says
 * nothing about whether the pack is reachable *now*, which is the question this
 * feeds. Timestamps in the log carry no date, so they are anchored to the file's
 * own mtime — and a line whose clock time is later than the file's belongs to
 * the day before, since log4j rolls the file at midnight.
 */
export async function packLoadFailures(
	cfg: ClusterConfig,
	packName: string,
	proxyName = "proxy",
): Promise<PackFailures> {
	const inst = managedInstances(cfg)[proxyName];

	if (!inst) {
		return { available: false, problem: `there is no ${proxyName} instance`, failures: [] };
	}

	const path = join(instanceDir(inst), "logs", "latest.log");

	if (!existsSync(path)) {
		return { available: false, problem: "the proxy has no live log to read", failures: [] };
	}

	const info = await stat(path);
	const anchor = new Date(info.mtimeMs);
	const wanted = packName.trim().toLowerCase();
	const failures: PackLoadFailure[] = [];

	for (const line of (await Bun.file(path).text()).split("\n")) {
		if (!line.includes(" lỗi pack ")) {
			continue;
		}

		const match = FAILURE_LINE.exec(line);

		if (!match || match[5]!.trim().toLowerCase() !== wanted) {
			continue;
		}

		const at = new Date(anchor);

		at.setHours(Number(match[1]), Number(match[2]), Number(match[3]), 0);

		// a clock time ahead of the file's own mtime cannot be from today
		if (at.getTime() > info.mtimeMs) {
			at.setDate(at.getDate() - 1);
		}

		failures.push({ at: at.getTime(), player: match[4]!, status: match[6]! });
	}

	const kept = failures.slice(-MAX_FAILURES);

	return { available: true, failures: kept, lastAt: kept.at(-1)?.at };
}

// -- traffic, from the web server in front of the packs directory --------------------

/**
 * Access log of the server that publishes the packs directory. nginx's default
 * on this cluster; `LUNA_PACK_ACCESS_LOG` points at another one (or at several,
 * comma-separated) when the packs are published from somewhere else.
 */
const DEFAULT_ACCESS_LOG = "/var/log/nginx/access.log";

/** Rotated logs are read too, but a full history is not worth an unbounded read. */
const MAX_SCAN_BYTES = 64 * 1024 * 1024;

/** Individual request rows kept per pack, newest last. */
const MAX_RECENT = 50;

/** One request for a pack file, as the access log recorded it. */
export interface PackRequest {
	at: number;
	ip: string;
	status: number;
	bytes: number;
	userAgent: string;
}

/** What the access log says about one pack file. */
export interface PackTraffic {
	available: boolean;
	problem?: string;
	/** Log files that were actually read */
	sources: string[];
	/** Oldest and newest timestamps seen in those files, for any request */
	windowFrom?: number;
	windowTo?: number;
	requests: number;
	/** 200/206 — the client got the pack */
	completed: number;
	/** 404/410 — the URL is registered but the file is not there */
	missing: number;
	bytes: number;
	uniqueClients: number;
	lastAt?: number;
	/** Per-day totals, oldest first, as YYYY-MM-DD */
	daily: Array<{ day: string; requests: number; bytes: number }>;
	recent: PackRequest[];
}

const MONTHS: Record<string, number> = {
	Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
	Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

// combined log format: host - user [time] "method path proto" status bytes "ref" "ua"
const LOG_LINE =
	/^(\S+) \S+ \S+ \[([^\]]+)\] "([A-Z]+) ([^" ]+)[^"]*" (\d{3}) (\S+)(?: "[^"]*" "([^"]*)")?/;

/** Parse `03/Aug/2026:13:51:00 +0700` into epoch milliseconds. */
function parseLogTime(stamp: string): number | undefined {
	const match = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{2})(\d{2})$/.exec(stamp);

	if (!match) {
		return undefined;
	}

	const month = MONTHS[match[2]!];

	if (!month) {
		return undefined;
	}

	const iso =
		`${match[3]}-${String(month).padStart(2, "0")}-${match[1]}` +
		`T${match[4]}:${match[5]}:${match[6]}${match[7]}:${match[8]}`;

	const at = Date.parse(iso);

	return Number.isFinite(at) ? at : undefined;
}

/** Every access log to scan, newest first — the live one plus its rotations. */
async function accessLogFiles(): Promise<string[]> {
	const configured = process.env.LUNA_PACK_ACCESS_LOG;

	if (configured) {
		return configured.split(",").map((entry) => entry.trim()).filter((entry) => existsSync(entry));
	}

	if (!existsSync(DEFAULT_ACCESS_LOG)) {
		return [];
	}

	const dir = dirname(DEFAULT_ACCESS_LOG);
	const base = basename(DEFAULT_ACCESS_LOG);
	const siblings = (await readdir(dir)).filter((file) => file === base || file.startsWith(`${base}.`));

	// newest first: the live log, then .1, .2.gz … — which is also the order the
	// byte budget should spend itself in
	const ranked = await Promise.all(
		siblings.map(async (file) => ({
			path: join(dir, file),
			at: (await stat(join(dir, file))).mtimeMs,
		})),
	);

	return ranked.sort((a, b) => b.at - a.at).map((entry) => entry.path);
}

interface ScannedLogs {
	byPath: Map<string, PackRequest[]>;
	sources: string[];
	windowFrom?: number;
	windowTo?: number;
	problem?: string;
}

/** Cache key of a scan: the logs it read, at the size they were when read. */
let scanCache: { key: string; result: ScannedLogs } | undefined;

/**
 * Scan the access logs once for every request under the packs URL prefix, keyed
 * by the requested path. One scan serves every pack — per-pack scanning would
 * re-read tens of megabytes for each row of a table.
 *
 * Cached against the logs' own sizes: a rotation or an appended line changes
 * the key, anything else reuses the parse.
 */
async function scanAccessLogs(prefix: string): Promise<ScannedLogs> {
	const files = await accessLogFiles();

	if (!files.length) {
		return {
			byPath: new Map(),
			sources: [],
			problem: process.env.LUNA_PACK_ACCESS_LOG
				? "none of the configured access logs exist"
				: `no access log at ${DEFAULT_ACCESS_LOG} (set LUNA_PACK_ACCESS_LOG)`,
		};
	}

	const stats = await Promise.all(
		files.map(async (path) => {
			try {
				const info = await stat(path);

				return { path, size: info.size, mtimeMs: info.mtimeMs };
			} catch {
				return { path, size: -1, mtimeMs: 0 };
			}
		}),
	);

	const key = `${prefix}|${stats.map((entry) => `${entry.path}:${entry.size}:${entry.mtimeMs}`).join(",")}`;

	if (scanCache?.key === key) {
		return scanCache.result;
	}

	const result: ScannedLogs = { byPath: new Map(), sources: [] };
	let budget = MAX_SCAN_BYTES;
	let denied = 0;

	for (const entry of stats) {
		if (budget <= 0 || entry.size < 0) {
			continue;
		}

		let text: string;

		try {
			const raw = Buffer.from(await Bun.file(entry.path).arrayBuffer());

			text = entry.path.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
		} catch (err) {
			// the usual one: nginx logs are root:adm, and this daemon is not in adm
			if (/permission denied/i.test((err as Error).message ?? "")) {
				denied++;
			}

			continue;
		}

		budget -= entry.size;
		result.sources.push(entry.path);

		for (const line of text.split("\n")) {
			if (!line.includes(prefix)) {
				continue;
			}

			const match = LOG_LINE.exec(line);

			if (!match) {
				continue;
			}

			// a HEAD is a reachability check, not a download — luna's own probe is
			// one of them, and counting it would make the console its own traffic
			if (match[3] !== "GET") {
				continue;
			}

			const at = parseLogTime(match[2]!);

			if (at === undefined) {
				continue;
			}

			result.windowFrom = result.windowFrom === undefined ? at : Math.min(result.windowFrom, at);
			result.windowTo = result.windowTo === undefined ? at : Math.max(result.windowTo, at);

			const path = decodeURIComponent((match[4] ?? "").split("?")[0] ?? "");

			if (!path.startsWith(prefix)) {
				continue;
			}

			const rows = result.byPath.get(path) ?? [];

			rows.push({
				ip: match[1] ?? "?",
				at,
				status: Number(match[5] ?? 0),
				bytes: Number(match[6] === "-" ? 0 : match[6]),
				userAgent: match[7] ?? "",
			});

			result.byPath.set(path, rows);
		}
	}

	if (!result.sources.length) {
		result.problem = denied
			? `access logs are not readable by this daemon (${denied} file(s) denied)`
			: "no access log could be read";
	}

	scanCache = { key, result };

	return result;
}

/** Local-day bucket of a timestamp, as YYYY-MM-DD. */
function dayOf(at: number): string {
	const date = new Date(at);

	return (
		`${date.getFullYear()}-` +
		`${String(date.getMonth() + 1).padStart(2, "0")}-` +
		`${String(date.getDate()).padStart(2, "0")}`
	);
}

/**
 * Everything the access logs know about one pack file: how often it was
 * fetched, by how many distinct clients, how many bytes that cost and when it
 * last happened.
 */
export async function packTraffic(serve: PackServeConfig, filename: string): Promise<PackTraffic> {
	const empty: PackTraffic = {
		available: false,
		sources: [],
		requests: 0,
		completed: 0,
		missing: 0,
		bytes: 0,
		uniqueClients: 0,
		daily: [],
		recent: [],
	};

	if (serve.builtIn) {
		return { ...empty, problem: "the proxy serves packs itself (base-url: built-in) — no web server log to read" };
	}

	if (!serve.baseUrl) {
		return { ...empty, problem: serve.problem ?? "the proxy has no pack base URL configured" };
	}

	let prefix: string;

	try {
		prefix = new URL(serve.baseUrl).pathname;
	} catch {
		return { ...empty, problem: `base-url is not a URL: ${serve.baseUrl}` };
	}

	const scan = await scanAccessLogs(prefix);

	if (scan.problem) {
		return { ...empty, problem: scan.problem, sources: scan.sources };
	}

	const rows = (scan.byPath.get(`${prefix}${filename}`) ?? []).sort((a, b) => a.at - b.at);
	const clients = new Set(rows.map((row) => row.ip));
	const perDay = new Map<string, { day: string; requests: number; bytes: number }>();

	for (const row of rows) {
		const day = dayOf(row.at);
		const bucket = perDay.get(day) ?? { day, requests: 0, bytes: 0 };

		bucket.requests++;
		bucket.bytes += row.bytes;
		perDay.set(day, bucket);
	}

	return {
		available: true,
		sources: scan.sources,
		windowFrom: scan.windowFrom,
		windowTo: scan.windowTo,
		requests: rows.length,
		completed: rows.filter((row) => row.status === 200 || row.status === 206).length,
		missing: rows.filter((row) => row.status === 404 || row.status === 410).length,
		bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
		uniqueClients: clients.size,
		lastAt: rows.at(-1)?.at,
		daily: [...perDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
		recent: rows.slice(-MAX_RECENT),
	};
}

// -- who is holding the pack right now ------------------------------------------------

/** One player's pack state, as LunaPackLoader reports it. */
export interface PackHolder {
	uuid: string;
	username: string;
	server?: string;
	/** Whether this specific pack is loaded on their client */
	loaded: boolean;
	/** Whether it has been sent and not yet answered */
	pending: boolean;
	lastFailure?: string;
}

/** The live per-player view, or why there isn't one. */
export interface PackHolders {
	available: boolean;
	problem?: string;
	/** Every online player, with their state for this pack */
	players: PackHolder[];
	loaded: number;
	pending: number;
	online: number;
}

/**
 * Ask the proxy which players are currently holding a pack. Needs a
 * LunaPackLoader new enough to expose the route; an older one 404s, which is
 * reported as unavailable rather than as "nobody has it".
 */
export async function packHolders(packName: string): Promise<PackHolders> {
	const normalized = packName.trim().toLowerCase();
	const result = await lunaApi.packSessions();

	if (!result.ok) {
		return {
			available: false,
			problem:
				result.status === 404
					? "the proxy's LunaPackLoader is older than the pack-session endpoint"
					: (result.error ?? "the proxy did not answer"),
			players: [],
			loaded: 0,
			pending: 0,
			online: 0,
		};
	}

	const players = (result.data?.players ?? []).map((entry) => ({
		uuid: entry.uuid ?? "",
		username: entry.username ?? "?",
		server: entry.server || undefined,
		loaded: (entry.loaded ?? []).some((name) => name.toLowerCase() === normalized),
		pending: (entry.pending ?? []).some((name) => name.toLowerCase() === normalized),
		lastFailure: entry.lastFailure || undefined,
	}));

	return {
		available: true,
		players,
		loaded: players.filter((player) => player.loaded).length,
		pending: players.filter((player) => player.pending).length,
		online: players.length,
	};
}

// -- the whole picture -----------------------------------------------------------------

/** A stored reachability answer, and what it already knows about. */
interface CachedProbe {
	/** The URL that was probed — a pack whose URL moved needs a fresh answer */
	url: string;
	result: PackReachability;
	/** Newest failure timestamp at the time of the probe */
	seenFailureAt?: number;
}

/**
 * Reachability answers, kept per pack.
 *
 * Probing means an outbound HTTP request to the public pack host, and the answer
 * changes when the web server changes — not when a console page ticks. So it is
 * measured once, then only again when an operator asks (`retest`) or when the
 * proxy logs a player failing to load the pack, which is the one event that says
 * the stored answer may have gone wrong. Held in memory: a daemon restart simply
 * measures again on the next look.
 */
const probeCache = new Map<string, CachedProbe>();

/** Forget a pack's stored reachability — used when its file or URL changes. */
export function forgetPackReachability(key: string): void {
	probeCache.delete(key);
}

/** Digests keyed by identity of the file that produced them. */
const digestCache = new Map<string, string>();

/**
 * sha512 of a pack zip, cached against the file's own size and mtime. The
 * detail view refreshes on a timer and hashing a 13 MB zip every tick would be
 * the most expensive thing on the page, for an answer that cannot change while
 * the file does not.
 */
async function cachedDigest(path: string, sizeBytes: number, mtimeMs?: number): Promise<string> {
	const key = `${path}:${sizeBytes}:${mtimeMs ?? 0}`;
	const hit = digestCache.get(key);

	if (hit) {
		return hit;
	}

	const digest = await sha512File(path);

	// one entry per pack file is the steady state; a rewritten pack leaves its
	// old key behind, so the map is trimmed rather than grown
	if (digestCache.size > 64) {
		digestCache.clear();
	}

	digestCache.set(key, digest);

	return digest;
}

/** One backend's relationship to a pack. */
export interface PackInstanceUse {
	name: string;
	/** The rules match this backend */
	matched: boolean;
	/** An addon group is what puts it in the list */
	granted: boolean;
	running: boolean;
	/** Whether players on it are actually offered the pack (matched + enabled) */
	served: boolean;
}

/** What the running proxy resolved this pack to, or why it has nothing. */
export interface PackResolution {
	available: boolean;
	problem?: string;
	/** Present when the proxy holds a resolved copy of this pack */
	resolved?: lunaApi.ResolvedPackInfo;
	/** The reload report of the catalog the proxy is currently serving */
	report?: lunaApi.PackCatalog["report"];
}

/**
 * How the proxy itself resolved a pack: the URL and sha1 it hands clients, or
 * the reason it dropped the definition. This is the only view that reflects the
 * *running* catalog — everything else here reads the directory, which may have
 * changed since the last reload.
 */
export async function packResolution(packName: string): Promise<PackResolution> {
	const normalized = packName.trim().toLowerCase();
	const result = await lunaApi.packCatalog();

	if (!result.ok) {
		return {
			available: false,
			problem:
				result.status === 404
					? "the proxy's LunaPackLoader is older than the pack-catalog endpoint"
					: (result.error ?? "the proxy did not answer"),
		};
	}

	return {
		available: true,
		resolved: result.data?.packs.find((entry) => entry.normalizedName === normalized),
		report: result.data?.report,
	};
}

/** Everything the pack detail view renders. */
export interface RespackDetail {
	pack: RespackRow;
	/** Absolute path of the zip */
	path: string;
	/** Last write of the zip, epoch ms */
	modifiedAt?: number;
	/** sha512 of the file on disk, and whether it still matches the lock */
	sha512?: string;
	modifiedSinceInstall?: boolean;
	manifest: PackManifest;
	serve: PackServeConfig;
	url?: string;
	reachability: PackReachability;
	instances: PackInstanceUse[];
	resolution: PackResolution;
	holders: PackHolders;
	failures: PackFailures;
	traffic: PackTraffic;
}

/**
 * Assemble one pack's full picture. Every section is independent and best
 * effort, so the remote-ish parts (statuses, the proxy's two views, the log
 * scans) run together rather than in series.
 *
 * Reachability is the exception: it is *not* measured per call. It comes from
 * the stored answer, and is measured only when there is none, when `retest` asks
 * for one, when the URL has moved, or when the proxy has logged a player failing
 * to load the pack since the stored answer was taken.
 */
export async function resourcePackDetail(
	cfg: ClusterConfig,
	lock: PacksLock,
	key: string,
	groups?: Record<string, AddonGroup>,
	opts: { retest?: boolean } = {},
): Promise<RespackDetail> {
	const rows = await listResourcePacks(cfg, lock, groups);
	const pack = rows.find((candidate) => candidate.key === key);

	if (!pack) {
		throw new Error(`unknown resource pack: ${key}`);
	}

	const path = join(respacksDir(), pack.filename);
	const serve = await packServeConfig(cfg);
	const url = packUrl(serve, pack.filename);

	const manifest = pack.present
		? await readPackManifest(path)
		: {
				readable: false,
				problem: `the definition points at ${pack.filename}, which does not exist`,
				entries: 0,
				uncompressedBytes: 0,
				topLevel: [],
				namespaces: [],
				hasIcon: false,
			};

	const [statuses, resolution, holders, failures, traffic, fileInfo] = await Promise.all([
		getAllStatuses(cfg),
		packResolution(pack.name),
		packHolders(pack.name),
		packLoadFailures(cfg, pack.name),
		packTraffic(serve, pack.filename),
		pack.present ? stat(path).catch(() => undefined) : Promise.resolve(undefined),
	]);

	const reachability = await storedReachability(key, url, pack, serve, failures, opts.retest);

	const running = new Set(statuses.filter((status) => status.state === "running").map((status) => status.name));

	const sha512 = pack.present
		? await cachedDigest(path, pack.sizeBytes, fileInfo?.mtimeMs)
		: undefined;
	const installed = lock.resourcepacks[key]?.installed?.sha512;

	return {
		pack,
		path,
		modifiedAt: fileInfo?.mtimeMs,
		sha512,
		modifiedSinceInstall: sha512 && installed ? sha512 !== installed : undefined,
		manifest,
		serve,
		url,
		reachability,
		instances: Object.keys(cfg.instances)
			.filter((name) => name !== "proxy")
			.sort()
			.map((name) => ({
				name,
				matched: pack.matched.includes(name),
				granted: pack.granted.includes(name),
				running: running.has(name),
				served: pack.matched.includes(name) && pack.enabled,
			})),
		resolution,
		holders,
		failures,
		traffic,
	};
}

/**
 * The pack's reachability: the stored answer, measured afresh only when there is
 * a reason to. `trigger` says which reason it was, so the console can explain
 * why the number moved without the operator having asked.
 */
async function storedReachability(
	key: string,
	url: string | undefined,
	pack: RespackRow,
	serve: PackServeConfig,
	failures: PackFailures,
	retest?: boolean,
): Promise<PackReachability> {
	// nothing to measure: say why, and never cache a non-answer — the reason can
	// stop being true the moment the zip or the config does
	if (!url || !pack.present) {
		probeCache.delete(key);

		return {
			checked: false,
			ok: false,
			url,
			problem: serve.builtIn
				? "the proxy serves packs on loopback (base-url: built-in) — clients off this machine cannot reach it"
				: !url
					? (serve.problem ?? "no pack URL to probe")
					: "the zip is missing, so there is nothing to serve",
		};
	}

	const cached = probeCache.get(key);
	const newFailure =
		failures.lastAt !== undefined && failures.lastAt > (cached?.seenFailureAt ?? 0);

	const trigger: PackReachability["trigger"] | undefined = retest
		? "manual"
		: !cached
			? "first"
			: cached.url !== url
				? "moved"
				: newFailure
					? "failure"
					: undefined;

	if (!trigger) {
		return { ...cached!.result, cached: true };
	}

	const result = { ...(await probePackUrl(url, pack.sizeBytes)), at: Date.now(), trigger };

	probeCache.set(key, { url, result, seenFailureAt: failures.lastAt });

	return result;
}
