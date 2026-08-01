/**
 * Plugin runtime state and log attribution.
 *
 * The only truth about whether a plugin actually *loaded* is the server log,
 * and Paper's log4j rolls latest.log at midnight as well as on restart — so
 * the current boot session is reconstructed by walking the rotated .gz files
 * backwards until the boot marker is found. Attribution matches a plugin's
 * *aliases* (plugin.yml `name`, velocity-plugin.json `name`/`id`), which are
 * extracted from the pooled jar once and cached on the lock entry.
 */

import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { ClusterConfig, PluginEntry, PluginFamily, PluginMeta, PluginsLock } from "./types";
import { instanceDir, managedInstances, poolDir } from "./config";
import {
	effectiveTargets,
	familyMatches,
	familyOf,
	instanceGroupNames,
	pluginNameOf,
} from "./families";
import { assignedVersion } from "./plugins";
import { getStatus } from "./instances";

/** Rotated files walked back at most, looking for the boot marker. */
const MAX_ROTATIONS = 6;

/** Decompressed session bytes read at most. */
const MAX_SESSION_BYTES = 8 * 1024 * 1024;

/**
 * running    — the server enabled/loaded it this session and is up
 * errored    — the log says enabling/loading it failed
 * not-loaded — deployed, but this session never loaded it (installed after boot)
 * disabled   — per-instance override keeps it off the instance
 * stopped    — the instance is not running
 * unknown    — the boot lines rotated out of reach, and there is no evidence
 */
export type PluginRuntimeState =
	| "running"
	| "errored"
	| "not-loaded"
	| "disabled"
	| "stopped"
	| "unknown";

export interface BootSession {
	lines: string[];
	/** Whether the boot marker was found — without it absence proves nothing */
	complete: boolean;
}

/** Read one member of a jar (jars are zip files); undefined when absent. */
async function unzipRead(jar: string, member: string): Promise<string | undefined> {
	const proc = Bun.spawn(["unzip", "-p", jar, member], {
		stdout: "pipe",
		stderr: "ignore",
	});

	const text = await new Response(proc.stdout).text();

	await proc.exited;

	if (proc.exitCode !== 0 || !text.trim()) {
		return undefined;
	}

	return text;
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
 * bukkit-side builds, `velocity-plugin.json` for the proxy side, and
 * `neoforge.mods.toml` for neoforge mods. Later sources fill gaps rather than
 * overwrite, so a universal jar keeps its bukkit name but gains the velocity id.
 */
async function readJarInfo(path: string): Promise<JarInfo> {
	const meta: PluginMeta = {};
	const aliases: string[] = [];

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
			// not valid JSON — some shaded jars carry junk under that path
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
 * in a .gz). Bounded — a marker further back than the caps yields
 * `complete: false`.
 */
export async function readBootSession(cfg: ClusterConfig, instance: string): Promise<BootSession> {
	const inst = managedInstances(cfg)[instance];

	if (!inst) {
		throw new Error(`unknown instance: ${instance}`);
	}

	const logsDir = join(instanceDir(inst), "logs");
	const marker =
		inst.software === "velocity"
			? /Booting up Velocity/
			: /\[bootstrap\] Running Java|Starting minecraft server version/;

	let text = "";
	const latest = join(logsDir, "latest.log");

	if (existsSync(latest)) {
		text = await Bun.file(latest).text();
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

	// the LAST marker starts the current session — older sessions may sit above it
	let start = -1;

	for (let index = lines.length - 1; index >= 0; index -= 1) {
		if (marker.test(lines[index]!)) {
			start = index;

			break;
		}
	}

	if (start === -1) {
		return { lines, complete: false };
	}

	return { lines: lines.slice(start), complete: true };
}

const SEVERITY = /\[[^\]]*\/(WARN|ERROR)\]|\[(WARN|ERROR)\]:/;

/** Severity of one log line, when it carries one. */
function severityOf(line: string): "warn" | "error" | undefined {
	const match = line.match(SEVERITY);

	if (!match) {
		return undefined;
	}

	return (match[1] ?? match[2])!.toLowerCase() as "warn" | "error";
}

/** Whether a line is attributed to one of the aliases (`[Name]` anywhere). */
function attributed(lowerLine: string, lowerAliases: string[]): boolean {
	return lowerAliases.some((alias) => lowerLine.includes(`[${alias}]`));
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

		if (!attributed(lower, lowerAliases)) {
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

/** Load/enable evidence for one plugin in a session. */
function loadEvidence(
	session: BootSession,
	software: "paper" | "velocity",
	aliases: string[],
): "loaded" | "errored" | "none" {
	const lowerAliases = aliases.map((alias) => alias.toLowerCase());
	let loaded = false;

	for (const line of session.lines) {
		const lower = line.toLowerCase();

		for (const alias of lowerAliases) {
			if (software === "paper") {
				// bukkit prints "[Name] Enabling Name vX"; failures follow as
				// "Error occurred while enabling Name vX"
				if (lower.includes(`error occurred while enabling ${alias} `)) {
					return "errored";
				}

				if (lower.includes(`could not load plugin`) && lower.includes(alias)) {
					return "errored";
				}

				if (lower.includes(`enabling ${alias} v`) || lower.includes(`disabling ${alias} v`)) {
					loaded = true;
				}
			} else {
				if (lower.includes(`can't create plugin ${alias}`)) {
					return "errored";
				}

				if (lower.includes(`loaded plugin ${alias} `)) {
					loaded = true;
				}
			}
		}
	}

	return loaded ? "loaded" : "none";
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
 * Full plugin report for one instance: every entry that deploys there plus the
 * ones its overrides disabled, each with its runtime state and the warn/error
 * counts attributed to it in the current boot session.
 */
export async function instancePluginReport(
	cfg: ClusterConfig,
	lock: PluginsLock,
	instance: string,
	opts: { running?: boolean } = {},
): Promise<{ rows: InstancePluginRow[]; session: BootSession }> {
	const inst = managedInstances(cfg)[instance];

	if (!inst) {
		throw new Error(`unknown instance: ${instance}`);
	}

	const running =
		opts.running ?? (await getStatus(cfg, instance)).state !== "stopped";

	const session = await readBootSession(cfg, instance);
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
			state = "disabled";
		} else if (!running) {
			state = "stopped";
		} else {
			const evidence = loadEvidence(session, inst.software, aliases);

			if (evidence === "errored") {
				state = "errored";
			} else if (evidence === "loaded") {
				state = "running";
			} else {
				state = session.complete ? "not-loaded" : "unknown";
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

	return { rows: rows.sort((a, b) => a.plugin.localeCompare(b.plugin)), session };
}

export interface PluginUsageRow {
	instance: string;
	software: "paper" | "velocity";
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
 * deploys a build of it — or disabled it. The build listed is the one the
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
 * lockfile — the disable path: the override already keeps deploy from
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
		throw new Error(`unknown instance: ${instance}`);
	}

	const removed: string[] = [];

	for (const [key, entry] of Object.entries(lock.plugins)) {
		if (pluginNameOf(key, entry) !== plugin) {
			continue;
		}

		const path = join(instanceDir(inst), "plugins", entry.file);

		if (existsSync(path)) {
			await rm(path);
			removed.push(entry.file);

			delete entry.assign?.[instance];
			delete entry.pins?.[instance];
		}
	}

	return removed;
}
