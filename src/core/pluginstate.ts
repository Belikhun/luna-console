// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Plugin runtime state and log attribution.
 *
 * The only truth about whether a plugin actually *loaded* is the server log,
 * and Paper's log4j rolls latest.log at midnight as well as on restart; so
 * the current boot session is reconstructed by walking the rotated .gz files
 * backwards until the boot marker is found. Attribution matches a plugin's
 * *aliases* (plugin.yml `name`, velocity-plugin.json `name`/`id`), which are
 * extracted from the pooled jar once and cached on the lock entry.
 */

import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import type {
	AddonDir,
	ClusterConfig,
	InstanceConfig,
	PluginEntry,
	PluginFamily,
	PluginMeta,
	PluginsLock,
	Software,
} from "./types";
import { t } from "../shared/i18n";
import { unzipRead } from "./archive";
import { addonDirForFamily, instanceDir, managedInstances, poolDir } from "./config";
import {
	effectiveTargets,
	familyMatches,
	familyOf,
	instanceGroupNames,
	pluginNameOf,
	setPluginOverride,
} from "./families";
import { assignedVersion, instanceAddonDir, instanceAddonDirs } from "./plugins";
import { getStatus, type InstanceStatus } from "./instances";
import { ADDON_EXTENSIONS, traitsOf, type LogGrammar } from "./software";

/** Rotated files walked back at most, looking for the boot marker. */
const MAX_ROTATIONS = 6;

/** Decompressed session bytes read at most. */
const MAX_SESSION_BYTES = 8 * 1024 * 1024;

/**
 * The four phases an addon passes through, read from the server's own log.
 *
 * unknown; nothing in the session speaks about it: the instance is down, the
 *           boot lines rotated out of reach, or the addon is not there at all
 * loading; the server announced it was loading the addon, and has not finished
 *           starting up yet
 * errored; the log says loading or enabling it failed
 * running; the addon reported itself up, or the server finished starting with
 *           the addon loaded
 *
 * `running` has two routes on purpose. An addon that logs "started" (or
 * "đã khởi động") says so itself; most say nothing at all, and for those the
 * server's own "Done (Xs)!" is the proof that loading finished.
 *
 * `missing` is the one that used to be invisible. It means the log described
 * this addon's peers and never mentioned it: the jar is deployed, the server
 * enumerated what it loaded, and this was not in the list. That is a different
 * fact from `unknown` and a far more useful one; it is how a jar that is present
 * but silently never loaded stops looking exactly like a jar luna simply cannot
 * see. Only ever reported off a *complete* roster, so absence really is absence.
 *
 * `stopped` is the other half of that correction. A server that is not running
 * has nothing loaded, and saying so is knowledge, not ignorance - but every row
 * on a stopped instance used to report `unknown`, which reads as "luna cannot
 * tell" about the one case luna is certain of. The tell was a stopped instance
 * whose log ended in a clean, complete startup: the screen said the server had
 * finished starting and that the state of every addon in it was unknown.
 * `unknown` is now kept for the cases that really are unknowable - a log that
 * cannot be attributed to the process that is up, and a roster that rotated out
 * of reach.
 */
export type PluginRuntimeState =
	| "unknown"
	| "loading"
	| "errored"
	| "running"
	| "missing"
	| "stopped";

/**
 * Lifecycle state the report reasons from. Core can probe `running`, `stopped`,
 * `starting` and `unknown` itself; `stopping` and `restarting` are known only to
 * whoever asked for the transition, so they are passed in.
 */
export type ReportLifecycle = InstanceStatus["state"] | "stopping" | "restarting";

export interface BootSession {
	lines: string[];
	/** Whether the boot marker was found; without it absence proves nothing */
	complete: boolean;
	/** Software that wrote the log, which decides how a line is attributed */
	software: Software;
	/** Its MC version: forge's log grammar depends on the era, not just the id */
	mcVersion?: string;
	/** Whether the server announced it had finished starting up */
	startupComplete: boolean;
	/** When latest.log was last written (epoch ms), absent when there is no such file */
	writtenAt?: number;
}

/**
 * The line a server prints once startup is over. It is what promotes a quietly
 * loaded addon from `loading` to `running`: most addons never announce
 * themselves, so the server finishing is the only evidence that their loading
 * finished too.
 *
 * The wording is the software's own (`Done (12.345s)!` on everything with a
 * vanilla ancestry, `Started server; took 1351ms` on pumpkin), so it comes from
 * the traits table rather than being a constant here; a hardcoded vanilla
 * phrase leaves every pumpkin addon stuck on `loading` forever.
 */
function startupComplete(software: Software, mcVersion: string | undefined, lines: string[]): boolean {
	const marker = traitsOf(software, mcVersion).readyMarker;

	return lines.some((line) => marker.test(line));
}

/** One scalar value from a YAML-ish descriptor (top-level `key: value` line). */
function yamlValue(text: string, key: string): string | undefined {
	const match = text.match(new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, "m"));

	return match?.[1];
}

/** An author list from plugin.yml: `author: X`, `authors: [a, b]` or a dash list. */
function yamlAuthors(text: string): string[] {
	const inline = text.match(/^authors?:\s*\[(.*)\]\s*$/m);

	if (inline?.[1]) {
		return inline[1].split(",").map((entry) => entry.trim().replace(/^["']|["']$/g, ""));
	}

	const block = text.match(/^authors:\s*\r?\n((?:[ \t]*-[^\r\n]*\r?\n?)+)/m);

	if (block?.[1]) {
		return block[1]
			.split(/\r?\n/)
			.map((line) => line.replace(/^[ \t]*-\s*/, "").replace(/^["']|["']$/g, "").trim())
			.filter(Boolean);
	}

	const single = yamlValue(text, "author");

	return single ? [single] : [];
}

/** Descriptor of one jar plus the names it logs under. */
interface JarInfo {
	meta: PluginMeta;
	aliases: string[];
}

/**
 * Read what a jar says about itself: `plugin.yml` / `paper-plugin.yml` for
 * bukkit-side builds, `velocity-plugin.json` for the proxy side,
 * `neoforge.mods.toml` for neoforge mods and `fabric.mod.json` for fabric ones.
 * Later sources fill gaps rather than overwrite, so a universal jar keeps its
 * bukkit name but gains the velocity id.
 */
async function readJarInfo(path: string): Promise<JarInfo> {
	const meta: PluginMeta = {};
	const aliases: string[] = [];

	// Every descriptor below is a zip member, and a pumpkin component is a bare
	// WebAssembly file; probing one spawns unzip five times to learn nothing.
	if (!path.toLowerCase().endsWith(".jar")) {
		return { meta, aliases };
	}

	const claim = (name?: string): void => {
		if (name && !aliases.includes(name)) {
			aliases.push(name);
		}
	};

	for (const member of ["plugin.yml", "paper-plugin.yml"]) {
		const text = await unzipRead(path, member);

		if (!text) {
			continue;
		}

		const name = yamlValue(text, "name");

		claim(name);
		meta.name ??= name;
		meta.version ??= yamlValue(text, "version");
		meta.description ??= yamlValue(text, "description");
		meta.website ??= yamlValue(text, "website");
		meta.apiVersion ??= yamlValue(text, "api-version");

		if (!meta.authors?.length) {
			const authors = yamlAuthors(text);

			if (authors.length) {
				meta.authors = authors;
			}
		}
	}

	const velocity = await unzipRead(path, "velocity-plugin.json");

	if (velocity) {
		try {
			const json = JSON.parse(velocity) as {
				id?: string;
				name?: string;
				version?: string;
				description?: string;
				url?: string;
				authors?: string[];
			};

			claim(json.name);
			claim(json.id);
			meta.name ??= json.name;
			meta.id ??= json.id;
			meta.version ??= json.version;
			meta.description ??= json.description;
			meta.website ??= json.url;

			if (!meta.authors?.length && json.authors?.length) {
				meta.authors = json.authors;
			}
		} catch {
			// not valid JSON; some shaded jars carry junk under that path
		}
	}

	const fabric = await unzipRead(path, "fabric.mod.json");

	if (fabric) {
		try {
			const json = JSON.parse(fabric) as {
				id?: string;
				name?: string;
				version?: string;
				description?: string;
				contact?: { homepage?: string };
				authors?: (string | { name?: string })[];
			};

			claim(json.name);
			// the id is what the loader's mod roster prints, and it is regularly
			// not the display name ("LunaCore" ships as "lunacore"), so a build
			// whose pool name follows the display name is only recognisable in a
			// log through this
			claim(json.id);
			meta.name ??= json.name;
			meta.id ??= json.id;
			meta.version ??= json.version;
			meta.description ??= json.description;
			meta.website ??= json.contact?.homepage;

			if (!meta.authors?.length && json.authors?.length) {
				meta.authors = json.authors
					.map((author) => (typeof author === "string" ? author : author.name))
					.filter((author): author is string => Boolean(author));
			}
		} catch {
			// not valid JSON; some shaded jars carry junk under that path
		}
	}

	for (const member of ["META-INF/neoforge.mods.toml", "META-INF/mods.toml"]) {
		const text = await unzipRead(path, member);

		if (!text) {
			continue;
		}

		const toml = (key: string): string | undefined =>
			text.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1];

		const displayName = toml("displayName");
		const modId = toml("modId");

		claim(displayName);
		claim(modId);
		meta.name ??= displayName;
		meta.id ??= modId;
		meta.version ??= toml("version");
		meta.website ??= toml("displayURL");

		// description is usually a '''multi-line''' block; take its first line
		const description = text.match(/^\s*description\s*=\s*(?:'''|""")\s*\r?\n?([^\r\n']+)/m);

		meta.description ??= description?.[1]?.trim() ?? toml("description");

		const authors = toml("authors");

		if (!meta.authors?.length && authors) {
			meta.authors = authors.split(",").map((entry) => entry.trim()).filter(Boolean);
		}

		break;
	}

	// legacy FML (forge <= 1.12): a JSON array at the jar root, one object per
	// mod. Multi-mod jars front-load their main mod, so the first entry is the
	// one worth describing.
	const mcmod = await unzipRead(path, "mcmod.info");

	if (mcmod) {
		try {
			// some 1.12-era descriptors wrap the array in {"modList": [...]}
			const parsed = JSON.parse(mcmod) as
				| { modid?: string }[]
				| { modList?: { modid?: string }[] };

			const entry = (Array.isArray(parsed) ? parsed : parsed.modList)?.[0] as {
				modid?: string;
				name?: string;
				version?: string;
				description?: string;
				url?: string;
				authorList?: string[];
			} | undefined;

			if (entry) {
				claim(entry.name);
				claim(entry.modid);
				meta.name ??= entry.name;
				meta.id ??= entry.modid;
				meta.version ??= entry.version;
				meta.description ??= entry.description?.trim();
				meta.website ??= entry.url;

				if (!meta.authors?.length && entry.authorList?.length) {
					meta.authors = entry.authorList.filter(Boolean);
				}
			}
		} catch {
			// mcmod.info is hand-written JSON more often than not; a jar whose
			// descriptor does not parse still pools fine, just without metadata
		}
	}

	return { meta, aliases: [...new Set(aliases)] };
}

/** The names an entry goes by in logs, its cached aliases or the plugin name. */
export function aliasesOf(key: string, entry: PluginEntry): string[] {
	if (entry.aliases?.length) {
		return entry.aliases;
	}

	return [pluginNameOf(key, entry)];
}

/** The human-facing display name of an entry (first alias). */
export function displayNameOf(key: string, entry: PluginEntry): string {
	return aliasesOf(key, entry)[0]!;
}

/**
 * One addon's name reduced to the form two spellings of it can be compared in:
 * lowercased, with everything that is not a letter or a digit removed.
 *
 * `LuckPerms`, `luckperms`, `Luck-Perms` and `luck_perms` are one addon, and a
 * server that loads two of them loads it twice. Stripping the separators is what
 * lets a jar somebody named `luckperms-bukkit.jar` be recognised as the same
 * thing as the pooled `luckperms@paper`.
 */
function identityKey(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Every spelling that would identify this entry, as comparison keys. */
function entityKeys(values: Array<string | undefined>): Set<string> {
	const keys = new Set<string>();

	for (const value of values) {
		const key = value && identityKey(value);

		if (key) {
			keys.add(key);
		}
	}

	return keys;
}

/**
 * Fill `aliases` and `meta` for every lock entry that lacks them, reading the
 * pooled jars. Returns whether anything changed, so the caller knows to
 * persist. `scan` clears both when a jar's hash moves, so they self-refresh.
 */
export async function ensureAliases(lock: PluginsLock): Promise<boolean> {
	let changed = false;

	for (const [key, entry] of Object.entries(lock.plugins)) {
		if (entry.aliases !== undefined && entry.meta !== undefined) {
			continue;
		}

		const path = join(poolDir(), entry.file);

		if (!existsSync(path)) {
			continue;
		}

		const info = await readJarInfo(path);

		if (entry.aliases === undefined) {
			entry.aliases = info.aliases.length ? info.aliases : [pluginNameOf(key, entry)];
		}

		if (entry.meta === undefined) {
			entry.meta = info.meta;
		}

		changed = true;
	}

	return changed;
}

/** Rotated log files of an instance, oldest first (date, then rotation index). */
async function rotatedLogs(logsDir: string): Promise<string[]> {
	if (!existsSync(logsDir)) {
		return [];
	}

	const files = (await readdir(logsDir)).filter((file) =>
		/^\d{4}-\d{2}-\d{2}-\d+\.log\.gz$/.test(file),
	);

	return files.sort((a, b) => {
		const [dateA, indexA] = [a.slice(0, 10), Number(a.slice(11).split(".")[0])];
		const [dateB, indexB] = [b.slice(0, 10), Number(b.slice(11).split(".")[0])];

		return dateA === dateB ? indexA - indexB : dateA.localeCompare(dateB);
	});
}

/**
 * Reconstruct the current boot session of an instance: latest.log, extended
 * backwards through rotated files until the boot marker appears (log4j rolls
 * latest.log at midnight, so a long-running server's boot lines usually live
 * in a .gz). Bounded; a marker further back than the caps yields
 * `complete: false`.
 */
export async function readBootSession(cfg: ClusterConfig, instance: string): Promise<BootSession> {
	const inst = managedInstances(cfg)[instance];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name: instance }));
	}

	const logsDir = join(instanceDir(inst), "logs");
	const marker = traitsOf(inst.software, inst.mcVersion).bootMarker;

	let text = "";
	let writtenAt: number | undefined;
	const latest = join(logsDir, "latest.log");

	if (existsSync(latest)) {
		text = await Bun.file(latest).text();
		writtenAt = (await stat(latest)).mtimeMs;
	}

	const rotations = await rotatedLogs(logsDir);
	let walked = 0;

	while (!marker.test(text) && rotations.length && walked < MAX_ROTATIONS) {
		const file = rotations.pop()!;

		walked += 1;

		try {
			const compressed = await Bun.file(join(logsDir, file)).bytes();
			const chunk = new TextDecoder().decode(Bun.gunzipSync(compressed));

			text = chunk + text;
		} catch {
			// a truncated archive must not take the whole report down
			break;
		}

		if (text.length > MAX_SESSION_BYTES) {
			break;
		}
	}

	const lines = text.split(/\r?\n/);

	// the LAST marker starts the current session; older sessions may sit above it
	let start = -1;

	for (let index = lines.length - 1; index >= 0; index -= 1) {
		if (marker.test(lines[index]!)) {
			start = index;

			break;
		}
	}

	if (start === -1) {
		return {
			lines,
			complete: false,
			software: inst.software,
			...(inst.mcVersion ? { mcVersion: inst.mcVersion } : {}),
			startupComplete: startupComplete(inst.software, inst.mcVersion, lines),
			...(writtenAt !== undefined ? { writtenAt } : {}),
		};
	}

	const session = lines.slice(start);

	return {
		lines: session,
		complete: true,
		software: inst.software,
		...(inst.mcVersion ? { mcVersion: inst.mcVersion } : {}),
		startupComplete: startupComplete(inst.software, inst.mcVersion, session),
		...(writtenAt !== undefined ? { writtenAt } : {}),
	};
}

/**
 * The level in a log line, across the layouts luna reads. Log4j puts it behind
 * the thread (`[main/WARN]`), some layouts bracket it alone and follow it with a
 * colon (`[WARN]: `), and pumpkin's own logger brackets it alone with nothing
 * after it (`[WARN] `). The last of those is anchored to the start of the line
 * on purpose: with neither a thread nor a colon there is nothing left to tell it
 * apart from a message quoting a bracketed level, and the line opening with it
 * is what does.
 */
const SEVERITY = /\[[^\]]*\/(WARN|ERROR)\]|\[(WARN|ERROR)\]:|^\[(WARN|ERROR)\]/;

/** Severity of one log line, when it carries one. */
function severityOf(line: string): "warn" | "error" | undefined {
	const match = line.match(SEVERITY);

	if (!match) {
		return undefined;
	}

	return (match[1] ?? match[2] ?? match[3])!.toLowerCase() as "warn" | "error";
}

/**
 * Logger name of a log4j line, for the layouts that carry one: neoforge writes
 * `[time] [thread/LEVEL] [Logger/MARKER]: message` and velocity the same thing
 * without the marker, so the logger is the third bracket, up to whichever of
 * the slash or the closing bracket comes first.
 */
const LOG4J_LOGGER = /^\[[^\]]*\]\s*\[[^\]]*\]\s*\[([^\]/]*)[/\]]/;

/**
 * The platform suffix a multi-platform addon appends to its logger name, per
 * grammar: `LunaCoreVelocity` and `LunaCoreNeoForge` are both `luna-core`.
 *
 * A grammar listed here names its addon in the logger *field*; one that is
 * absent names it in the message body instead, and is matched as a substring.
 * That is the whole difference between the two rules, so membership of this map
 * is what selects them.
 */
/**
 * Nothing to strip. Legacy FML gives a mod's logger the mod id verbatim
 * (`[lunacore]`), because on that line a mod *is* its id - there is no
 * `LunaCoreForge` platform class naming the logger, since there is only one
 * platform. `replace(/$/, "")` leaves the name alone, which is the honest way to say
 * "this grammar uses the logger field, and the field needs no cleaning".
 */
const NO_SUFFIX = /$/;

const LOGGER_SUFFIX: Partial<Record<LogGrammar, RegExp>> = {
	modlauncher: /(neo)?forge$/,
	velocity: /velocity$/,
	fml: NO_SUFFIX,
};

/**
 * The one line a healthy 1.12.2 boot names every loaded mod on:
 * `Attempting connection with missing mods [minecraft, mcp, FML, forge, lunacore] at SERVER`.
 *
 * "missing" is about the *client* not having them, not about them failing to load -
 * it is the server listing what a joining client would need. That makes it the only
 * per-mod evidence in latest.log, because the `UCHIJAAAA` state table everyone
 * associates with FML is written into crash reports and never into the log.
 */
const FML_MOD_LIST = /attempting connection with missing mods \[([^\]]*)\]/;

/** FML's mod count, which is what proves the roster was reached at all. */
const FML_ROSTER_HEADER = /forge mod loader has (identified|successfully loaded) \d+ mods/;

/**
 * Characters that continue a plugin name, for pumpkin's whole-token test. A dot
 * is deliberately *not* one: the name is followed by its file extension in the
 * paths pumpkin prints (`./plugins/luna-core.wasm`), and a name has to match
 * there too.
 */
const NAME_CHAR = /[a-z0-9_-]/;

/**
 * Whether a pumpkin line names one of the aliases, as a whole token.
 *
 * Pumpkin names a plugin in prose rather than in a layout field; quoted
 * (`Permission denied for plugin "luna-core"`), bare before its version
 * (`Loaded luna-core (0.1.0)`), or inside the component's path. So the test is
 * a substring one, bounded at both ends, and the boundary is what earns its
 * keep: an unbounded `includes` would credit every `luna-core-messaging` line
 * to `luna-core`.
 */
function namesAlias(lowerLine: string, alias: string): boolean {
	let at = lowerLine.indexOf(alias);

	while (at !== -1) {
		const before = lowerLine[at - 1];
		const after = lowerLine[at + alias.length];

		if (!(before && NAME_CHAR.test(before)) && !(after && NAME_CHAR.test(after))) {
			return true;
		}

		at = lowerLine.indexOf(alias, at + 1);
	}

	return false;
}

/**
 * Whether a line is attributed to one of the aliases.
 *
 * Bukkit and fabric prefix the message itself with `[Name]`, so a substring
 * test is the whole rule there. ModLauncher and velocity do not: the addon is
 * named in the layout's logger field (`[LunaCore/]`, `[LunaCoreVelocity]`), and
 * the message body regularly mentions *other* addons ("Registering events for
 * 'lunacore'"), which a substring test would happily credit to the wrong one.
 * Velocity is the worse of the two, because it also names each plugin's
 * scheduler threads after that plugin, and most of a boot runs on whichever
 * plugin's pool got there first - matching anywhere in the line would file the
 * entire startup under LuckPerms. So both are matched on the logger alone, and
 * matched whole; a prefix test would file every `LunaCoreMessaging` line under
 * `LunaCore`. A multi-platform addon commonly names its logger after the
 * platform class, so a trailing suffix is stripped before comparing.
 *
 * Pumpkin has neither: its logging interface takes a message and nothing else,
 * so a *plugin's own* lines are indistinguishable from the server's and can
 * never be attributed. What is attributable is the set the server writes *about*
 * a plugin, which is the set the warning and error tallies are made of anyway.
 */
function attributed(lowerLine: string, lowerAliases: string[], session: BootSession): boolean {
	const grammar = traitsOf(session.software, session.mcVersion).logGrammar;

	if (grammar === "pumpkin") {
		return lowerAliases.some((alias) => namesAlias(lowerLine, alias));
	}

	const suffix = LOGGER_SUFFIX[grammar];

	if (!suffix) {
		return lowerAliases.some((alias) => lowerLine.includes(`[${alias}]`));
	}

	const logger = lowerLine.match(LOG4J_LOGGER)?.[1];

	if (!logger) {
		return false;
	}

	const bare = logger.replace(suffix, "");

	return lowerAliases.some((alias) => logger === alias || bare === alias);
}

export interface PluginLogReport {
	lines: string[];
	warnings: number;
	errors: number;
}

/** Every session line attributed to the plugin, with warn/error tallies. */
export function pluginLogReport(session: BootSession, aliases: string[]): PluginLogReport {
	const lowerAliases = aliases.map((alias) => alias.toLowerCase());
	const lines: string[] = [];
	let warnings = 0;
	let errors = 0;

	for (const line of session.lines) {
		const lower = line.toLowerCase();

		if (!attributed(lower, lowerAliases, session)) {
			continue;
		}

		lines.push(line);

		const severity = severityOf(line);

		if (severity === "warn") {
			warnings += 1;
		} else if (severity === "error") {
			errors += 1;
		}
	}

	return { lines, warnings, errors };
}

/**
 * Phrases an addon uses to announce that it has finished coming up, in its own
 * log lines. Only a handful of addons say anything at all, which is why this
 * list does not need to be exhaustive; "Done (Xs)!" catches the silent
 * majority. It is matched against lines already attributed to the addon, so a
 * word as common as "running" cannot be picked up from someone else's line.
 */
const READY_HINTS = [
	"started",
	"running",
	"is ready",
	"enabled successfully",
	// LunaCore and friends log in Vietnamese. "đã sẵn sàng" is the phrase every
	// luna module except the core itself announces with, so leaving it out reported
	// a whole modded backend as unknown while the core alone read as running.
	"đã khởi động",
	"khởi động thành công",
	"đã sẵn sàng",
];

/**
 * What a session says about one addon, before the server's own progress is
 * folded in.
 *
 * errored; a load or enable failure names it
 * ready  ; it announced itself up
 * loading; the server announced it was loading it, and it has said no more
 * none   ; the session never mentions it, though it did describe its peers
 * unknown; the session cannot answer (the part that would have is missing)
 */
type AddonEvidence = "errored" | "ready" | "loading" | "none" | "unknown";

/** Whether an addon's own line claims it is up. */
function claimsReady(lowerLine: string): boolean {
	return READY_HINTS.some((hint) => lowerLine.includes(hint));
}

/**
 * Fabric loader's roster header, and one of its entries.
 *
 * The loader prints "Loading 47 mods:" and then one line per mod, indented and
 * drawn as a tree - "\t- lunacore 0.1.0-SNAPSHOT", nested dependencies under
 * "\t   |-- fabric-api-base 0.4.42". The id comes first there, where every other
 * loader puts it last, which is the whole reason this grammar exists: matched
 * against the modlauncher rule, a fabric roster says nothing about any mod and
 * every one of them reports as unknown.
 */
const FABRIC_ROSTER_HEADER = /loading \d+ mods?:/;
const FABRIC_ROSTER_ENTRY = /^\s*(?:[|\\]--|-)\s*([a-z0-9_.-]+)(?:\s+\S+)?$/;

/** Load, ready and failure evidence for one addon in a session. */
function loadEvidence(session: BootSession, aliases: string[]): AddonEvidence {
	const lowerAliases = aliases.map((alias) => alias.toLowerCase());
	const grammar = traitsOf(session.software, session.mcVersion).logGrammar;

	let loading = false;
	let ready = false;

	// A mod loader has no per-mod "enabling" line. What modlauncher does print is
	// a roster of everything it constructed, one line per mod ending in the mod id
	//; "\t\tLunaCore 0.1.0-SNAPSHOT (lunacore)". Absence only means "not there"
	// when the roster was captured at all, so its two guaranteed members double
	// as the marker that it is in the session.
	// Absence only means "not there" when the roster was captured at all, so each
	// loader that prints one carries its own marker for having reached it.
	let roster = grammar !== "modlauncher" && grammar !== "fabric" && grammar !== "fml";

	for (const rawLine of session.lines) {
		const lower = rawLine.trimEnd().toLowerCase();
		const mine = attributed(lower, lowerAliases, session);

		if (grammar === "modlauncher" && (lower.endsWith("(minecraft)") || lower.endsWith("(neoforge)"))) {
			roster = true;
		}

		if (grammar === "fabric" && FABRIC_ROSTER_HEADER.test(lower)) {
			roster = true;
		}

		if (grammar === "fml" && FML_ROSTER_HEADER.test(lower)) {
			roster = true;
		}

		for (const alias of lowerAliases) {
			if (grammar === "bukkit") {
				// bukkit prints "[Name] Loading server plugin Name vX", then
				// "[Name] Enabling Name vX"; failures follow as
				// "Error occurred while enabling Name vX"
				if (lower.includes(`error occurred while enabling ${alias} `)) {
					return "errored";
				}

				if (lower.includes("could not load plugin") && lower.includes(alias)) {
					return "errored";
				}

				if (
					lower.includes(`loading server plugin ${alias} v`) ||
					lower.includes(`enabling ${alias} v`) ||
					lower.includes(`disabling ${alias} v`)
				) {
					loading = true;
				}
			} else if (grammar === "velocity") {
				if (lower.includes(`can't create plugin ${alias}`)) {
					return "errored";
				}

				if (lower.includes(`loaded plugin ${alias} `)) {
					loading = true;
				}
			} else if (grammar === "fabric") {
				if (FABRIC_ROSTER_ENTRY.exec(lower)?.[1] === alias) {
					loading = true;
				}
			} else if (grammar === "fml") {
				// legacy FML names the mod it could not construct, and the phase it
				// died in, on one line: "caught exception from lunacore"
				if (lower.includes(`caught exception from ${alias}`)) {
					return "errored";
				}

				const listed = FML_MOD_LIST.exec(lower)?.[1];

				if (listed && listed.split(",").some((id) => id.trim() === alias)) {
					loading = true;
				}
			} else if (grammar === "pumpkin") {
				// the consent prompt is answered before anything is initialised, so
				// a refused component never reaches the loader at all; that refusal
				// is the failure an operator most needs to see named
				if (lower.includes(`permission denied for plugin "${alias}"`)) {
					return "errored";
				}

				if (
					lower.includes(`failed to initialize plugin ${alias}`) ||
					(lower.includes("failed to load plugin from") && mine)
				) {
					return "errored";
				}

				// "Loaded luna-core (0.1.0)": pumpkin prints it once on_load returns
				if (lower.includes(`loaded ${alias} (`)) {
					loading = true;
				}
			} else if (lower.endsWith(`(${alias})`)) {
				loading = true;
			}
		}

		if (mine && claimsReady(lower)) {
			ready = true;
		}
	}

	if (ready) {
		return "ready";
	}

	if (loading) {
		return "loading";
	}

	return roster ? "none" : "unknown";
}

export interface InstancePluginRow {
	key: string;
	plugin: string;
	displayName: string;
	family: PluginFamily;
	source: string;
	file: string;
	autoUpdate: boolean;
	version: string | null;
	pinned: boolean;
	variant: boolean;
	/** How the plugin got here: group membership, a force-add override, or explicit targets */
	origin: "group" | "manual" | "explicit";
	/** The instance's groups that name this plugin */
	groups: string[];
	disabled: boolean;
	state: PluginRuntimeState;
	warnings: number;
	errors: number;
}

/**
 * One addon jar in an instance's directory that no lock entry claims.
 *
 * Reported as a row rather than a bare file name because an unmanaged addon is
 * still an addon: it loads, it can fail to load, and it is usually the thing
 * that broke a modpack. The console counted these and showed none of them, which
 * meant the jars luna knows least about were also the ones it said least about.
 */
export interface UnmanagedAddonRow {
	file: string;
	/** Which directory it sits in, so a hybrid's two are told apart */
	dir: AddonDir;
	sizeBytes: number;
	modifiedAt: number;
	/** Its own descriptor, when it carries one luna can read */
	meta?: PluginMeta;
	/** The descriptor's name, else the file name with its extension trimmed */
	displayName: string;
	/** Runtime state from the log, judged by the same evidence a managed row uses */
	state: PluginRuntimeState;
	warnings: number;
	errors: number;
}

export interface InstancePluginReport {
	rows: InstancePluginRow[];
	session: BootSession;
	/** Addon jars in the instance's own directory that no lock entry claims */
	unmanaged: UnmanagedAddonRow[];
}

/**
 * Descriptors already read, keyed by path and by the two stat fields that change
 * when a jar is replaced.
 *
 * Reading one means spawning `unzip` per member per jar, and a modpack's mods
 * directory holds hundreds. The report behind the console's addon tab redraws
 * every few seconds, so without this the tab would fork thousands of processes a
 * minute to re-read files that had not changed.
 */
const descriptors = new Map<string, JarInfo>();

/** Descriptor for one jar, read once per version of the file. */
async function cachedJarInfo(path: string, size: number, mtimeMs: number): Promise<JarInfo> {
	const key = `${path}:${size}:${Math.round(mtimeMs)}`;
	const hit = descriptors.get(key);

	if (hit) {
		return hit;
	}

	const info = await readJarInfo(path);

	// a jar that has been replaced leaves its old key behind; drop the whole map
	// rather than track eviction, since it is only ever a few hundred entries and
	// re-reading is what it already does on a change
	if (descriptors.size > DESCRIPTOR_CACHE_MAX) {
		descriptors.clear();
	}

	descriptors.set(key, info);

	return info;
}

/** Enough for every jar of a large modpack across a few instances. */
const DESCRIPTOR_CACHE_MAX = 2000;

/**
 * Addon jars sitting in an instance's directory that luna does not manage -
 * the modpack's own mods, or plugins an operator dropped in by hand.
 *
 * Identity is the file name against the lockfile's, which is the same test
 * `deploy` writes by and costs one directory listing. Deliberately *not* a hash
 * comparison: that is `scan`'s job, and it walks the whole cluster hashing every
 * jar; far too much for something a summary redraws every few seconds.
 *
 * The descriptor read is what lets one of these be *named*, which is what makes
 * its log lines findable: a file called `spark-bukkit.jar` announces itself as
 * "spark", and nothing matches the two up without opening the jar.
 */
async function unmanagedAddons(
	inst: InstanceConfig,
	lock: PluginsLock,
	/** the boot session to read state from; omitted when only the files are wanted */
	session?: BootSession,
	/**
	 * What to report when there is no attributable session. A managed row reaches
	 * the same fork through `down`/`stale`, and the two must answer alike or one
	 * table on the screen calls a stopped server's addons `stopped` while the
	 * table under it calls them `unknown`.
	 */
	unattributed: PluginRuntimeState = "unknown",
): Promise<UnmanagedAddonRow[]> {
	const managed = new Set(
		Object.values(lock.plugins).map((entry) => entry.file.toLowerCase()),
	);

	const rows: UnmanagedAddonRow[] = [];

	// a hybrid keeps two directories, and an unmanaged jar in either is still one
	for (const { dir, path } of instanceAddonDirs(inst)) {
		if (!existsSync(path)) {
			continue;
		}

		for (const file of await readdir(path)) {
			const lower = file.toLowerCase();

			// a pumpkin component is a .wasm, so the extension is the family's
			if (!ADDON_EXTENSIONS.some((ext) => lower.endsWith(ext)) || managed.has(lower)) {
				continue;
			}

			const full = join(path, file);
			let size = 0;
			let modifiedAt = 0;

			try {
				const info = await stat(full);

				size = info.size;
				modifiedAt = info.mtimeMs;
			} catch {
				// vanished between the listing and the stat; a deploy mid-report
				continue;
			}

			const jar = await cachedJarInfo(full, size, modifiedAt);
			const aliases = jar.aliases.length ? jar.aliases : [file.replace(/\.[^.]+$/, "")];
			const log = session ? pluginLogReport(session, aliases) : EMPTY_LOG;

			rows.push({
				file,
				dir,
				sizeBytes: size,
				modifiedAt,
				...(Object.keys(jar.meta).length ? { meta: jar.meta } : {}),
				displayName: aliases[0]!,
				state: session ? unmanagedState(session, aliases) : unattributed,
				warnings: log.warnings,
				errors: log.errors,
			});
		}
	}

	return rows.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

const EMPTY_LOG: PluginLogReport = { lines: [], warnings: 0, errors: 0 };

/**
 * Runtime state of an unmanaged addon.
 *
 * The same evidence a managed row uses, minus the deploy-state reasoning it has
 * no equivalent of: nothing targets an unmanaged jar, so there is no "disabled"
 * and no assigned version, only what the log says about it.
 */
function unmanagedState(session: BootSession, aliases: string[]): PluginRuntimeState {
	const evidence = loadEvidence(session, aliases);

	switch (evidence) {
		case "errored":
			return "errored";

		case "ready":
			return "running";

		case "loading":
			return session.startupComplete ? "running" : "loading";

		case "none":
			return session.complete ? "missing" : "unknown";

		default:
			return "unknown";
	}
}

/**
 * Full plugin report for one instance: every entry that deploys there plus the
 * ones its overrides disabled, each with its runtime state and the warn/error
 * counts attributed to it in the current boot session, alongside the jars in its
 * directory that luna does not manage at all.
 *
 * `opts.state` is the instance's lifecycle as the caller knows it; pass the
 * console's transient state so a restart is reported as a restart. Without it
 * the instance is probed, which cannot see a stop that was only just asked for.
 */
export async function instancePluginReport(
	cfg: ClusterConfig,
	lock: PluginsLock,
	instance: string,
	opts: { state?: ReportLifecycle } = {},
): Promise<InstancePluginReport> {
	const inst = managedInstances(cfg)[instance];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name: instance }));
	}

	const status = await getStatus(cfg, instance);
	const lifecycle = opts.state ?? status.state;

	// Whether a process is up is most of the question, and the probe answers it:
	// nothing is loaded on a server that is not running, and an unreachable owner
	// cannot be spoken for either way.
	const down = lifecycle === "stopped" || lifecycle === "unknown";

	const session = await readBootSession(cfg, instance);

	// The rest of the question is whether the log belongs to the process that is
	// up *now*. It does not, for the first stretch of a boot: the JVM starts,
	// but log4j only rolls latest.log once it initialises, so until then the file
	// still holds the run that just ended; and reading it would report a server
	// that is barely alive as fully up, which is the stale "running" this whole
	// report exists to avoid.
	//
	// A log untouched since the process began cannot describe it. That is a fact
	// about two clocks on the same machine, not a guess about the log's contents:
	// a session that merely *looks* finished is indistinguishable mid-restart
	// from the new run having genuinely finished.
	const startedAt = status.uptimeMs !== undefined ? Date.now() - status.uptimeMs : undefined;

	const stale =
		startedAt !== undefined && session.writtenAt !== undefined && session.writtenAt < startedAt;

	const rows: InstancePluginRow[] = [];

	for (const [key, entry] of Object.entries(lock.plugins)) {
		const plugin = pluginNameOf(key, entry);
		const family = familyOf(entry);
		const disabled = inst.pluginOverrides?.[plugin] === false;
		const targeted = effectiveTargets(cfg, lock, key).includes(instance);

		// disabled rows stay visible (family permitting) so they can be re-enabled
		if (!targeted && !(disabled && familyMatches(family, inst.software))) {
			continue;
		}

		const aliases = aliasesOf(key, entry);
		const groups = instanceGroupNames(inst).filter((group) =>
			lock.groups?.[group]?.plugins.includes(plugin),
		);

		const origin: InstancePluginRow["origin"] =
			inst.pluginOverrides?.[plugin] === true
				? "manual"
				: groups.length
					? "group"
					: "explicit";

		const log = pluginLogReport(session, aliases);

		let state: PluginRuntimeState;

		if (disabled) {
			// the override, not a phase: the row carries `disabled` and both the
			// table and the CLI show that in place of a state
			state = "unknown";
		} else if (down) {
			// nothing is loaded on a server that is not running, and that is a fact
			// rather than an absence of one
			state = "stopped";
		} else if (stale) {
			state = "unknown";
		} else {
			const evidence = loadEvidence(session, aliases);

			if (evidence === "errored") {
				state = "errored";
			} else if (evidence === "ready") {
				state = "running";
			} else if (evidence === "loading") {
				// a quiet addon is only proven up by the server finishing startup
				state = session.startupComplete ? "running" : "loading";
			} else if (evidence === "none" && session.complete) {
				// the roster named this addon's peers and not it. Gated on a complete
				// session: without the boot marker the log may simply start after the
				// roster was printed, and absence would then prove nothing.
				state = "missing";
			} else {
				state = "unknown";
			}
		}

		const version = assignedVersion(entry, instance);

		rows.push({
			key,
			plugin,
			displayName: displayNameOf(key, entry),
			family,
			source: entry.source,
			file: entry.file,
			autoUpdate: entry.autoUpdate,
			version: version ?? null,
			pinned: entry.pins?.[instance] !== undefined,
			variant: version !== undefined && version !== entry.installed?.versionNumber,
			origin,
			groups,
			disabled,
			state,
			warnings: log.warnings,
			errors: log.errors,
		});
	}

	return {
		rows: rows.sort((a, b) => a.plugin.localeCompare(b.plugin)),
		session,
		// an unmanaged jar's state is read off the same session, so it is only
		// attributable under the same conditions a managed row's is, and it reports
		// the same thing when it is not
		unmanaged: await unmanagedAddons(
			inst,
			lock,
			down || stale ? undefined : session,
			down ? "stopped" : "unknown",
		),
	};
}

/** One addon already on an instance that a new upload would duplicate. */
export interface CollidingAddon {
	/** Lock entry key, absent for a jar nothing manages */
	key?: string;
	/** The file as it sits in the instance's directory */
	file: string;
	dir: AddonDir;
	displayName: string;
	version: string | null;
}

/**
 * What putting an addon called `plugin` on `instance` would run into.
 *
 * Three different answers, kept apart because they need different handling:
 * `overwrites` is the same pool key, so the upload replaces it whether anybody
 * asks or not; `managed` and `unmanaged` are the *same addon under another name*,
 * which is the case that silently ends up loading twice.
 */
export interface AddonCollisionReport {
	/** Pool entry this would overwrite outright; the key is identical */
	overwrites?: { key: string; version: string | null };
	/** Managed entries on this instance that are the same addon under another key */
	managed: CollidingAddon[];
	/** Jars in this instance's own directory that are the same addon */
	unmanaged: CollidingAddon[];
}

/**
 * Look for addons already on an instance that a new one would duplicate.
 *
 * Asked *before* an upload, so the operator sees "pluginbox already has
 * LuckPerms 5.5.71 as luckperms@paper" while there is still a decision to make.
 * Comparison is by identity key over every spelling luna knows: an entry's
 * plugin name and its descriptor aliases, and for an unmanaged jar the name its
 * own descriptor gives (which is why the descriptors are parsed at all).
 *
 * Reads only; nothing here changes anything.
 */
export async function addonCollisions(
	cfg: ClusterConfig,
	lock: PluginsLock,
	instance: string,
	opts: { plugin: string; family: PluginFamily },
): Promise<AddonCollisionReport> {
	const inst = managedInstances(cfg)[instance];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name: instance }));
	}

	const wanted = identityKey(opts.plugin);
	const key = `${opts.plugin.trim().toLowerCase()}@${opts.family}`;
	const report: AddonCollisionReport = { managed: [], unmanaged: [] };

	if (!wanted) {
		return report;
	}

	const existing = lock.plugins[key];

	if (existing) {
		report.overwrites = { key, version: assignedVersion(existing, instance) ?? null };
	}

	for (const [entryKey, entry] of Object.entries(lock.plugins)) {
		// the same key is an overwrite, reported above; a different *family* of the
		// same addon is a legitimate sibling (paper and velocity builds coexist)
		if (entryKey === key || familyOf(entry) !== opts.family) {
			continue;
		}

		if (!effectiveTargets(cfg, lock, entryKey).includes(instance)) {
			continue;
		}

		const keys = entityKeys([pluginNameOf(entryKey, entry), ...aliasesOf(entryKey, entry)]);

		if (keys.has(wanted)) {
			report.managed.push({
				key: entryKey,
				file: entry.file,
				dir: addonDirForFamily(familyOf(entry)),
				displayName: displayNameOf(entryKey, entry),
				version: assignedVersion(entry, instance) ?? null,
			});
		}
	}

	// the boot session is irrelevant here, so the scan runs unattributed: this is
	// about what is on disk, not about what loaded
	const loose = await unmanagedAddons(inst, lock);

	for (const row of loose) {
		const keys = entityKeys([
			row.displayName,
			row.meta?.name,
			row.meta?.id,
			row.file.replace(/\.[^.]+$/, ""),
		]);

		if (keys.has(wanted)) {
			report.unmanaged.push({
				file: row.file,
				dir: row.dir,
				displayName: row.displayName,
				version: row.meta?.version ?? null,
			});
		}
	}

	return report;
}

/**
 * Take superseded copies of an addon off one instance.
 *
 * The other half of the collision report: having been told that this instance
 * already carries the same addon under another name, this is what acts on it. A
 * managed duplicate is disabled here (its override goes to `false`, so a group
 * cannot put it back) and its jar removed; an unmanaged one is just a file, and
 * the file is deleted.
 *
 * Deliberately narrow, because it deletes: a name must be a bare file name with
 * an addon extension, sitting in one of *this instance's* own addon directories.
 * Nothing else in the RPC surface can remove an arbitrary instance file, and this
 * is not the place to open that door.
 *
 * Mutates cfg and lock (caller saves).
 */
export async function supersedeAddons(
	cfg: ClusterConfig,
	lock: PluginsLock,
	instance: string,
	opts: { plugins?: string[]; files?: string[] },
): Promise<{ removed: string[] }> {
	const inst = managedInstances(cfg)[instance];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name: instance }));
	}

	const removed: string[] = [];

	for (const plugin of opts.plugins ?? []) {
		setPluginOverride(cfg, lock, instance, plugin, false);
		removed.push(...(await removeInstanceJars(cfg, lock, instance, plugin)));
	}

	for (const file of opts.files ?? []) {
		// a path, a traversal or a non-addon is refused rather than resolved: the
		// caller passes what the collision report handed it and nothing else
		if (file !== basename(file) || !ADDON_EXTENSIONS.some((ext) => file.toLowerCase().endsWith(ext))) {
			throw new Error(t("core.plugins.notAnAddonFile", { file }));
		}

		for (const { path } of instanceAddonDirs(inst)) {
			const full = join(path, file);

			if (existsSync(full)) {
				await rm(full);
				removed.push(file);
			}
		}
	}

	return { removed };
}

export interface PluginUsageRow {
	instance: string;
	software: Software;
	mcVersion?: string;
	/** Lockfile key of the build the instance gets */
	entry: string;
	family: PluginFamily;
	version: string | null;
	pinned: boolean;
	variant: boolean;
	origin: "group" | "manual" | "explicit";
	groups: string[];
	disabled: boolean;
}

/**
 * Where a plugin (by name) lands across the cluster: one row per instance that
 * deploys a build of it; or disabled it. The build listed is the one the
 * family match picks for that instance's software.
 */
export function pluginUsageReport(
	cfg: ClusterConfig,
	lock: PluginsLock,
	plugin: string,
): PluginUsageRow[] {
	const rows: PluginUsageRow[] = [];

	const keys = Object.entries(lock.plugins)
		.filter(([key, entry]) => pluginNameOf(key, entry) === plugin)
		.map(([key]) => key);

	for (const [name, inst] of Object.entries(managedInstances(cfg))) {
		// exact family beats universal, mirroring validateGroups
		const matching = keys
			.filter((key) => familyMatches(familyOf(lock.plugins[key]!), inst.software))
			.sort((a, b) => {
				const exactA = familyOf(lock.plugins[a]!) === inst.software ? 0 : 1;
				const exactB = familyOf(lock.plugins[b]!) === inst.software ? 0 : 1;

				return exactA - exactB;
			});

		const disabled = inst.pluginOverrides?.[plugin] === false;
		const targeted = matching.find((key) =>
			effectiveTargets(cfg, lock, key).includes(name),
		);

		if (!targeted && !disabled) {
			continue;
		}

		const key = targeted ?? matching[0];

		if (!key) {
			continue;
		}

		const entry = lock.plugins[key]!;
		const groups = instanceGroupNames(inst).filter((group) =>
			lock.groups?.[group]?.plugins.includes(plugin),
		);

		const version = assignedVersion(entry, name);

		rows.push({
			instance: name,
			software: inst.software,
			...(inst.mcVersion ? { mcVersion: inst.mcVersion } : {}),
			entry: key,
			family: familyOf(entry),
			version: version ?? null,
			pinned: entry.pins?.[name] !== undefined,
			variant: version !== undefined && version !== entry.installed?.versionNumber,
			origin:
				inst.pluginOverrides?.[plugin] === true
					? "manual"
					: groups.length
						? "group"
						: "explicit",
			groups,
			disabled,
		});
	}

	return rows.sort((a, b) => a.instance.localeCompare(b.instance));
}

/**
 * Remove a plugin's deployed jars from one instance without touching the
 * lockfile; the disable path: the override already keeps deploy from
 * re-copying, this clears what is on disk. Returns the files removed.
 */
export async function removeInstanceJars(
	cfg: ClusterConfig,
	lock: PluginsLock,
	instance: string,
	plugin: string,
): Promise<string[]> {
	const inst = managedInstances(cfg)[instance];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name: instance }));
	}

	const removed: string[] = [];

	for (const [key, entry] of Object.entries(lock.plugins)) {
		if (pluginNameOf(key, entry) !== plugin) {
			continue;
		}

		const path = join(instanceAddonDir(inst, familyOf(entry)), entry.file);

		if (existsSync(path)) {
			await rm(path);
			removed.push(entry.file);

			delete entry.assign?.[instance];
			delete entry.pins?.[instance];
		}
	}

	return removed;
}
