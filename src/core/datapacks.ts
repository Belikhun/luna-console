// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Data pack management: a shared pool of zips in `<root>/datapacks` deployed
 * into each target instance's world (`<instance>/<level-name>/datapacks/`),
 * with Modrinth as the install/update source and `packs.lock.json` as the
 * source of truth for what deploys where; the world directories are derived,
 * same as plugin folders. Unlike plugins there are no per-instance variants:
 * a data pack has one pooled build, and installs are gated on every target's
 * MC version up front.
 *
 * A server only reads its world's datapacks folder at boot (or `/reload`), so
 * deploy reports whether each copy changed anything; the caller decides
 * whether a restart is worth it.
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { packContents } from "./archive";
import { getConfValue } from "./confedit";
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
import { getStatus } from "./instances";
import { readBootSession } from "./pluginstate";
import type { BootSession, PluginRuntimeState, ReportLifecycle } from "./pluginstate";
import { traitsOf } from "./software";
import type { AddonGroup, ClusterConfig, InstanceConfig, ProviderId } from "./types";
import { worldDir } from "./world";
import { t } from "../shared/i18n";

/** The addon groups a pack operation resolves membership against. */
export type AddonGroups = Record<string, AddonGroup> | undefined;

/** Directory of the shared data pack pool. */
export function datapacksDir(): string {
	return join(root(), "datapacks");
}

/**
 * The world directory data packs load from, resolved through the instance's own
 * level name; a renamed world (survival, lobby) moves the folder with it.
 *
 * `worldDir` in `core/world.ts` owns the resolution itself, because the world
 * directory is not only a data pack question: backup, restore and import all
 * need the same answer, and two implementations of it would drift.
 */
export async function worldDatapacksDir(inst: InstanceConfig): Promise<string> {
	return join(await worldDir(inst), "datapacks");
}

/** Instances that have a world to load data packs from (everything but the proxy). */
function worldInstances(cfg: ClusterConfig): Record<string, InstanceConfig> {
	const entries = Object.entries(managedInstances(cfg)).filter(
		([, inst]) => traitsOf(inst.software, inst.mcVersion).levelName !== undefined,
	);

	return Object.fromEntries(entries);
}

/**
 * Every instance a data pack deploys to: its own targets, expanded, united
 * with the instances its addon groups grant it. The proxy and unknown names
 * drop out; only a server with a world can load a data pack.
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
	/** Instances the groups contribute; the rest come from `entry.targets` */
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
	/** The world's copy differs from the pool; a deploy is pending */
	stale: boolean;
	/**
	 * What the server's own log says became of it, in the same vocabulary an
	 * addon row uses.
	 *
	 * A pack used to carry deploy state only - present, targeted, stale - which
	 * answers "did luna put it there" and says nothing about whether the server
	 * could read it. A pack whose `pack.mcmeta` is missing, whose format is
	 * refused, or whose recipes do not parse sits on disk looking perfectly
	 * deployed, and that was the whole of what the console showed.
	 *
	 * `loading` is never reported: a pack is read at boot or not at all.
	 */
	state: PluginRuntimeState;
	/** Warnings and errors the session attributes to this pack */
	warnings: number;
	errors: number;
}

/**
 * How the server names a pack in its log, for a pack that is a file in the
 * world's datapacks folder: vanilla prefixes the id with `file/`, and a
 * mod-provided one with `mod:` instead.
 */
function packLogIds(file: string): string[] {
	const bare = file.replace(/\.zip$/i, "");

	return [`file/${file}`, `file/${bare}`, file, bare].map((id) => id.toLowerCase());
}

/**
 * Lines that name a pack the server could not read at all.
 *
 * `Failed to load datapacks, can't proceed with server load` is deliberately not
 * here: it is the *consequence*, logged once for the whole set and naming
 * nothing, and the pack that caused it is named by one of these on a line above.
 * Matching it would mark every pack in the world broken because one of them was.
 */
const PACK_REFUSED = [
	"missing data pack",
	"failed to read pack",
	"failed to open pack",
	"incompatible pack",
];

/**
 * How a broken *piece of content* is reported. Capture 1 is the namespace, which
 * `packContents` maps back to the pack that shipped it.
 *
 * Both quoting styles are matched because the wording changed mid-1.21: up to
 * 1.21 it is `Couldn't parse data file x from y`, from 1.21.10 it is
 * `Couldn't parse data file 'x' from 'y'`. The advancement form disappeared
 * entirely in 1.20.5+ when advancements moved to codecs, so it is matched for
 * the older backends that still print it.
 */
const PACK_CONTENT_ERRORS: RegExp[] = [
	/couldn't parse data file '?([a-z0-9_.-]+):/,
	/parsing error loading (?:custom|built-in) advancement '?([a-z0-9_.-]+):/,
	/parsing error loading recipe '?([a-z0-9_.-]+):/,
	/couldn't parse loot table '?([a-z0-9_.-]+):/,
	/couldn't read tag list '?([a-z0-9_.-]+):/,
];

/**
 * Runtime state of one pack, from the boot session.
 *
 * Two independent kinds of failure, and they mean different things to whoever is
 * reading the screen. The server could not *read the pack* - no `pack.mcmeta`, a
 * format it refuses, a zip it cannot open - which is a packaging problem; or it
 * read the pack and could not parse something *inside* it, which is a content
 * problem in a pack that is otherwise installed correctly. Both land on
 * `errored`, and the error tally is what separates one broken recipe from a pack
 * that never loaded.
 */
function packState(
	session: BootSession,
	file: string,
	namespaces: string[],
): { state: PluginRuntimeState; warnings: number; errors: number } {
	const ids = packLogIds(file);
	const owned = new Set(namespaces);

	let refused = false;
	let missing = false;
	let warnings = 0;
	let errors = 0;

	for (const rawLine of session.lines) {
		const line = rawLine.toLowerCase();
		let mine = false;

		if (PACK_REFUSED.some((phrase) => line.includes(phrase)) && ids.some((id) => line.includes(id))) {
			mine = true;

			// "missing" is its own answer: the pack is enabled in the world's
			// level.dat and is not on disk, which is a different fix from a pack the
			// server choked on
			if (line.includes("missing data pack")) {
				missing = true;
			} else {
				refused = true;
			}
		}

		if (!mine && owned.size) {
			for (const pattern of PACK_CONTENT_ERRORS) {
				const namespace = pattern.exec(line)?.[1];

				if (namespace && owned.has(namespace)) {
					mine = true;
					refused = true;

					break;
				}
			}
		}

		if (!mine) {
			continue;
		}

		if (/\/warn\]|\[warn\]/.test(line)) {
			warnings += 1;
		} else {
			errors += 1;
		}
	}

	if (refused) {
		return { state: "errored", warnings, errors };
	}

	if (missing) {
		return { state: "missing", warnings, errors };
	}

	return { state: "running", warnings, errors };
}

/**
 * What one instance's world actually holds: managed packs (present, missing or
 * stale against the pool) and unmanaged zips someone dropped in by hand, listed
 * so they can be adopted into the pool rather than silently ignored.
 * Runs on the instance's owner; the world is on that machine's disk.
 *
 * `opts.state` is the instance's lifecycle as the caller knows it, exactly as
 * for the addon report: without it the instance is probed, which cannot see a
 * stop that has only just been asked for.
 */
export async function instanceDataPackReport(
	cfg: ClusterConfig,
	lock: PacksLock,
	instance: string,
	groups?: AddonGroups,
	opts: { state?: ReportLifecycle } = {},
): Promise<{ world: string; rows: InstanceDataPackRow[] }> {
	const inst = worldInstances(cfg)[instance];

	if (!inst) {
		throw new Error(t("core.datapacks.noWorld", { name: instance }));
	}

	const dir = await worldDatapacksDir(inst);
	const rows: InstanceDataPackRow[] = [];

	let files: string[] = [];

	if (existsSync(dir)) {
		files = (await readdir(dir)).filter((file) => file.toLowerCase().endsWith(".zip"));
	}

	const byFile = new Map(Object.entries(lock.datapacks).map(([name, entry]) => [entry.file, name]));
	const seen = new Set<string>();

	// Nothing is loaded on a server that is not running, and a log untouched since
	// the process began cannot describe it - the same two questions the addon
	// report asks, answered the same way, so one tab cannot call a pack `running`
	// while the tab beside it calls its plugins `stopped`.
	const status = await getStatus(cfg, instance);
	const lifecycle = opts.state ?? status.state;
	const down = lifecycle === "stopped" || lifecycle === "unknown";
	const session = down ? undefined : await readBootSession(cfg, instance);
	const startedAt = status.uptimeMs !== undefined ? Date.now() - status.uptimeMs : undefined;
	const stale =
		session !== undefined &&
		startedAt !== undefined &&
		session.writtenAt !== undefined &&
		session.writtenAt < startedAt;

	const readState = async (
		file: string,
		path: string,
	): Promise<{ state: PluginRuntimeState; warnings: number; errors: number }> => {
		if (down) {
			return { state: "stopped", warnings: 0, errors: 0 };
		}

		if (!session || stale) {
			return { state: "unknown", warnings: 0, errors: 0 };
		}

		const { namespaces } = await packContents(path);

		return packState(session, file, namespaces);
	};

	for (const file of files.sort()) {
		const name = byFile.get(file);
		const entry = name ? lock.datapacks[name] : undefined;
		const size = (await stat(join(dir, file))).size;

		let drifted = false;

		if (entry) {
			const poolPath = join(datapacksDir(), entry.file);

			if (existsSync(poolPath)) {
				drifted = (await sha512File(join(dir, file))) !== (await sha512File(poolPath));
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
			stale: drifted,
			...(await readState(file, join(dir, file))),
		});
	}

	// targeted here but not in the world yet; a deploy away
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
			// targeted but not deployed: the server was never given it, so there is
			// nothing for the log to have said. Not `missing`, which is the server
			// naming a pack it wanted and could not find.
			state: down ? "stopped" : "unknown",
			warnings: 0,
			errors: 0,
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
 * targets it (only files the lock knows are ever touched; hand-dropped zips
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
						detail: t("core.datapacks.poolFileMissing"),
					});

					continue;
				}

				if (there && (await sha512File(destPath)) === (await sha512File(poolPath))) {
					actions.push({ instance, file: entry.file, action: "unchanged" });

					continue;
				}

				node?.info(0.5, t("core.datapacks.copying", { file: entry.file }));
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
 * follow-up; routing to follower-owned targets happens at the daemon layer.
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
			t("core.datapacks.noVersionForMc", {
				slug: project.slug,
				mc: required.join(", ") || "any",
				newest,
			}),
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
			skipped.push({ name, reason: t("core.plugins.skipUnidentified") });

			continue;
		}

		if (!entry.autoUpdate && !names?.includes(name)) {
			skipped.push({ name, reason: t("core.plugins.skipAutoOff") });

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
		throw new Error(t("core.datapacks.unknown", { name: update.name }));
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
		throw new Error(t("core.datapacks.noWorld", { name: instance }));
	}

	const src = join(await worldDatapacksDir(inst), fileName);

	if (!existsSync(src)) {
		throw new Error(t("core.datapacks.fileNotInWorld", { file: fileName, name: instance }));
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
 * Pure file removal; no lock mutation; so a routed removal can run this
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
		throw new Error(t("core.datapacks.unknown", { name }));
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
 * targets: trim the target list, or; when nothing is left, or the removal
 * was unscoped; drop the pool zip and the entry itself.
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
		throw new Error(t("core.datapacks.unknown", { name }));
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
 * pool zip and lock entry go too. This reaches worlds on this machine only -
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
		throw new Error(t("core.datapacks.unknown", { name }));
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

/** The pooled zip a mapping identifies; never a world's own copy of it. */
function dataPackZipOf(lock: PacksLock, name: string): DataPackEntry {
	const entry = lock.datapacks[name];

	if (!entry) {
		throw new Error(t("core.datapacks.unknown", { name }));
	}

	if (!existsSync(join(datapacksDir(), entry.file))) {
		throw new Error(t("core.plugins.notInPool", { name, file: entry.file }));
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

/** The fields of a data pack a caller may edit after install. */
export interface DataPackPatch {
	autoUpdate?: boolean;
	channel?: PackChannel;
}

/**
 * Edit a data pack's update policy.
 *
 * The counterpart of `updateResourcePack`, and here for the same reason: the
 * console route used to reach into the lockfile and set these two fields itself,
 * which meant the rule that `release` is stored as absence lived in a route
 * rather than beside the data. `release` is deleted rather than written, so a
 * lockfile diff never fills with fields restating defaults.
 *
 * Mutates lock (caller saves).
 */
export function updateDataPack(
	lock: PacksLock,
	name: string,
	patch: DataPackPatch,
): DataPackEntry {
	const entry = lock.datapacks[name];

	if (!entry) {
		throw new Error(t("core.datapacks.unknown", { name }));
	}

	if (patch.channel !== undefined && !entry.remote) {
		throw new Error(t("core.datapacks.channelUnidentified", { name }));
	}

	if (patch.autoUpdate !== undefined) {
		entry.autoUpdate = patch.autoUpdate;
	}

	if (patch.channel !== undefined) {
		entry.channel = patch.channel;

		if (entry.channel === "release") {
			delete entry.channel;
		}
	}

	return entry;
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
