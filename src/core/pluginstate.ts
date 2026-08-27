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
import { nestedJarNames, unzipRead } from "./archive";
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
	/**
	 * Addon files the loader reported discovering, each mapped to the ids it
	 * carried, for the software whose roster is in a log of its own
	 * (`SoftwareTraits.addonRoster`). Empty for everything else, and for a roster
	 * that could not be read.
	 *
	 * A plain record rather than a Map because the session crosses the daemon RPC
	 * boundary as JSON.
	 *
	 * Optional, like the two fields below, because it does: a follower running an
	 * older build answers this op without them, and the report has to keep working
	 * against one rather than throwing halfway through a mixed-build rollout.
	 */
	discovered?: Record<string, string[]>;
	/** Whether that roster was read at all, which is what makes absence meaningful */
	discoveredComplete?: boolean;
	/**
	 * Addon ids and names the loader itself declared broken, lowercased.
	 *
	 * Parsed once per session rather than per addon, because the evidence is a
	 * multi-line block (modlauncher's `LoadingFailedException` encloses one line
	 * per offending mod) and re-parsing it for each of a modpack's several
	 * hundred rows would walk the same block hundreds of times.
	 */
	failed?: string[];
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
	/**
	 * Base names of the jars packaged inside it, when it is a jar-in-jar
	 * container. These are the names a mod loader's roster prints, because it
	 * extracts and loads the payload rather than the container.
	 */
	nested: string[];
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
		return { meta, aliases, nested: [] };
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

	return { meta, aliases: [...new Set(aliases)], nested: await nestedJarNames(path) };
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
 * Rosters already parsed, keyed by path and the session-identifying first line.
 *
 * A debug log grows for the whole run, so its size and mtime change between two
 * console polls seconds apart while the roster near its top does not; keying on
 * either would miss the cache every time and re-read megabytes.
 */
const rosters = new Map<string, { discovered: Record<string, string[]>; complete: boolean }>();

/** Bytes read to identify the session, which is all the first line takes. */
const ROSTER_KEY_BYTES = 4096;

/** A handful of instances, each with one roster; nothing like the jar cache. */
const ROSTER_CACHE_MAX = 64;

/**
 * The addon files a loader reported discovering, from the log it writes them to.
 *
 * This exists because the modlauncher line prints no roster into `latest.log`:
 * a forge mod that neither announces itself nor fails leaves nothing in the
 * session at all, and every such mod reported as `unknown` (measured on a
 * 240-mod pack: 232 of 233 unmanaged rows). Forge and NeoForge both write the
 * roster to `logs/debug.log` instead, keyed by **file name**, which is the one
 * identifier an unmanaged jar always has.
 *
 * Scoped to the last boot marker in the scanned prefix. Forge truncates the
 * debug log per boot, so in practice the whole prefix is this run; but log4j can
 * still roll it mid-run, and a roster left over from the previous boot would
 * otherwise be read as this one's.
 */
async function readAddonRoster(
	inst: InstanceConfig,
): Promise<{ discovered: Record<string, string[]>; complete: boolean }> {
	const traits = traitsOf(inst.software, inst.mcVersion);
	const roster = traits.addonRoster;

	if (!roster) {
		return EMPTY_ROSTER;
	}

	const path = join(instanceDir(inst), roster.file);

	if (!existsSync(path)) {
		return EMPTY_ROSTER;
	}

	const handle = Bun.file(path);

	let key: string;

	try {
		const head = await handle.slice(0, ROSTER_KEY_BYTES).text();

		key = `${path}:${head.split(/\r?\n/, 1)[0] ?? ""}`;
	} catch {
		// unreadable is not the same as absent, but it answers the same way
		return EMPTY_ROSTER;
	}

	const hit = rosters.get(key);

	if (hit) {
		return hit;
	}

	let lines: string[];

	try {
		lines = (await handle.slice(0, roster.scanBytes).text()).split(/\r?\n/);
	} catch {
		return EMPTY_ROSTER;
	}

	let start = 0;

	for (let index = lines.length - 1; index >= 0; index -= 1) {
		if (traits.bootMarker.test(lines[index]!)) {
			start = index;

			break;
		}
	}

	const discovered: Record<string, string[]> = {};

	for (let index = start; index < lines.length; index += 1) {
		const match = roster.line.exec(lines[index]!);

		if (!match) {
			continue;
		}

		discovered[match[1]!.trim()] = match[2]!
			.split(",")
			.map((id) => id.trim())
			.filter(Boolean);
	}

	const result = { discovered, complete: Object.keys(discovered).length > 0 };

	if (rosters.size > ROSTER_CACHE_MAX) {
		rosters.clear();
	}

	rosters.set(key, result);

	return result;
}

const EMPTY_ROSTER = { discovered: {}, complete: false };

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

	const roster = await readAddonRoster(inst);
	const session = start === -1 ? lines : lines.slice(start);

	return {
		lines: session,
		complete: start !== -1,
		software: inst.software,
		...(inst.mcVersion ? { mcVersion: inst.mcVersion } : {}),
		startupComplete: startupComplete(inst.software, inst.mcVersion, session),
		...(writtenAt !== undefined ? { writtenAt } : {}),
		discovered: roster.discovered,
		discoveredComplete: roster.complete,
		failed: loaderFailures(inst.software, inst.mcVersion, session),
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
 *
 * FATAL is read as an error rather than a level of its own: log4j's own scale
 * puts it above ERROR, every writer of it means "and now we stop", and the
 * tallies an operator reads are warnings and errors. What FATAL additionally
 * does is prove a *failure* rather than a complaint, which `FATAL_LEVEL` below
 * is what tests for.
 */
const SEVERITY = /\[[^\]]*\/(WARN|ERROR|FATAL)\]|\[(WARN|ERROR|FATAL)\]:|^\[(WARN|ERROR|FATAL)\]/;

/** Severity of one log line, when it carries one. */
function severityOf(line: string): "warn" | "error" | undefined {
	const match = line.match(SEVERITY);

	if (!match) {
		return undefined;
	}

	const level = (match[1] ?? match[2] ?? match[3])!.toLowerCase();

	return level === "warn" ? "warn" : "error";
}

/**
 * Minecraft's colour codes, which forge writes into the *message* of its mod
 * loading errors (`Mod §elunacore§r only supports §3voicechat§r`). They have to
 * come out before anything can be matched, or every mod id in that block carries
 * a stray `§e` on the front.
 */
const COLOUR_CODES = /§./g;

/** A log line reduced to something matchable: no colour codes, lowercased. */
function plain(line: string): string {
	return line.replace(COLOUR_CODES, "").toLowerCase();
}

/**
 * The loader's aggregated failure header. What follows is one entry per
 * offending mod, and the two loader families lay it out differently.
 *
 * Forge (1.16 through 1.21), and NeoForge up to 1.20.6, joins the entries into a
 * bracketed list and leaves Minecraft's colour codes in - they survive because
 * the text reaches the log as an exception *message*, which the layout's
 * `%minecraftFormatting{…}{strip}` never touches:
 *
 * ```
 * net.minecraftforge.fml.LoadingFailedException: Loading errors encountered: [
 * 	Mod §elunacore§r only supports §3voicechat§r §o2.5.0 or above§r
 * §7Currently, §3voicechat§r§7 is §o1.20.1-2.5.34
 * ]
 * ```
 *
 * NeoForge 1.21 and up replaced the class and the shape: no brackets, one `- `
 * entry per line, continuations indented two further spaces, colour codes
 * stripped by the loader itself, and possibly a second `Loading warnings
 * encountered:` section after it that must **not** be read as failure.
 *
 * ```
 * net.neoforged.fml.ModLoadingException: Loading errors encountered:
 * 	- Mod delightlib requires neoforge 21.1.228 or above
 * 	  Currently, neoforge is 21.1.222
 * ```
 *
 * The first was captured verbatim from a real refusal on this cluster; the
 * second matters because a NeoForge 1.21 backend runs here too. This block is
 * the only place the loader names *which* mod stopped the boot - the lines
 * around it (`Failed to start the minecraft server`, the crash-report path) say
 * a mod did and never which.
 */
const LOADER_FATAL_HEADER = /loading errors encountered:/;

/** The warnings section that follows it on NeoForge; not failures. */
const LOADER_WARNING_HEADER = /loading warnings encountered:/;

/**
 * How a mod is named inside that block, and in the loader's other per-mod
 * failures. Each is matched against a colour-stripped, lowercased line, with any
 * leading `- ` list marker already removed.
 *
 * Every capture is a mod **id** except the parenthesised display form
 * (`LunaCore (lunacore) has failed to load correctly`), where both halves are
 * taken: the id is what a lockfile alias matches, the display name is what an
 * unmanaged jar's descriptor gives.
 */
const LOADER_FAILURE_NAMES: RegExp[] = [
	// "Mod <id> requires <dep> …" / "Mod <id> only supports <dep> …" - the
	// capture is the *requiring* mod, which is the one that failed
	/^mod\s+([a-z0-9_.-]+)\s+(?:requires|only supports|is present in multiple files)/,
	/\(([a-z0-9_.-]+)\)\s+has failed to load/,
	/\(([a-z0-9_.-]+)\)\s+encountered an error (?:during|while)/,
	/mixin application of \S+ from .*\(([a-z0-9_.-]+)\)\s+has failed/,
	/failed to create mod instance\.\s*modid:\s*([a-z0-9_.-]+)/,
	/failed to apply mixin\..*modid:\s*([a-z0-9_.-]+)/,
	/failed to register automatic subscribers\.\s*modid:\s*([a-z0-9_.-]+)/,
	/caught exception (?:during|while) [^,]*?(?:for|from) mod(?:id)?\s+([a-z0-9_.-]+)/,
	// ModSorter's discovery-time table: the mod that asked is the broken one,
	// not the dependency it asked for
	/requested by:\s*'([a-z0-9_.-]+)'/,
	// legacy FML names the mod it could not construct
	/caught exception from\s+([a-z0-9_.-]+)/,
];

/**
 * Mixin failures that are terminal, as opposed to the many that are not.
 *
 * A mixin whose target is absent is *skipped*, and both the loader and the mod
 * carry on: `@Mixin target … was not found`, `@Redirect conflict. Skipping …`
 * and `Mixin config … not applied as required mod 'create' is missing` are all
 * routine on a large modpack (the 240-mod pack here logs a hundred of them a
 * boot) and none of them breaks anything. Only an *apply* failure or a critical
 * injection failure stops the mod, so the ` from mod <id>` attribution is only
 * read off a line that says one of those happened.
 */
const MIXIN_FATAL = /mixin apply failed|failed during apply|critical injection failure/;

/** How the mixin fork attributes a mixin to its owner: `… from mod <modid>`. */
const MIXIN_OWNER = /from mod ([a-z0-9_.-]+)/;

/**
 * Addons the loader itself declared broken, as lowercased ids and names.
 *
 * Kept separate from the per-addon walk for two reasons. The evidence is a block
 * rather than a line, so it can only be read in order; and it is one block for
 * the whole session, so parsing it once instead of once per row saves a modpack's
 * several hundred repeats of the same scan.
 *
 * A failure the loader announces outranks everything else the session says about
 * that addon. This is the case the report used to get wrong: the server goes on
 * to print `Done (…)!` on a *later* boot attempt, or the addon logged an
 * encouraging line before dying, and a row whose mod never loaded reported
 * `running`.
 */
function loaderFailures(
	software: Software,
	mcVersion: string | undefined,
	lines: string[],
): string[] {
	const grammar = traitsOf(software, mcVersion).logGrammar;

	if (grammar !== "modlauncher" && grammar !== "fml") {
		return [];
	}

	const failed = new Set<string>();

	const claim = (text: string): void => {
		// the list marker is part of the layout, not of the entry
		const entry = text.replace(/^[\s\t]*[-*]\s+/, "").trim();

		for (const pattern of LOADER_FAILURE_NAMES) {
			const match = pattern.exec(entry);

			if (!match) {
				continue;
			}

			for (const name of match.slice(1)) {
				if (name) {
					failed.add(name);
				}
			}

			return;
		}
	};

	let inBlock = false;

	for (const rawLine of lines) {
		const line = plain(rawLine);

		if (LOADER_FATAL_HEADER.test(line)) {
			inBlock = true;

			// Forge carries the list open-bracket on the header and its first entry
			// on the next line; NeoForge 1.21 inlines the issue after the colon, as
			// it also does on "Error during pre-loading phase: <issue>"
			claim(line.slice(line.indexOf("encountered:") + "encountered:".length).replace(/^\s*\[/, ""));

			continue;
		}

		if (inBlock) {
			// Forge closes with a bracket of its own; NeoForge just stops, so the
			// stack frames that follow the throwable, and its warnings section, are
			// what end the block there
			if (/^\s*\]/.test(rawLine) || /^\s*at\s+\S/.test(rawLine) || LOADER_WARNING_HEADER.test(line)) {
				inBlock = false;

				continue;
			}

			claim(line);

			continue;
		}

		// "Error during pre-loading phase" carries the issue inline on NeoForge
		if (line.includes("error during pre-loading phase:")) {
			claim(line.slice(line.indexOf("phase:") + "phase:".length));

			continue;
		}

		// A mixin that failed to apply is attributed by the mixin's own name, which
		// the loader's fork suffixes with the owning mod
		if (MIXIN_FATAL.test(line)) {
			const owner = MIXIN_OWNER.exec(line)?.[1];

			if (owner) {
				failed.add(owner);
			}

			continue;
		}

		// the per-mod failures the loader prints outside any block
		if (
			line.includes("has failed to load") ||
			line.includes("failed to create mod instance") ||
			line.includes("failed to apply mixin") ||
			line.includes("caught exception") ||
			line.includes("requested by:")
		) {
			claim(line);
		}
	}

	return [...failed];
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

	// A great many mods hand log4j their main class rather than a name, so the
	// logger arrives fully qualified: `insane96mcp.insanelib.InsaneLib` for the
	// mod `insanelib`, `com.armilp.ezvcsurvival.EZVCSurvival` for `ezvcsurvival`.
	// The last segment is the class, and a mod's main class is named after the mod
	// often enough to be worth trying; the package segment before it is the same
	// name again just as often. Matched whole, like the plain form, so
	// `…LunaCoreMessaging` still cannot be credited to `luna-core`.
	const segments = logger.includes(".") ? logger.split(".").filter(Boolean) : [];
	const tail = segments.slice(-2);

	return lowerAliases.some(
		(alias) =>
			logger === alias ||
			bare === alias ||
			tail.some((segment) => segment === alias || segment.replace(suffix, "") === alias),
	);
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
	// LuckPerms says it the other way round - "Successfully enabled. (took 23601ms)"
	// - and with only the phrase above, the one addon on a modded backend that
	// states plainly that it came up was still reported as unknown.
	"successfully enabled",
	"successfully loaded",
	"initialized",
	"initialised",
	// LunaCore and friends log in Vietnamese. "đã sẵn sàng" is the phrase every
	// luna module except the core itself announces with, so leaving it out reported
	// a whole modded backend as unknown while the core alone read as running.
	"đã khởi động",
	"khởi động thành công",
	"đã sẵn sàng",
	"đã nạp",
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

/**
 * One entry of it. The prefix is what the loader draws to nest a dependency, and
 * it repeats per level: `\t- appleskin 3.0.7`, then `\t   |-- kuma_api 21.10.5`,
 * then `\t   |    |-- net_kyori_adventure-api 4.25.0`. Matching only one level of
 * it (the old `^\s*`) meant every transitively-bundled library reported as
 * `unknown`, which on a fabric pack is most of the mods directory.
 */
const FABRIC_ROSTER_ENTRY = /^[\s|\\]*(?:[|\\]--|-)\s*([a-z0-9_.-]+)(?:\s+\S+)?$/;

/**
 * Phrases that, on a line **attributed to the addon**, mean it is broken rather
 * than merely complaining.
 *
 * This is the half of the report that was missing: an addon whose own logger
 * printed a stack trace, and which the server then outlived, was reported
 * `running` on the strength of the server having finished starting. The server
 * finishing says nothing about whether one addon inside it died - most platforms
 * carry on quite happily without a mod that threw during setup.
 *
 * Deliberately narrow. Every entry here is terminal by construction: a linkage
 * error means the class the addon needs is not there, an unhandled or uncaught
 * exception means nothing caught it, and "failed to" is the platforms' own
 * phrasing for giving up. Words that merely *sound* bad ("error", "could not")
 * are left out, because addons log both while recovering perfectly well - a
 * missing optional integration, a config key falling back to its default - and
 * an addon reported broken for a warning it handled is worse than one reported
 * `unknown`.
 */
const FATAL_HINTS = [
	"unhandled exception",
	"uncaught exception",
	"exception in thread",
	"failed to load",
	"failed to initialize",
	"failed to initialise",
	"failed to enable",
	"failed to start",
	"noclassdeffounderror",
	"classnotfoundexception",
	"nosuchmethoderror",
	"nosuchfielderror",
	"unsupportedclassversionerror",
	"incompatibleclasschangeerror",
	"exceptionininitializererror",
	// bukkit's own wording when a plugin's onEnable threw; the plugin is left
	// loaded but disabled, which is exactly the state that used to read as running
	"error occurred while enabling",
];

/** Whether a line attributed to an addon says the addon itself failed. */
function claimsFatal(plainLine: string): boolean {
	return FATAL_HINTS.some((hint) => plainLine.includes(hint));
}

/**
 * Whether the loader's own failure list names this addon.
 *
 * Matched against both the aliases and the addon's file name, because the two
 * grammars name it differently: modlauncher's block names the mod *id*, while a
 * jar nothing manages is only ever identified by its file.
 */
function declaredFailed(session: BootSession, lowerAliases: string[], file?: string): boolean {
	// a follower on an older build answers this op without the field
	const declared = session.failed ?? [];

	if (!declared.length) {
		return false;
	}

	if (declared.some((name) => lowerAliases.includes(name))) {
		return true;
	}

	if (!file) {
		return false;
	}

	// the roster is what turns a file back into the ids inside it
	const ids = rosterIdsFor(session, file);

	return ids.some((id) => declared.includes(id));
}

/**
 * The ids the loader's roster says a given addon file carried, lowercased.
 *
 * The lookup is case-insensitive because a deployed jar's name is whatever the
 * operator or the provider spelled it (`Atlas Lib-1.20.1-1.1.12.jar`), and the
 * lockfile's copy of that name need not agree on case.
 */
function rosterIdsFor(session: BootSession, file: string): string[] {
	const wanted = file.toLowerCase();

	for (const [name, ids] of Object.entries(session.discovered ?? {})) {
		if (name.toLowerCase() === wanted) {
			return ids.map((id) => id.toLowerCase());
		}
	}

	return [];
}

/**
 * What the loader's own roster says about one addon.
 *
 * hit          the roster names its file, or one of the ids it declares
 * absent       the roster was read, could have named this addon, and did not
 * inconclusive there is no roster, or the only handle on this addon is a file
 *              name - which proves presence when it matches and nothing at all
 *              when it does not
 */
type RosterVerdict = "hit" | "absent" | "inconclusive";

/**
 * Read the roster for one addon.
 *
 * The asymmetry is the whole point: **a file name can prove presence but never
 * absence.** A loader is free to rewrite the name it rosters, and modlauncher
 * does it constantly - it extracts nested mod jars under their inner name
 * (`kotlinforforge-4.11.0-all.jar` is rostered as `kffmod-4.11.0.jar`,
 * `Connector-1.0.0-beta.47+1.20.1.jar` as `…-mod.jar`) and remaps others onto a
 * suffixed one (`ResistanceBalancer-(NEO)FORGE-1.0.0_mapped_srg_1.20.1.jar`).
 * All four are loaded and working; all four are absent from the roster under the
 * name on disk. Reporting those `missing` would be a confident accusation
 * against four healthy mods, which is worse than admitting ignorance.
 *
 * So absence is only ever concluded from an **id the addon declares about
 * itself**, read out of its own descriptor. `identified` is what says we have
 * one: without it the aliases are a file name with its extension trimmed, and
 * that is not evidence of anything.
 */
function rosterVerdict(
	session: BootSession,
	lowerAliases: string[],
	file: string | undefined,
	identified: boolean,
	/** Base names of the jars packaged inside it, which the loader rosters instead */
	nested: string[] = [],
): RosterVerdict {
	if (!session.discoveredComplete) {
		return "inconclusive";
	}

	for (const name of file ? [file, ...nested] : nested) {
		if (rosterIdsFor(session, name).length) {
			return "hit";
		}
	}

	for (const ids of Object.values(session.discovered ?? {})) {
		if (ids.some((id) => lowerAliases.includes(id.toLowerCase()))) {
			return "hit";
		}
	}

	return identified ? "absent" : "inconclusive";
}

/** What the caller knows about one addon, beyond the names it logs under. */
interface AddonIdentity {
	/** Its file in the instance's addon directory */
	file?: string;
	/**
	 * Whether the aliases came from the addon's own descriptor rather than from
	 * its file name. Only a self-declared id can prove the roster's silence
	 * means absence; see `rosterVerdict`.
	 */
	identified?: boolean;
	/** Base names of any jars packaged inside it, which the loader rosters instead */
	nested?: string[];
}

/** Load, ready and failure evidence for one addon in a session. */
function loadEvidence(
	session: BootSession,
	aliases: string[],
	identity: AddonIdentity = {},
): AddonEvidence {
	const lowerAliases = aliases.map((alias) => alias.toLowerCase());
	const grammar = traitsOf(session.software, session.mcVersion).logGrammar;
	const { file, identified = false, nested = [] } = identity;

	// The loader saying so outranks every other kind of evidence, including the
	// server having finished starting: a mod named in a fatal block never ran, and
	// the boot that printed `Done (…)!` was a later attempt without it.
	if (declaredFailed(session, lowerAliases, file)) {
		return "errored";
	}

	const verdict = rosterVerdict(session, lowerAliases, file, identified, nested);

	// A roster in a log of its own (modlauncher writes one to debug.log and none
	// to latest.log) is positive proof of discovery for an addon that says nothing
	// itself, which on a modpack is nearly all of them.
	let loading = verdict === "hit";
	let ready = false;

	// A mod loader has no per-mod "enabling" line. What modlauncher does print is
	// a roster of everything it constructed, one line per mod ending in the mod id
	//; "\t\tLunaCore 0.1.0-SNAPSHOT (lunacore)". Absence only means "not there"
	// when the roster was captured at all, so its two guaranteed members double
	// as the marker that it is in the session.
	// Absence only means "not there" when the roster was captured at all, so each
	// loader that prints one carries its own marker for having reached it.
	//
	// A separate-log roster licenses the same conclusion, but only for an addon it
	// could have named by id: `rosterVerdict` is where that asymmetry lives.
	let roster =
		verdict === "absent" ||
		(grammar !== "modlauncher" && grammar !== "fabric" && grammar !== "fml");

	for (const rawLine of session.lines) {
		const lower = rawLine.trimEnd().toLowerCase();
		const mine = attributed(lower, lowerAliases, session);

		// An addon's own logger reporting that it failed is the case the report
		// used to lose: nothing else in the session contradicts it, the server
		// finishes starting regardless, and the row read `running`.
		//
		// Gated on the line's own severity, which is what keeps the wording from
		// over-reaching. Addons announce recovered problems in the same words they
		// announce fatal ones ("failed to load the optional Vault hook") and do it
		// at WARN; requiring ERROR or FATAL is what separates "I gave up" from "I
		// carried on without it", and a false `errored` is a worse answer than the
		// `unknown` it would replace.
		if (mine && severityOf(rawLine) === "error" && claimsFatal(plain(rawLine))) {
			return "errored";
		}

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
				// Bukkit's enable failure is logged by the *server*, not by the
				// plugin, so it carries no `[Name]` field and `attributed` cannot see
				// it: the plugin is named in the message instead, as its "full name"
				// (`Name vX`). Paper additionally wraps ten variants of the same
				// message in "(in the plugin loader)", which is why the middle is
				// matched loosely rather than spelled out.
				if (
					/^.*error occurred (?:\(in the plugin loader\) )?while (?:enabling|disabling) /.test(lower) &&
					lower.includes(`while enabling ${alias} `)
				) {
					return "errored";
				}

				// Three wordings across versions, and the modern pair names the jar
				// rather than the plugin: legacy `Could not load '<path>' in folder
				// '<dir>'`, modern `Could not load '<path>' in '<dir>'` (a missing
				// dependency) and `Could not load plugin '<file>' in folder '<dir>'`.
				// So the file is tested as well as the name.
				if (
					lower.includes("could not load") &&
					(lower.includes(alias) || (file && lower.includes(file.toLowerCase())))
				) {
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
				// `Can't create plugin <id>` is the one that names the id; the other
				// two name a path (`Unable to load plugin plugins/x.jar`) or add a
				// dependency after the id (`Can't load plugin <id> due to missing
				// dependency <dep>`).
				if (
					lower.includes(`can't create plugin ${alias}`) ||
					lower.includes(`can't create module for plugin ${alias}`) ||
					lower.includes(`can't load plugin ${alias} due to missing dependency`)
				) {
					return "errored";
				}

				if (
					lower.includes("unable to load plugin") &&
					file &&
					lower.includes(file.toLowerCase())
				) {
					return "errored";
				}

				if (lower.includes(`loaded plugin ${alias} `)) {
					loading = true;
				}
			} else if (grammar === "fabric") {
				// "Could not execute entrypoint stage 'main' due to errors, provided
				// by 'modid' at 'the.Class'!" - the loader's own wrapper, and the only
				// line that names which mod crashed on startup. The trailing `at`
				// clause is absent on older loaders.
				if (
					lower.includes("could not execute entrypoint stage") &&
					lower.includes(`provided by '${alias}'`)
				) {
					return "errored";
				}

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

			// a jar whose descriptor luna could read declares its own ids, which is
			// what makes the roster's silence about it mean something; without one,
			// all we have is a file name the loader is free to rewrite
			const identified = jar.aliases.length > 0;
			const aliases = identified ? jar.aliases : [file.replace(/\.[^.]+$/, "")];
			const log = session ? pluginLogReport(session, aliases) : EMPTY_LOG;

			rows.push({
				file,
				dir,
				sizeBytes: size,
				modifiedAt,
				...(Object.keys(jar.meta).length ? { meta: jar.meta } : {}),
				displayName: aliases[0]!,
				state: session ? unmanagedState(session, aliases, file, identified, jar.nested) : unattributed,
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
function unmanagedState(
	session: BootSession,
	aliases: string[],
	file: string,
	identified: boolean,
	nested: string[],
): PluginRuntimeState {
	const evidence = loadEvidence(session, aliases, { file, identified, nested });

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
			const evidence = loadEvidence(session, aliases, {
				file: entry.file,
				identified: Boolean(entry.aliases?.length),
			});

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
