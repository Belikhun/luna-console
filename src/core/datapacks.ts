/**
 * Data pack management: a shared pool of zips in `<root>/datapacks` deployed
 * into each target instance's world (`<instance>/<level-name>/datapacks/`),
 * with Modrinth as the install/update source and `packs.lock.json` as the
 * source of truth for what deploys where — the world directories are derived,
 * same as plugin folders. Unlike plugins there are no per-instance variants:
 * a data pack has one pooled build, and installs are gated on every target's
 * MC version up front.
 *
 * A server only reads its world's datapacks folder at boot (or `/reload`), so
 * deploy reports whether each copy changed anything — the caller decides
 * whether a restart is worth it.
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { readProperties } from "./confedit";
import { expandTargets, instanceDir, managedInstances, root } from "./config";
import { groupsWith, memberInstances } from "./families";
import {
	decodePackZip,
	packKeyFrom,
	type DataPackEntry,
	type PackChannel,
	type PacksLock,
} from "./packslock";
import type { ProgressReporter } from "./progress";
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
import type { AddonGroup, ClusterConfig, InstanceConfig, ProviderId } from "./types";

/** The addon groups a pack operation resolves membership against. */
export type AddonGroups = Record<string, AddonGroup> | undefined;

/** Directory of the shared data pack pool. */
export function datapacksDir(): string {
	return join(root(), "datapacks");
}

/**
 * The world directory data packs load from, resolved through the instance's
 * own `level-name` — a renamed world (survival, lobby) moves the folder with it.
 */
export async function worldDatapacksDir(inst: InstanceConfig): Promise<string> {
	const dir = instanceDir(inst);
	let level = "world";

	try {
		const props = await readProperties(join(dir, "server.properties"));

		level = props["level-name"]?.trim() || "world";
	} catch {
		// a fresh instance has no properties yet — vanilla defaults to "world"
	}

	return join(dir, level, "datapacks");
}

/** Instances that have a world to load data packs from (everything but the proxy). */
function worldInstances(cfg: ClusterConfig): Record<string, InstanceConfig> {
	const entries = Object.entries(managedInstances(cfg)).filter(
		([, inst]) => inst.software !== "velocity",
	);

	return Object.fromEntries(entries);
}

/**
 * Every instance a data pack deploys to: its own targets, expanded, united
 * with the instances its addon groups grant it. The proxy and unknown names
 * drop out — only a server with a world can load a data pack.
 */
export function datapackTargets(
	cfg: ClusterConfig,
	name: string,
	entry: DataPackEntry,
	groups?: AddonGroups,
): string[] {
	const worlds = worldInstances(cfg);
	let expanded: string[];

	try {
		expanded = expandTargets(cfg, entry.targets);
	} catch {
		// a target may name a since-deleted instance; the rest must still deploy
		expanded = entry.targets.filter((target) => worlds[target]);
	}

	const all = new Set([...expanded, ...memberInstances(cfg, groups, "datapacks", name)]);

	return [...all].filter((instance) => worlds[instance]).sort();
}

/** One pooled data pack as the console and CLI list it. */
export interface DataPackRow {
	name: string;
	entry: DataPackEntry;
	/** Whether the pool zip exists */
	present: boolean;
	sizeBytes: number;
	/** Concrete instances the targets expand to, group grants included */
	effectiveTargets: string[];
	/** Addon groups carrying this pack */
	groups: string[];
	/** Instances the groups contribute — the rest come from `entry.targets` */
	granted: string[];
}

/** Every pooled data pack, with pool file status and expanded targets. */
export async function listDataPacks(
	cfg: ClusterConfig,
	lock: PacksLock,
	groups?: AddonGroups,
): Promise<DataPackRow[]> {
	const rows: DataPackRow[] = [];

	for (const [name, entry] of Object.entries(lock.datapacks)) {
		const path = join(datapacksDir(), entry.file);
		const present = existsSync(path);

		rows.push({
			name,
			entry,
			present,
			sizeBytes: present ? (await stat(path)).size : 0,
			effectiveTargets: datapackTargets(cfg, name, entry, groups),
			groups: groupsWith(groups, "datapacks", name),
			granted: memberInstances(cfg, groups, "datapacks", name).filter(
				(instance) => worldInstances(cfg)[instance],
			),
		});
	}

	return rows;
}

/** One data pack as seen from inside one instance's world. */
export interface InstanceDataPackRow {
	/** Zip file name in the world's datapacks folder (or the pool's, when missing) */
	file: string;
	/** Lock key when the file belongs to a managed pack */
	name?: string;
	managed: boolean;
	/** Whether the lock targets this instance with it */
	targeted: boolean;
	/** Whether the file exists in the world */
	present: boolean;
	sizeBytes: number;
	versionNumber?: string;
	source?: string;
	autoUpdate?: boolean;
	/** The world's copy differs from the pool — a deploy is pending */
	stale: boolean;
}

/**
 * What one instance's world actually holds: managed packs (present, missing or
 * stale against the pool) and unmanaged zips someone dropped in by hand, listed
 * so they can be adopted into the pool rather than silently ignored.
 * Runs on the instance's owner — the world is on that machine's disk.
 */
export async function instanceDataPackReport(
	cfg: ClusterConfig,
	lock: PacksLock,
	instance: string,
	groups?: AddonGroups,
): Promise<{ world: string; rows: InstanceDataPackRow[] }> {
	const inst = worldInstances(cfg)[instance];

	if (!inst) {
		throw new Error(`${instance} has no world to hold data packs`);
	}

	const dir = await worldDatapacksDir(inst);
	const rows: InstanceDataPackRow[] = [];

	let files: string[] = [];

	if (existsSync(dir)) {
		files = (await readdir(dir)).filter((file) => file.toLowerCase().endsWith(".zip"));
	}

	const byFile = new Map(Object.entries(lock.datapacks).map(([name, entry]) => [entry.file, name]));
	const seen = new Set<string>();

	for (const file of files.sort()) {
		const name = byFile.get(file);
		const entry = name ? lock.datapacks[name] : undefined;
		const size = (await stat(join(dir, file))).size;

		let stale = false;

		if (entry) {
			const poolPath = join(datapacksDir(), entry.file);

			if (existsSync(poolPath)) {
				stale = (await sha512File(join(dir, file))) !== (await sha512File(poolPath));
			}

			seen.add(entry.file);
		}

		rows.push({
			file,
			name,
			managed: !!entry,
			targeted: entry && name ? datapackTargets(cfg, name, entry, groups).includes(instance) : false,
			present: true,
			sizeBytes: size,
			versionNumber: entry?.installed?.versionNumber,
			source: entry?.source,
			autoUpdate: entry?.autoUpdate,
			stale,
		});
	}

	// targeted here but not in the world yet — a deploy away
	for (const [name, entry] of Object.entries(lock.datapacks)) {
		if (seen.has(entry.file) || !datapackTargets(cfg, name, entry, groups).includes(instance)) {
			continue;
		}

		rows.push({
			file: entry.file,
			name,
			managed: true,
			targeted: true,
			present: false,
			sizeBytes: 0,
			versionNumber: entry.installed?.versionNumber,
			source: entry.source,
			autoUpdate: entry.autoUpdate,
			stale: false,
		});
	}

	return { world: dir.slice(instanceDir(inst).length + 1), rows };
}

/** What one deploy step did to one instance. */
export interface DataPackDeployAction {
	instance: string;
	file: string;
	action: "installed" | "updated" | "removed" | "unchanged" | "error";
	detail?: string;
}

/**
 * Sync target instances' worlds from the pool: copy missing packs, replace
 * stale ones, and remove a managed pack's file where the lock no longer
 * targets it (only files the lock knows are ever touched — hand-dropped zips
 * stay). Servers pick changes up on their next restart or `/reload`.
 */
export async function deployDataPacks(
	cfg: ClusterConfig,
	lock: PacksLock,
	opts: {
		instances?: string[];
		pack?: string;
		/** Addon groups, so a pack a group grants deploys without its own target */
		groups?: AddonGroups;
		reporter?: ProgressReporter;
	} = {},
): Promise<DataPackDeployAction[]> {
	const worlds = worldInstances(cfg);
	const wanted = opts.instances
		? expandTargets(cfg, opts.instances).filter((name) => worlds[name])
		: Object.keys(worlds);

	const packs = Object.entries(lock.datapacks).filter(
		([name]) => !opts.pack || name === opts.pack,
	);

	const actions: DataPackDeployAction[] = [];
	const progress = opts.reporter;

	progress?.expect(wanted.length);

	for (const instance of wanted) {
		const inst = worlds[instance]!;
		const node = progress?.child(instance, 1);
		const dir = await worldDatapacksDir(inst);

		try {
			await mkdir(dir, { recursive: true });

			for (const [packName, entry] of packs) {
				const poolPath = join(datapacksDir(), entry.file);
				const destPath = join(dir, entry.file);
				const targeted = datapackTargets(cfg, packName, entry, opts.groups).includes(instance);
				const there = existsSync(destPath);

				if (!targeted) {
					if (there) {
						await rm(destPath);
						actions.push({ instance, file: entry.file, action: "removed" });
					}

					continue;
				}

				if (!existsSync(poolPath)) {
					actions.push({
						instance,
						file: entry.file,
						action: "error",
						detail: "pool file missing — reinstall or re-upload the pack",
					});

					continue;
				}

				if (there && (await sha512File(destPath)) === (await sha512File(poolPath))) {
					actions.push({ instance, file: entry.file, action: "unchanged" });

					continue;
				}

				node?.info(0.5, `copying ${entry.file}`);
				await copyFile(poolPath, destPath);
				actions.push({ instance, file: entry.file, action: there ? "updated" : "installed" });
			}

			node?.complete();
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);

			node?.error(1, detail);
			actions.push({ instance, file: "*", action: "error", detail });
		}
	}

	return actions;
}

/** MC versions the targets require, for gating installs and updates. */
function requiredMcVersions(cfg: ClusterConfig, targets: string[]): string[] {
	const worlds = worldInstances(cfg);
	const versions = new Set<string>();

	for (const name of targets) {
		const mc = worlds[name]?.mcVersion;

		if (mc) {
			versions.add(mc);
		}
	}

	return [...versions];
}

/**
 * Install a data pack from a provider: the newest version covering every
 * target's MC version (channel-gated, falling back through beta/alpha for
 * projects without releases), pooled and recorded. Deploying is the caller's
 * follow-up — routing to follower-owned targets happens at the daemon layer.
 */
export async function installDataPackFromProvider(
	cfg: ClusterConfig,
	lock: PacksLock,
	provider: ProviderId,
	project: AddonProject,
	targets: string[],
	opts: { channel?: PackChannel } = {},
): Promise<{ name: string; entry: DataPackEntry }> {
	const name = packKeyFrom(project.slug);
	const expanded = expandTargets(cfg, targets);
	const required = requiredMcVersions(cfg, expanded);
	const remote = remoteRefFor(provider, project);
	const versions = await getVersions(remote, "datapack");

	let channel: PackChannel = opts.channel ?? "release";
	let picked = pickCompatible(versions, required, { channel });

	for (const fallback of ["beta", "alpha"] as const) {
		if (picked.best || opts.channel) {
			break;
		}

		channel = fallback;
		picked = pickCompatible(versions, required, { channel });
	}

	if (!picked.best) {
		const newest = picked.newest
			? ` (newest ${picked.newest.version_number} supports ${picked.newest.game_versions.join(", ")})`
			: "";

		throw new Error(
			`no version of ${project.slug} covers MC ${required.join(", ") || "any"}${newest}`,
		);
	}

	const file = primaryFile(picked.best);
	const zipName = `${name}.zip`;

	await mkdir(datapacksDir(), { recursive: true });

	const sha512 = await download(file.url, join(datapacksDir(), zipName), file.hashes);

	const entry: DataPackEntry = {
		file: zipName,
		source: provider,
		remote,
		installed: {
			versionId: picked.best.id,
			versionNumber: picked.best.version_number,
			sha512,
			gameVersions: picked.best.game_versions,
			publishedAt: picked.best.date_published,
		},
		autoUpdate: true,
		targets,
	};

	if (channel !== "release") {
		entry.channel = channel;
	}

	lock.datapacks[name] = entry;

	return { name, entry };
}

/** One available data pack update. */
export interface DataPackUpdate {
	name: string;
	from?: string;
	to: string;
	versionId: string;
	publishedAt: string;
	/** Hashes the provider published, verified on download */
	hashes: AddonVersionFile["hashes"];
	url: string;
	gameVersions: string[];
}

/**
 * Check the packs' providers for data pack updates: channel-gated,
 * downgrade-guarded by publish date, and never onto a version that drops a
 * target's MC version.
 */
export async function checkDataPackUpdates(
	cfg: ClusterConfig,
	lock: PacksLock,
	names?: string[],
	groups?: AddonGroups,
): Promise<{ updates: DataPackUpdate[]; skipped: Array<{ name: string; reason: string }> }> {
	const updates: DataPackUpdate[] = [];
	const skipped: Array<{ name: string; reason: string }> = [];

	for (const [name, entry] of Object.entries(lock.datapacks)) {
		if (names && !names.includes(name)) {
			continue;
		}

		if (entry.source === "manual" || !entry.remote) {
			skipped.push({ name, reason: "not identified with a provider" });

			continue;
		}

		if (!entry.autoUpdate && !names?.includes(name)) {
			skipped.push({ name, reason: "auto-update disabled" });

			continue;
		}

		const required = requiredMcVersions(cfg, datapackTargets(cfg, name, entry, groups));
		const versions = await getVersions(entry.remote, "datapack");
		const picked = pickCompatible(versions, required, {
			channel: entry.channel ?? "release",
			afterDate: entry.installed?.publishedAt,
		});

		if (!picked.best || picked.best.id === entry.installed?.versionId) {
			continue;
		}

		const file = primaryFile(picked.best);

		// a re-publish under the same bytes is no update (when the hash is known)
		if (file.hashes.sha512 !== undefined && file.hashes.sha512 === entry.installed?.sha512) {
			continue;
		}

		updates.push({
			name,
			from: entry.installed?.versionNumber,
			to: picked.best.version_number,
			versionId: picked.best.id,
			publishedAt: picked.best.date_published,
			hashes: file.hashes,
			url: file.url,
			gameVersions: picked.best.game_versions,
		});
	}

	return { updates, skipped };
}

/** Download one checked update over the pool zip and record the new version. */
export async function applyDataPackUpdate(lock: PacksLock, update: DataPackUpdate): Promise<void> {
	const entry = lock.datapacks[update.name];

	if (!entry) {
		throw new Error(`unknown data pack: ${update.name}`);
	}

	const sha512 = await download(update.url, join(datapacksDir(), entry.file), update.hashes ?? {});

	entry.installed = {
		versionId: update.versionId,
		versionNumber: update.to,
		sha512,
		gameVersions: update.gameVersions,
		publishedAt: update.publishedAt,
	};
}

/** Add or replace a pool zip uploaded from the console, with manual provenance. */
export async function addDataPackFile(
	cfg: ClusterConfig,
	lock: PacksLock,
	name: string,
	dataBase64: string,
	targets?: string[],
): Promise<{ name: string; entry: DataPackEntry }> {
	const key = packKeyFrom(name);
	const buf = decodePackZip(dataBase64);
	const file = `${key}.zip`;

	if (targets?.length) {
		// reject a typo before anything is written
		expandTargets(cfg, targets);
	}

	await mkdir(datapacksDir(), { recursive: true });
	await Bun.write(join(datapacksDir(), file), buf);

	const existing = lock.datapacks[key];

	const entry: DataPackEntry = {
		file,
		source: "manual",
		autoUpdate: false,
		targets: targets ?? existing?.targets ?? [],
		installed: { sha512: await sha512File(join(datapacksDir(), file)) },
	};

	lock.datapacks[key] = entry;

	return { name: key, entry };
}

/** Adopt a hand-dropped zip from an instance's world into the pool. */
export async function adoptDataPack(
	cfg: ClusterConfig,
	lock: PacksLock,
	instance: string,
	fileName: string,
): Promise<{ name: string; entry: DataPackEntry }> {
	const inst = worldInstances(cfg)[instance];

	if (!inst) {
		throw new Error(`${instance} has no world to hold data packs`);
	}

	const src = join(await worldDatapacksDir(inst), fileName);

	if (!existsSync(src)) {
		throw new Error(`${fileName} not found in ${instance}'s world`);
	}

	const name = packKeyFrom(fileName);
	const file = `${name}.zip`;

	await mkdir(datapacksDir(), { recursive: true });
	await copyFile(src, join(datapacksDir(), file));

	const entry: DataPackEntry = {
		file,
		source: "manual",
		autoUpdate: false,
		targets: [instance],
		installed: { sha512: await sha512File(src) },
	};

	lock.datapacks[name] = entry;

	// the world's copy keeps its original file name; align it with the pool so
	// future deploys recognize it (only when the adoption renamed it)
	if (fileName !== file) {
		await copyFile(src, join(await worldDatapacksDir(inst), file));
		await rm(src);
	}

	return { name, entry };
}

/**
 * Delete one pack's file from the given instances' worlds on this machine.
 * Pure file removal — no lock mutation — so a routed removal can run this
 * slice on each owner and finalize the entry once, on the caller's side.
 */
export async function removeDataPackFiles(
	cfg: ClusterConfig,
	lock: PacksLock,
	name: string,
	targets: string[],
): Promise<string[]> {
	const entry = lock.datapacks[name];

	if (!entry) {
		throw new Error(`unknown data pack: ${name}`);
	}

	const worlds = worldInstances(cfg);
	const deletedFrom: string[] = [];

	for (const target of targets) {
		const inst = worlds[target];

		if (!inst) {
			continue;
		}

		const dest = join(await worldDatapacksDir(inst), entry.file);

		if (existsSync(dest)) {
			await rm(dest);
			deletedFrom.push(target);
		}
	}

	return deletedFrom;
}

/**
 * Settle a pack's lock entry after its files were removed from `removed`
 * targets: trim the target list, or — when nothing is left, or the removal
 * was unscoped — drop the pool zip and the entry itself.
 */
export async function finalizeDataPackRemoval(
	cfg: ClusterConfig,
	lock: PacksLock,
	name: string,
	removed: string[],
	scoped: boolean,
	groups?: AddonGroups,
): Promise<{ entryRemoved: boolean }> {
	const entry = lock.datapacks[name];

	if (!entry) {
		throw new Error(`unknown data pack: ${name}`);
	}

	const remaining = datapackTargets(cfg, name, entry, groups).filter(
		(target) => !removed.includes(target),
	);

	if (!scoped || remaining.length === 0) {
		const poolPath = join(datapacksDir(), entry.file);

		if (existsSync(poolPath)) {
			await rm(poolPath);
		}

		delete lock.datapacks[name];

		return { entryRemoved: true };
	}

	entry.targets = remaining;

	return { entryRemoved: false };
}

/**
 * Remove a data pack from targets (and their worlds); with no targets left the
 * pool zip and lock entry go too. This reaches worlds on this machine only —
 * the daemon layer wraps it to route follower-owned targets to their owner.
 */
export async function removeDataPack(
	cfg: ClusterConfig,
	lock: PacksLock,
	name: string,
	fromTargets?: string[],
	groups?: AddonGroups,
): Promise<{ deletedFrom: string[]; entryRemoved: boolean }> {
	const entry = lock.datapacks[name];

	if (!entry) {
		throw new Error(`unknown data pack: ${name}`);
	}

	const worlds = worldInstances(cfg);
	const current = datapackTargets(cfg, name, entry, groups);
	const remove = fromTargets
		? expandTargets(cfg, fromTargets).filter((target) => worlds[target])
		: current;

	const deletedFrom = await removeDataPackFiles(cfg, lock, name, remove);
	const { entryRemoved } = await finalizeDataPackRemoval(
		cfg,
		lock,
		name,
		remove,
		!!fromTargets,
		groups,
	);

	return { deletedFrom, entryRemoved };
}

// -- provider mapping ----------------------------------------------------------

/** What the operator is asking luna to record about a data pack's origin. */
export interface IdentifyDataPackOptions {
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
export interface DataPackIdentityProbe extends IdentityProbe {
	name: string;
	/** The pooled zip the probe hashed */
	zip: string;
}

/** The pooled zip a mapping identifies — never a world's own copy of it. */
function dataPackZipOf(lock: PacksLock, name: string): DataPackEntry {
	const entry = lock.datapacks[name];

	if (!entry) {
		throw new Error(`unknown data pack: ${name}`);
	}

	if (!existsSync(join(datapacksDir(), entry.file))) {
		throw new Error(`${name}: ${entry.file} is not in the pool, so it cannot be identified`);
	}

	return entry;
}

/** Grade what a data pack's pooled zip could be at one provider, writing nothing. */
export async function probeDataPackIdentity(
	lock: PacksLock,
	name: string,
	provider: ProviderId,
	project: string,
): Promise<DataPackIdentityProbe> {
	const entry = dataPackZipOf(lock, name);
	const local = await localFile(join(datapacksDir(), entry.file), entry.file);
	const probe = await probeIdentity(provider, project, "datapack", local);

	return { ...probe, name, zip: entry.file };
}

/**
 * Map a pooled data pack to the project it came from. Its targets and the copies
 * already deployed into worlds are untouched; the pack simply becomes one whose
 * updates luna can find.
 */
export async function identifyDataPack(
	cfg: ClusterConfig,
	lock: PacksLock,
	name: string,
	opts: IdentifyDataPackOptions,
): Promise<{ name: string; entry: DataPackEntry; probe: DataPackIdentityProbe; match?: IdentityMatch }> {
	const probe = await probeDataPackIdentity(lock, name, opts.provider, opts.project);
	const match = chosenMatch(probe, opts);
	const entry = lock.datapacks[name]!;

	entry.source = opts.provider;
	entry.remote = probe.remote;
	entry.installed = installedFrom(probe.local, match);
	entry.autoUpdate = opts.autoUpdate ?? autoUpdateDefault(match);

	if (match && match.channel !== "release") {
		entry.channel = match.channel;
	} else {
		delete entry.channel;
	}

	return { name, entry, probe, match };
}

/** Drop a data pack's provider mapping, leaving its file and targets alone. */
export async function forgetDataPackIdentity(
	lock: PacksLock,
	name: string,
): Promise<DataPackEntry> {
	const entry = dataPackZipOf(lock, name);

	entry.source = "manual";
	entry.autoUpdate = false;
	entry.installed = {
		sha512: entry.installed?.sha512 ?? (await sha512File(join(datapacksDir(), entry.file))),
	};

	delete entry.remote;
	delete entry.channel;

	return entry;
}
