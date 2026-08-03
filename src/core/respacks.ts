/**
 * Resource pack management, built around the luna-pack proxy plugin
 * (~/luna-plugins/luna-pack): every pack is a zip in `<root>/packs` beside a
 * `.yml` definition (name, filename, priority, required, enabled, server
 * rules) that the plugin's PackRepository reads. This module manages those
 * files — listing, editing, uploading, installing and updating from Modrinth —
 * and asks the running proxy to `lunapack reload` so changes go live without a
 * restart. Provenance (where a zip came from, what version it is) lives in
 * `packs.lock.json` (packslock.ts); behaviour stays in the `.yml`s, which the
 * plugin owns.
 *
 * Definition files are written wholesale, not surgically: luna-pack itself
 * rewrites them from scratch on `/lunapack enable|disable`, so there is no
 * hand-authored formatting to preserve.
 */

import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { root } from "./config";
import { groupsWith, memberInstances } from "./families";
import * as instances from "./instances";
import {
	decodePackZip,
	packKeyFrom,
	PACK_KEY_PATTERN,
	type PackChannel,
	type PackEntry,
	type PacksLock,
	type PackSource,
} from "./packslock";
import * as mr from "./services/modrinth";
import type { AddonGroup, ClusterConfig } from "./types";

/** Directory all resource packs (zips + yml definitions) live in. */
export function respacksDir(): string {
	return join(root(), "packs");
}

/** One pack's behaviour, as its `.yml` definition declares it to luna-pack. */
export interface RespackDefinition {
	/** Display name — luna-pack keys its catalog on this, lowercased */
	name: string;
	/** Zip file name in the packs directory */
	filename: string;
	/** Stacking order: higher priority packs apply over lower ones */
	priority: number;
	/** Players cannot decline a required pack */
	required: boolean;
	enabled: boolean;
	/** Server rules: names, "*" for all, "!name" to exclude */
	servers: string[];
}

/** One resource pack as the console and CLI list it. */
export interface RespackRow extends RespackDefinition {
	/** Registry key — the definition file's basename */
	key: string;
	/** Definition file name; undefined for a zip with no registration yet */
	defFile?: string;
	/** Whether the zip the definition points at exists */
	present: boolean;
	sizeBytes: number;
	source: PackSource;
	versionNumber?: string;
	autoUpdate: boolean;
	channel?: PackChannel;
	modrinth?: { projectId: string; slug: string };
	/** Instance names the server rules currently match */
	matched: string[];
	/** Addon groups carrying this pack */
	groups: string[];
	/** Rules the groups contribute — the rest of `servers` is the operator's */
	granted: string[];
}

/**
 * Whether a pack's server rules match one backend name — a direct port of
 * luna-pack's `PackDefinition.matchesServer`, so the console predicts exactly
 * what the plugin will do. Exclusions win; "all" is an alias for "*".
 */
export function respackMatchesServer(servers: string[], serverName: string): boolean {
	const normalized = serverName.trim().toLowerCase();
	let included = false;

	for (const rawRule of servers) {
		let rule = rawRule.trim().toLowerCase();

		if (!rule) {
			continue;
		}

		const excluded = rule.startsWith("!");

		if (excluded) {
			rule = rule.slice(1).trim();
		}

		if (rule === "all") {
			rule = "*";
		}

		const matches = rule === "*" || rule === normalized;

		if (!matches) {
			continue;
		}

		if (excluded) {
			return false;
		}

		included = true;
	}

	return included;
}

/**
 * Backends an addon group grants this pack. The proxy serves resource packs
 * rather than receiving them, so it never appears in a rule list.
 */
export function respackGroupServers(
	cfg: ClusterConfig,
	groups: Record<string, AddonGroup> | undefined,
	key: string,
): string[] {
	return memberInstances(cfg, groups, "respacks", key).filter((name) => name !== "proxy");
}

/**
 * The rule list a pack's definition should carry: the operator's own rules
 * first, then the backends its groups grant. A pack that belongs to a group
 * records its manual rules in the lock the first time it is materialized, so
 * leaving the group takes exactly the granted names away again.
 *
 * An empty result would be an *invalid* definition (luna-pack skips a pack with
 * no rules), so "nothing" is spelled out as the one rule that matches nothing.
 */
function mergedServers(manual: string[], granted: string[]): string[] {
	const out = [...manual];

	for (const name of granted) {
		if (!out.includes(name)) {
			out.push(name);
		}
	}

	return out.length ? out : ["!*"];
}

/** Parse one definition yml; undefined when the file is not a valid definition. */
async function readDefinition(path: string): Promise<RespackDefinition | undefined> {
	let raw: unknown;

	try {
		raw = Bun.YAML.parse(await Bun.file(path).text());
	} catch {
		return undefined;
	}

	if (typeof raw !== "object" || raw === null) {
		return undefined;
	}

	const map = raw as Record<string, unknown>;
	const name = typeof map.name === "string" ? map.name.trim() : "";
	const filename = typeof map.filename === "string" ? map.filename.trim() : "";

	// same rejection luna-pack applies: a filename must stay inside the directory
	if (!name || !filename || /[/\\]|\.\./.test(filename)) {
		return undefined;
	}

	const servers = Array.isArray(map.servers)
		? map.servers.map((entry) => String(entry)).filter((entry) => entry.trim() !== "")
		: [];

	if (!servers.length) {
		return undefined;
	}

	return {
		name,
		filename,
		priority: typeof map.priority === "number" ? map.priority : 0,
		required: map.required === true,
		enabled: map.enabled !== false,
		servers,
	};
}

/** Write one definition yml wholesale, in luna-pack's own template shape. */
export async function saveDefinition(key: string, def: RespackDefinition): Promise<void> {
	if (!PACK_KEY_PATTERN.test(key)) {
		throw new Error(`invalid pack key: ${key}`);
	}

	const lines = [
		`name: "${def.name.replace(/"/g, "")}"`,
		`filename: "${def.filename.replace(/"/g, "")}"`,
		`priority: ${Math.round(def.priority)}`,
		`required: ${def.required}`,
		`enabled: ${def.enabled}`,
		"servers:",
		...def.servers.map((server) => `  - "${server.replace(/"/g, "")}"`),
	];

	await Bun.write(join(respacksDir(), `${key}.yml`), lines.join("\n") + "\n");
}

/**
 * Every resource pack the cluster has: registered definitions merged with
 * their zips, plus stray zips nothing registers yet (listed so they can be
 * registered or cleaned up rather than silently ignored).
 */
export async function listResourcePacks(
	cfg: ClusterConfig,
	lock: PacksLock,
	groups?: Record<string, AddonGroup>,
): Promise<RespackRow[]> {
	const dir = respacksDir();
	const backends = Object.keys(cfg.instances);
	const rows: RespackRow[] = [];

	let files: string[] = [];

	if (existsSync(dir)) {
		files = await readdir(dir);
	}

	const zips = new Set(files.filter((file) => file.toLowerCase().endsWith(".zip")));
	const defs = files.filter((file) => /\.ya?ml$/i.test(file)).sort();
	const claimed = new Set<string>();

	for (const defFile of defs) {
		const def = await readDefinition(join(dir, defFile));

		if (!def) {
			continue;
		}

		const key = defFile.replace(/\.ya?ml$/i, "").toLowerCase();
		const entry = lock.resourcepacks[key];
		const present = zips.has(def.filename);
		const size = present ? (await stat(join(dir, def.filename))).size : 0;

		claimed.add(def.filename);

		rows.push({
			...def,
			key,
			defFile,
			present,
			sizeBytes: size,
			source: entry?.source ?? "manual",
			versionNumber: entry?.installed?.versionNumber,
			autoUpdate: entry?.autoUpdate ?? false,
			channel: entry?.channel,
			modrinth: entry?.modrinth,
			matched: backends.filter((name) => respackMatchesServer(def.servers, name)),
			groups: groupsWith(groups, "respacks", key),
			granted: respackGroupServers(cfg, groups, key),
		});
	}

	for (const zip of [...zips].sort()) {
		if (claimed.has(zip)) {
			continue;
		}

		const size = (await stat(join(dir, zip))).size;

		// unregistered: luna-pack cannot serve it until a definition exists
		rows.push({
			key: packKeyFrom(zip),
			name: zip.replace(/\.zip$/i, ""),
			filename: zip,
			priority: 0,
			required: false,
			enabled: false,
			servers: [],
			present: true,
			sizeBytes: size,
			source: "manual",
			autoUpdate: false,
			matched: [],
			groups: groupsWith(groups, "respacks", packKeyFrom(zip)),
			granted: [],
		});
	}

	return rows;
}

/** The fields of a definition an edit may change. */
export interface RespackPatch {
	name?: string;
	priority?: number;
	required?: boolean;
	enabled?: boolean;
	servers?: string[];
	autoUpdate?: boolean;
	channel?: PackChannel;
}

/**
 * Update one pack's definition (and its lock entry's update policy). A patch
 * for a stray zip creates its missing definition, registering it. For a pack
 * in an addon group the edited rules are the *manual* ones: they are recorded
 * in the lock and the group's backends are merged back in on the way to disk.
 */
export async function updateResourcePack(
	cfg: ClusterConfig,
	lock: PacksLock,
	key: string,
	patch: RespackPatch,
	groups?: Record<string, AddonGroup>,
): Promise<RespackRow> {
	const rows = await listResourcePacks(cfg, lock, groups);
	const row = rows.find((candidate) => candidate.key === key);

	if (!row) {
		throw new Error(`unknown resource pack: ${key}`);
	}

	const granted = respackGroupServers(cfg, groups, key);
	const current = row.servers.length ? row.servers : ["*"];
	const manual = patch.servers
		? patch.servers.filter((rule) => !granted.includes(rule))
		: (lock.resourcepacks[key]?.servers ?? current.filter((rule) => !granted.includes(rule)));

	const def: RespackDefinition = {
		name: patch.name ?? row.name,
		filename: row.filename,
		priority: patch.priority ?? row.priority,
		required: patch.required ?? row.required,
		enabled: patch.enabled ?? row.enabled,
		servers: granted.length || lock.resourcepacks[key]?.servers ? mergedServers(manual, granted) : current,
	};

	await saveDefinition(key, def);

	const entry = lock.resourcepacks[key];

	if (entry) {
		if (patch.autoUpdate !== undefined || patch.channel !== undefined) {
			entry.autoUpdate = patch.autoUpdate ?? entry.autoUpdate;
			entry.channel = patch.channel ?? entry.channel;

			if (entry.channel === "release") {
				delete entry.channel;
			}
		}

		// only a group member keeps a manual list — for everyone else the yml is
		// still the one place the rules live
		if (granted.length || entry.servers) {
			entry.servers = manual;
		}
	}

	const fresh = await listResourcePacks(cfg, lock, groups);

	return fresh.find((candidate) => candidate.key === key)!;
}

/**
 * Re-materialize addon-group membership into the packs' `.yml` rules: every
 * pack a group carries gains its instances, every pack that left one loses
 * them again. Packs no group has ever touched are not rewritten at all.
 *
 * This is the resource-pack half of applying a group — the data pack half is a
 * deploy — and it is what makes "add a pack to a group" reach the proxy.
 */
export async function syncResourcePackGroups(
	cfg: ClusterConfig,
	lock: PacksLock,
	groups: Record<string, AddonGroup> | undefined,
): Promise<string[]> {
	const rows = await listResourcePacks(cfg, lock, groups);
	const touched: string[] = [];

	for (const row of rows) {
		const entry = lock.resourcepacks[row.key];
		const granted = respackGroupServers(cfg, groups, row.key);

		// never in a group, never was: its rules are the operator's alone
		if (!granted.length && !entry?.servers) {
			continue;
		}

		const current = row.servers.length ? row.servers : [];
		const manual = entry?.servers ?? current.filter((rule) => !granted.includes(rule));
		const next = mergedServers(manual, granted);

		const record = (lock.resourcepacks[row.key] ??= {
			file: row.filename,
			source: "manual",
			autoUpdate: false,
		});

		if (granted.length) {
			record.servers = manual;
		} else {
			// out of every group: the yml owns the rules again, and a lock entry
			// that only ever existed to hold them goes with it
			delete record.servers;

			if (!record.modrinth && !record.installed && record.source === "manual") {
				delete lock.resourcepacks[row.key];
			}
		}

		if (next.length === current.length && next.every((rule, index) => rule === current[index])) {
			continue;
		}

		await saveDefinition(row.key, {
			name: row.name,
			filename: row.filename,
			priority: row.priority,
			required: row.required,
			// a pack registered by joining a group is meant to be served; one that
			// already had a definition keeps whatever the operator set
			enabled: row.defFile ? row.enabled : true,
			servers: next,
		});

		touched.push(row.key);
	}

	return touched;
}

/**
 * Add or replace a pack zip uploaded from the console. Creates the definition
 * when the pack is new (disabled targets nothing by default — enabling and
 * scoping is a deliberate second step) and records manual provenance.
 */
export async function addResourcePackFile(
	cfg: ClusterConfig,
	lock: PacksLock,
	name: string,
	dataBase64: string,
): Promise<RespackRow> {
	const key = packKeyFrom(name);
	const buf = decodePackZip(dataBase64);
	const file = `${key}.zip`;

	await Bun.write(join(respacksDir(), file), buf);

	const rows = await listResourcePacks(cfg, lock);
	const existing = rows.find((candidate) => candidate.key === key && candidate.defFile);

	if (!existing) {
		await saveDefinition(key, {
			name: key,
			filename: file,
			priority: 0,
			required: false,
			enabled: false,
			servers: ["*"],
		});
	}

	// an upload over a Modrinth-installed pack makes it manual: the file on
	// disk no longer is what the lock's installed version says it is
	lock.resourcepacks[key] = {
		file,
		source: "manual",
		autoUpdate: false,
		installed: { sha512: await mr.sha512File(join(respacksDir(), file)) },
	};

	const fresh = await listResourcePacks(cfg, lock);

	return fresh.find((candidate) => candidate.key === key)!;
}

/** Pick the newest acceptable version of a pack project on a channel. */
function pickPackVersion(
	versions: mr.MrVersion[],
	channel: PackChannel,
	afterDate?: string,
): mr.MrVersion | undefined {
	const { best } = mr.pickCompatible(versions, [], { channel, afterDate });

	return best;
}

/**
 * Install a resource pack from Modrinth: newest release (falling back through
 * beta and alpha for projects that never publish releases), downloaded into
 * the packs directory with a definition registering it everywhere, disabled —
 * going live is a deliberate enable + reload.
 */
export async function installResourcePackFromModrinth(
	cfg: ClusterConfig,
	lock: PacksLock,
	project: mr.MrProject,
	opts: { channel?: PackChannel } = {},
): Promise<RespackRow> {
	const key = packKeyFrom(project.slug);
	const versions = await mr.getVersions(project.id, mr.RESOURCEPACK_LOADERS);

	let channel = opts.channel ?? "release";
	let version = pickPackVersion(versions, channel);

	for (const fallback of ["beta", "alpha"] as const) {
		if (version || opts.channel) {
			break;
		}

		channel = fallback;
		version = pickPackVersion(versions, channel);
	}

	if (!version) {
		throw new Error(`no installable version of ${project.slug} on the ${channel} channel`);
	}

	const file = mr.primaryFile(version);
	const zipName = `${key}.zip`;

	await mr.download(file.url, join(respacksDir(), zipName), file.hashes.sha512);

	const entry: PackEntry = {
		file: zipName,
		source: "modrinth",
		modrinth: { projectId: project.id, slug: project.slug },
		installed: {
			versionId: version.id,
			versionNumber: version.version_number,
			sha512: file.hashes.sha512,
			gameVersions: version.game_versions,
			publishedAt: version.date_published,
		},
		autoUpdate: true,
	};

	if (channel !== "release") {
		entry.channel = channel;
	}

	lock.resourcepacks[key] = entry;

	const rows = await listResourcePacks(cfg, lock);
	const existing = rows.find((candidate) => candidate.key === key && candidate.defFile);

	if (!existing) {
		await saveDefinition(key, {
			name: project.title || key,
			filename: zipName,
			priority: 0,
			required: false,
			enabled: false,
			servers: ["*"],
		});
	}

	const fresh = await listResourcePacks(cfg, lock);

	return fresh.find((candidate) => candidate.key === key)!;
}

/** One available resource pack update. */
export interface RespackUpdate {
	key: string;
	from?: string;
	to: string;
	versionId: string;
	publishedAt: string;
	sha512: string;
	url: string;
}

/**
 * Check Modrinth for updates: channel-gated and downgrade-guarded by publish
 * date, exactly like plugin updates. Explicitly named packs are checked even
 * with auto-update off.
 */
export async function checkResourcePackUpdates(
	lock: PacksLock,
	names?: string[],
): Promise<{ updates: RespackUpdate[]; skipped: Array<{ key: string; reason: string }> }> {
	const updates: RespackUpdate[] = [];
	const skipped: Array<{ key: string; reason: string }> = [];

	for (const [key, entry] of Object.entries(lock.resourcepacks)) {
		if (names && !names.includes(key)) {
			continue;
		}

		if (entry.source !== "modrinth" || !entry.modrinth) {
			skipped.push({ key, reason: "not identified on modrinth" });

			continue;
		}

		if (!entry.autoUpdate && !names?.includes(key)) {
			skipped.push({ key, reason: "auto-update disabled" });

			continue;
		}

		const versions = await mr.getVersions(entry.modrinth.projectId, mr.RESOURCEPACK_LOADERS);
		const best = pickPackVersion(
			versions,
			entry.channel ?? "release",
			entry.installed?.publishedAt,
		);

		if (!best || best.id === entry.installed?.versionId) {
			continue;
		}

		const file = mr.primaryFile(best);

		if (file.hashes.sha512 === entry.installed?.sha512) {
			continue;
		}

		updates.push({
			key,
			from: entry.installed?.versionNumber,
			to: best.version_number,
			versionId: best.id,
			publishedAt: best.date_published,
			sha512: file.hashes.sha512,
			url: file.url,
		});
	}

	return { updates, skipped };
}

/** Download one checked update over the pack's zip and record the new version. */
export async function applyResourcePackUpdate(
	lock: PacksLock,
	update: RespackUpdate,
): Promise<void> {
	const entry = lock.resourcepacks[update.key];

	if (!entry) {
		throw new Error(`unknown resource pack: ${update.key}`);
	}

	await mr.download(update.url, join(respacksDir(), entry.file), update.sha512);

	entry.installed = {
		versionId: update.versionId,
		versionNumber: update.to,
		sha512: update.sha512,
		publishedAt: update.publishedAt,
	};
}

/**
 * Remove a resource pack: its definition, its lock entry and (unless kept) its
 * zip. Idempotent — removing an already-gone pack reports nothing touched.
 */
export async function removeResourcePack(
	cfg: ClusterConfig,
	lock: PacksLock,
	key: string,
	opts: { keepFile?: boolean } = {},
): Promise<{ removed: string[] }> {
	const rows = await listResourcePacks(cfg, lock);
	const row = rows.find((candidate) => candidate.key === key);
	const removed: string[] = [];

	if (row?.defFile) {
		await rm(join(respacksDir(), row.defFile));
		removed.push(row.defFile);
	}

	if (row && !opts.keepFile && row.present) {
		await rm(join(respacksDir(), row.filename));
		removed.push(row.filename);
	}

	if (lock.resourcepacks[key]) {
		delete lock.resourcepacks[key];
		removed.push("lock entry");
	}

	return { removed };
}

/**
 * Ask the running proxy to re-read the packs directory (`lunapack reload`), so
 * definition and zip changes go live without a restart. False when the proxy
 * is not running — the reload then simply happens on its next boot.
 */
export async function reloadResourcePacks(cfg: ClusterConfig): Promise<boolean> {
	return await instances.sendCommand(cfg, "proxy", "lunapack reload");
}
