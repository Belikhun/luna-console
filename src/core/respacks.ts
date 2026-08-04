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
import * as lunaApi from "./services/luna";
import {
	decodePackZip,
	packKeyFrom,
	PACK_KEY_PATTERN,
	type PackChannel,
	type PackEntry,
	type PacksLock,
	type PackSource,
} from "./packslock";
import { download, sha512File } from "./services/download";
import type { IdentityMatch, IdentityProbe } from "./identify";
import {
	autoUpdateDefault,
	chosenMatch,
	installedFrom,
	localFile,
	probeIdentity,
} from "./identify";
import type { AddonProject, AddonVersion, AddonVersionFile } from "./services/providers";
import { getVersions, pickCompatible, primaryFile, remoteRefFor } from "./services/providers";
import type { AddonGroup, ClusterConfig, ProviderId, RemoteRef } from "./types";
import { respackMatchesServer, toggleServerRule } from "../shared/packrules";

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

/**
 * How a pack came to be registered with luna-pack.
 *
 * `file`     a `.yml` in the packs directory — luna wrote it, luna can edit it
 * `dynamic`  a plugin registered it at runtime through luna-pack's API (e.g.
 *            luna-glyph builds its glyph pack and registers it on every reload).
 *            There is no file to edit: the registering plugin *is* the config.
 * `unknown`  a zip nothing on disk registers, and the proxy is not answering, so
 *            whether a plugin registers it at runtime cannot be known right now
 * `none`     a zip nothing registers, with a live proxy confirming it
 */
export type PackRegistration = "file" | "dynamic" | "unknown" | "none";

/** One resource pack as the console and CLI list it. */
export interface RespackRow extends RespackDefinition {
	/** Registry key — the definition file's basename */
	key: string;
	/** Definition file name; undefined for a zip with no registration yet */
	defFile?: string;
	/** Where this pack's registration lives */
	registration: PackRegistration;
	/** The runtime registration, when a plugin provides one */
	dynamic?: DynamicPack;
	/**
	 * A `.yml` and a runtime registration both claim this pack. luna-pack takes
	 * the file and ignores the plugin, so the operator is overriding a plugin
	 * without having said so — worth reporting wherever the row is shown.
	 */
	shadowsDynamic?: boolean;
	/** Whether the zip the definition points at exists */
	present: boolean;
	sizeBytes: number;
	source: PackSource;
	versionNumber?: string;
	autoUpdate: boolean;
	channel?: PackChannel;
	remote?: RemoteRef;
	/** Instance names the server rules currently match */
	matched: string[];
	/** Addon groups carrying this pack */
	groups: string[];
	/** Rules the groups contribute — the rest of `servers` is the operator's */
	granted: string[];
}

// the rule algebra is shared with the browser, which needs to predict a
// checkbox before it is saved — see shared/packrules.ts
export { hasWildcard, respackMatchesServer, toggleServerRule, toggleWildcard } from "../shared/packrules";

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

/**
 * Serve (or stop serving) one pack on one backend, by editing that pack's
 * server rules — the per-instance verb the instance screen offers, expressed in
 * the only vocabulary luna-pack has.
 *
 * A pack an addon group carries keeps gaining that group's backends, so turning
 * one off writes an exclusion that outranks the grant rather than fighting it;
 * `groupConflict` says so, and the caller is expected to mention it.
 */
export async function setResourcePackForInstance(
	cfg: ClusterConfig,
	lock: PacksLock,
	key: string,
	instance: string,
	on: boolean,
	groups?: Record<string, AddonGroup>,
): Promise<{ pack: RespackRow; groupConflict: boolean }> {
	const rows = await listResourcePacks(cfg, lock, groups);
	const row = rows.find((candidate) => candidate.key === key);

	if (!row) {
		throw new Error(`unknown resource pack: ${key}`);
	}

	if (!cfg.instances[instance]) {
		throw new Error(`unknown instance: ${instance}`);
	}

	// an unregistered zip has no rules at all; serving it somewhere is what
	// finally registers it, and a registration nobody enabled would serve
	// nothing — so the same click enables it, exactly as joining a group does
	const current = row.defFile ? row.servers : [];
	const pack = await updateResourcePack(
		cfg,
		lock,
		key,
		{
			servers: toggleServerRule(current, instance, on),
			enabled: !row.defFile && on ? true : undefined,
		},
		groups,
	);

	return { pack, groupConflict: !on && row.granted.includes(instance) };
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
 * One pack a plugin registered with luna-pack at runtime, as the running proxy
 * reports it. The numbers are the plugin's, not luna's: nothing on disk here
 * decides them, and they change when that plugin reloads.
 */
export interface DynamicPack {
	/** luna-pack's own key: the pack name, normalized */
	name: string;
	filename: string;
	priority: number;
	required: boolean;
	enabled: boolean;
	servers: string[];
	/** Whether the proxy could resolve the zip into something it can serve */
	available: boolean;
	unavailableReason?: string;
	/** The URL clients are handed, when it resolved */
	url?: string;
}

/** What the running proxy could tell us about runtime registrations. */
export interface DynamicPackReport {
	/** false when the proxy is stopped or its API did not answer */
	available: boolean;
	problem?: string;
	packs: DynamicPack[];
}

/**
 * Resource packs registered at runtime rather than by a `.yml`.
 *
 * The proxy's catalog is the only place these exist: luna-pack merges its
 * directory with whatever its dynamic providers hand it, and a plugin's
 * registration never touches disk. So the packs directory alone cannot tell a
 * plugin-provided pack from an abandoned zip — this is the difference.
 *
 * Which entries are dynamic is inferred rather than asked: a pack the proxy
 * resolved that no local `.yml` declares can only have come from a provider.
 * (luna-pack does record `[dynamic]/<provider>.yml` as such a definition's path,
 * but its HTTP catalog does not publish that field, so the registering plugin
 * cannot be named yet.)
 */
export async function dynamicResourcePacks(): Promise<DynamicPackReport> {
	const catalog = await lunaApi.packCatalog();

	if (!catalog.ok || !catalog.data) {
		return { available: false, problem: catalog.error ?? "the proxy did not answer", packs: [] };
	}

	const dir = respacksDir();
	const declared = new Set<string>();

	if (existsSync(dir)) {
		for (const file of await readdir(dir)) {
			if (!/\.ya?ml$/i.test(file)) {
				continue;
			}

			const def = await readDefinition(join(dir, file));

			if (def) {
				declared.add(def.name.trim().toLowerCase());
			}
		}
	}

	const packs = catalog.data.packs
		.filter((pack) => !declared.has(pack.normalizedName.toLowerCase()))
		.map((pack) => ({
			name: pack.normalizedName.toLowerCase(),
			filename: pack.filename,
			priority: pack.priority,
			required: pack.required,
			enabled: pack.enabled,
			servers: pack.servers,
			available: pack.available,
			unavailableReason: pack.unavailableReason || undefined,
			url: pack.url || undefined,
		}));

	return { available: true, packs };
}

/**
 * Every resource pack the cluster has: registered definitions merged with
 * their zips, plus stray zips nothing registers yet (listed so they can be
 * registered or cleaned up rather than silently ignored).
 *
 * Runtime registrations are *not* consulted here — this function reads the
 * cluster's own disk and nothing else, because deploys, group syncs and the
 * cleanup sweep all call it and none of them may depend on the proxy being up.
 * `listResourcePacksLive` is the listing that also asks the proxy.
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
			registration: "file",
			present,
			sizeBytes: size,
			source: entry?.source ?? "manual",
			versionNumber: entry?.installed?.versionNumber,
			autoUpdate: entry?.autoUpdate ?? false,
			channel: entry?.channel,
			remote: entry?.remote,
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

		// nothing on disk registers it. Whether a plugin does at runtime is a
		// question only the proxy can answer, so the disk-only listing says
		// "unknown" and `listResourcePacksLive` settles it
		rows.push({
			key: packKeyFrom(zip),
			registration: "unknown",
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

/**
 * The listing every operator-facing surface uses: the packs directory merged
 * with what the running proxy says is registered at runtime.
 *
 * Three things come out of the merge:
 * - a zip whose registration is a plugin's is `dynamic`, and carries that
 *   plugin's priority/rules/enablement instead of the zeroes disk implies
 * - a `.yml` that shadows a runtime registration of the same name is flagged,
 *   because luna-pack silently prefers the file and the plugin's own settings
 *   stop applying
 * - a runtime pack whose zip is not in the directory is still listed: the
 *   registering plugin may build it on its next reload, and a row that vanishes
 *   is worse than a row that says the file is missing
 *
 * A proxy that is not answering leaves the strays as `unknown` rather than
 * calling them unregistered — an unavailable fact is not a negative one.
 */
export async function listResourcePacksLive(
	cfg: ClusterConfig,
	lock: PacksLock,
	groups?: Record<string, AddonGroup>,
): Promise<{ rows: RespackRow[]; dynamic: DynamicPackReport }> {
	const rows = await listResourcePacks(cfg, lock, groups);
	const dynamic = await dynamicResourcePacks();

	if (!dynamic.available) {
		return { rows, dynamic };
	}

	const backends = Object.keys(cfg.instances);
	const byZip = new Map(dynamic.packs.map((pack) => [pack.filename.toLowerCase(), pack]));

	for (const row of rows) {
		const runtime = byZip.get(row.filename.toLowerCase());

		// A definition luna wrote over a plugin's registration hides that
		// registration from the catalog — luna-pack answers with the definition it
		// prefers and never says one was displaced. So the takeover is read back
		// from where it was recorded, not from the proxy.
		if (row.defFile && lock.resourcepacks[row.key]?.takenOverFrom === "plugin") {
			row.shadowsDynamic = true;
		}

		if (!runtime) {
			// a stray zip the live proxy does not know is genuinely unregistered
			if (row.registration === "unknown") {
				row.registration = "none";
			}

			continue;
		}

		byZip.delete(row.filename.toLowerCase());

		if (row.defFile) {
			// a yml and a *visible* runtime registration for the same zip: the file
			// wins in luna-pack, so say that it is doing so
			row.dynamic = runtime;
			row.shadowsDynamic = true;

			continue;
		}

		// the plugin's registration is this pack's whole configuration
		row.registration = "dynamic";
		row.dynamic = runtime;
		row.name = runtime.name;
		row.priority = runtime.priority;
		row.required = runtime.required;
		row.enabled = runtime.enabled;
		row.servers = runtime.servers;
		row.matched = backends.filter((name) => respackMatchesServer(runtime.servers, name));
	}

	// registered at runtime, with no zip on disk yet
	for (const runtime of byZip.values()) {
		rows.push({
			key: packKeyFrom(runtime.filename),
			name: runtime.name,
			filename: runtime.filename,
			priority: runtime.priority,
			required: runtime.required,
			enabled: runtime.enabled,
			servers: runtime.servers,
			registration: "dynamic",
			dynamic: runtime,
			present: false,
			sizeBytes: 0,
			source: "manual",
			autoUpdate: false,
			matched: backends.filter((name) => respackMatchesServer(runtime.servers, name)),
			groups: [],
			granted: [],
		});
	}

	return { rows: rows.sort((a, b) => a.key.localeCompare(b.key)), dynamic };
}

/**
 * Take a dynamically registered pack over: write the `.yml` that luna-pack
 * prefers, seeded with exactly what the plugin currently registers, so nothing
 * changes for players at the moment of the takeover.
 *
 * This is a real transfer of ownership and not a formality — from here on the
 * registering plugin's priority, rules and enablement are ignored, while it
 * keeps rebuilding the zip. That is the only way to give a plugin's pack an
 * operator-chosen priority or server rule, and the reason it is a deliberate
 * verb instead of a side effect of editing.
 */
export async function takeOverDynamicPack(
	cfg: ClusterConfig,
	lock: PacksLock,
	key: string,
): Promise<{ row: RespackRow; from: DynamicPack }> {
	const { rows, dynamic } = await listResourcePacksLive(cfg, lock);

	if (!dynamic.available) {
		throw new Error(
			`the proxy is not answering, so ${key}'s runtime registration cannot be read: ${dynamic.problem}`,
		);
	}

	const row = rows.find((candidate) => candidate.key === key);

	if (!row?.dynamic) {
		throw new Error(`${key} is not registered by a plugin at runtime`);
	}

	if (row.defFile) {
		throw new Error(`${key} already has a definition of its own (${row.defFile})`);
	}

	const from = row.dynamic;

	await saveDefinition(key, {
		name: from.name,
		filename: from.filename,
		priority: from.priority,
		required: from.required,
		enabled: from.enabled,
		servers: from.servers,
	});

	// the pack becomes luna's, so it gets the lock entry every luna-owned pack
	// has — and the flag that makes the takeover reversible
	const entry = lock.resourcepacks[key];

	lock.resourcepacks[key] = {
		...entry,
		file: from.filename,
		source: entry?.source ?? "manual",
		autoUpdate: entry?.autoUpdate ?? false,
		takenOverFrom: "plugin",
	};

	const fresh = await listResourcePacksLive(cfg, lock);

	return { row: fresh.rows.find((candidate) => candidate.key === key)!, from };
}

/**
 * Hand a taken-over pack back to the plugin that registers it: delete the `.yml`
 * that was shadowing the runtime registration. The zip stays — it is the
 * plugin's, and it will be re-registered on the next reload.
 */
export async function releaseDynamicPack(
	cfg: ClusterConfig,
	lock: PacksLock,
	key: string,
): Promise<{ removed: string; dynamic?: DynamicPack }> {
	const { rows } = await listResourcePacksLive(cfg, lock);
	const row = rows.find((candidate) => candidate.key === key);

	if (!row) {
		throw new Error(`unknown resource pack: ${key}`);
	}

	if (!row.defFile) {
		throw new Error(`${key} has no definition of its own to release`);
	}

	if (!row.shadowsDynamic) {
		throw new Error(
			`${key} is not shadowing a runtime registration — deleting its definition would unregister it`,
		);
	}

	await rm(join(respacksDir(), row.defFile));

	const entry = lock.resourcepacks[key];

	if (entry) {
		delete entry.takenOverFrom;

		// nothing else in the entry was ever luna's: an unmapped pack that only
		// existed to hold the takeover flag is noise once the flag is gone
		if (entry.source === "manual" && !entry.remote && !entry.installed && !entry.servers) {
			delete lock.resourcepacks[key];
		}
	}

	return { removed: row.defFile, dynamic: row.dynamic };
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

	// the merge only has something to say when the pack is on the group scheme
	// (a grant now, or a manual list the lock remembers from one); otherwise the
	// yml alone owns the rules, and an edit that names none leaves them be
	const merged = granted.length > 0 || lock.resourcepacks[key]?.servers !== undefined || patch.servers;

	const def: RespackDefinition = {
		name: patch.name ?? row.name,
		filename: row.filename,
		priority: patch.priority ?? row.priority,
		required: patch.required ?? row.required,
		enabled: patch.enabled ?? row.enabled,
		servers: merged ? mergedServers(manual, granted) : current,
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

			if (!record.remote && !record.installed && record.source === "manual") {
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

	// an upload over a provider-installed pack makes it manual: the file on
	// disk no longer is what the lock's installed version says it is
	lock.resourcepacks[key] = {
		file,
		source: "manual",
		autoUpdate: false,
		installed: { sha512: await sha512File(join(respacksDir(), file)) },
	};

	const fresh = await listResourcePacks(cfg, lock);

	return fresh.find((candidate) => candidate.key === key)!;
}

/** Pick the newest acceptable version of a pack project on a channel. */
function pickPackVersion(
	versions: AddonVersion[],
	channel: PackChannel,
	afterDate?: string,
): AddonVersion | undefined {
	const { best } = pickCompatible(versions, [], { channel, afterDate });

	return best;
}

/**
 * Install a resource pack from a provider: newest release (falling back
 * through beta and alpha for projects that never publish releases),
 * downloaded into the packs directory with a definition registering it
 * everywhere, disabled — going live is a deliberate enable + reload.
 */
export async function installResourcePackFromProvider(
	cfg: ClusterConfig,
	lock: PacksLock,
	provider: ProviderId,
	project: AddonProject,
	opts: { channel?: PackChannel } = {},
): Promise<RespackRow> {
	const key = packKeyFrom(project.slug);
	const remote = remoteRefFor(provider, project);
	const versions = await getVersions(remote, "resourcepack");

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

	const file = primaryFile(version);
	const zipName = `${key}.zip`;

	const sha512 = await download(file.url, join(respacksDir(), zipName), file.hashes);

	const entry: PackEntry = {
		file: zipName,
		source: provider,
		remote,
		installed: {
			versionId: version.id,
			versionNumber: version.version_number,
			sha512,
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
	/** Hashes the provider published, verified on download */
	hashes: AddonVersionFile["hashes"];
	url: string;
}

/**
 * Check the packs' providers for updates: channel-gated and downgrade-guarded
 * by publish date, exactly like plugin updates. Explicitly named packs are
 * checked even with auto-update off.
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

		if (entry.source === "manual" || !entry.remote) {
			skipped.push({ key, reason: "not identified with a provider" });

			continue;
		}

		if (!entry.autoUpdate && !names?.includes(key)) {
			skipped.push({ key, reason: "auto-update disabled" });

			continue;
		}

		const versions = await getVersions(entry.remote, "resourcepack");
		const best = pickPackVersion(
			versions,
			entry.channel ?? "release",
			entry.installed?.publishedAt,
		);

		if (!best || best.id === entry.installed?.versionId) {
			continue;
		}

		const file = primaryFile(best);

		// a re-publish under the same bytes is no update (when the hash is known)
		if (file.hashes.sha512 !== undefined && file.hashes.sha512 === entry.installed?.sha512) {
			continue;
		}

		updates.push({
			key,
			from: entry.installed?.versionNumber,
			to: best.version_number,
			versionId: best.id,
			publishedAt: best.date_published,
			hashes: file.hashes,
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

	const sha512 = await download(update.url, join(respacksDir(), entry.file), update.hashes ?? {});

	entry.installed = {
		versionId: update.versionId,
		versionNumber: update.to,
		sha512,
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

// -- provider mapping ----------------------------------------------------------

/** What the operator is asking luna to record about a pack's origin. */
export interface IdentifyPackOptions {
	provider: ProviderId;
	/** Project slug or id at that provider */
	project: string;
	/** Version to record; omitted takes the probe's own best match */
	versionId?: string;
	/** Map the project but record no version at all */
	unidentified?: boolean;
	/** Overrides the auto-update default (on only for a proven version) */
	autoUpdate?: boolean;
}

/** A probe carrying the pack it was run for. */
export interface RespackIdentityProbe extends IdentityProbe {
	key: string;
	/** The zip the probe hashed */
	zip: string;
}

/**
 * The zip a mapping has to identify. Taken from the row rather than the lock,
 * because the packs worth mapping are exactly the ones with no lock entry yet —
 * a hand-uploaded zip is known only by the definition that points at it.
 */
async function packZipOf(cfg: ClusterConfig, lock: PacksLock, key: string): Promise<RespackRow> {
	const rows = await listResourcePacks(cfg, lock);
	const row = rows.find((candidate) => candidate.key === key);

	if (!row) {
		throw new Error(`unknown resource pack: ${key}`);
	}

	if (!row.present) {
		throw new Error(`${key}: ${row.filename} is missing, so it cannot be identified`);
	}

	return row;
}

/**
 * Grade what a pack's zip could be at one provider, writing nothing. Resource
 * packs carry no loader facet, so the whole published version list is fair game.
 */
export async function probeRespackIdentity(
	cfg: ClusterConfig,
	lock: PacksLock,
	key: string,
	provider: ProviderId,
	project: string,
): Promise<RespackIdentityProbe> {
	const row = await packZipOf(cfg, lock, key);
	const local = await localFile(join(respacksDir(), row.filename), row.filename);
	const probe = await probeIdentity(provider, project, "resourcepack", local);

	return { ...probe, key, zip: row.filename };
}

/**
 * Map a resource pack luna already serves to the project it came from. The zip
 * and its definition are untouched — priority, rules and enablement are the
 * operator's, not the provider's; what changes is that updates can now be found.
 */
export async function identifyResourcePack(
	cfg: ClusterConfig,
	lock: PacksLock,
	key: string,
	opts: IdentifyPackOptions,
): Promise<{ row: RespackRow; probe: RespackIdentityProbe; match?: IdentityMatch }> {
	const probe = await probeRespackIdentity(cfg, lock, key, opts.provider, opts.project);
	const match = chosenMatch(probe, opts);
	const existing = lock.resourcepacks[key];

	const entry: PackEntry = {
		...existing,
		file: probe.zip,
		source: opts.provider,
		remote: probe.remote,
		installed: installedFrom(probe.local, match),
		autoUpdate: opts.autoUpdate ?? autoUpdateDefault(match),
	};

	if (match && match.channel !== "release") {
		entry.channel = match.channel;
	} else {
		delete entry.channel;
	}

	lock.resourcepacks[key] = entry;

	const rows = await listResourcePacks(cfg, lock);

	return { row: rows.find((candidate) => candidate.key === key)!, probe, match };
}

/**
 * Drop a pack's provider mapping. Its definition, rules and group membership are
 * untouched: only the claim that an upstream project governs its contents goes.
 */
export async function forgetRespackIdentity(
	cfg: ClusterConfig,
	lock: PacksLock,
	key: string,
): Promise<RespackRow> {
	const entry = lock.resourcepacks[key];

	if (!entry) {
		throw new Error(`${key} has no provider mapping`);
	}

	entry.source = "manual";
	entry.autoUpdate = false;
	entry.installed = { sha512: entry.installed?.sha512 ?? "" };

	if (!entry.installed.sha512) {
		const row = await packZipOf(cfg, lock, key);

		entry.installed = { sha512: await sha512File(join(respacksDir(), row.filename)) };
	}

	delete entry.remote;
	delete entry.channel;

	const rows = await listResourcePacks(cfg, lock);

	return rows.find((candidate) => candidate.key === key)!;
}
