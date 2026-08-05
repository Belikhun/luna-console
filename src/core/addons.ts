/**
 * Applying an addon group's *pack* half.
 *
 * A group carries three kinds of addon and each reaches an instance by its own
 * road: plugins are deployed as jars (plugins.ts), data packs are copied into
 * the instance's world (datapacks.ts), and resource packs never leave the
 * proxy at all; their membership is materialized into the `.yml` rules
 * luna-pack reads (respacks.ts). This module is the one call that walks all
 * three, so "the group changed" means the same thing to the CLI, the console
 * and an instance's launch.
 *
 * Plugin deployment stays out of it: it has its own lockfile, its own routing
 * and its own progress tree, and the group screens already drive it directly.
 *
 * The other cross-kind walk lives here too: `adoptInstanceAddons`, which is
 * what an adopted server's own plugins, mods and data packs are measured
 * against; all three kinds, one answer, one rule about what luna may claim.
 */

import { existsSync } from "node:fs";
import { readdir, rename } from "node:fs/promises";
import { join, relative } from "node:path";

import { addonDirForFamily, addonDirOf, instanceDir, managedInstances } from "./config";
import { deployDataPacks, worldDatapacksDir, type DataPackDeployAction } from "./datapacks";
import { effectiveTargets, familyOf } from "./families";
import type { PacksLock } from "./packslock";
import { identityFromFile, instanceAddonDir } from "./plugins";
import type { ProgressReporter } from "./progress";
import { reloadResourcePacks, syncResourcePackGroups } from "./respacks";
import { sha512File } from "./services/download";
import type { AddonGroup, ClusterConfig, PluginsLock } from "./types";
import { t } from "../shared/i18n";

/** What applying the groups' pack membership changed. */
export interface AddonGroupApply {
	/** Resource pack keys whose server rules were rewritten */
	respacks: string[];
	/** Whether the proxy was asked to re-read the catalog (false when it is down) */
	reloaded: boolean;
	/** Per-instance data pack outcomes, exactly as a deploy reports them */
	datapacks: DataPackDeployAction[];
}

/**
 * Push the groups' resource packs and data packs to the instances they cover:
 * rewrite the pack definitions, reload the proxy when any changed, then deploy
 * the pool into the instances' worlds. Idempotent; a run that changes nothing
 * reports nothing touched and sends no reload.
 */
export async function applyAddonGroups(
	cfg: ClusterConfig,
	packs: PacksLock,
	groups: Record<string, AddonGroup> | undefined,
	opts: { instances?: string[]; reporter?: ProgressReporter } = {},
): Promise<AddonGroupApply> {
	const progress = opts.reporter;
	const respackNode = progress?.child("Resource packs", 1);

	const respacks = await syncResourcePackGroups(cfg, packs, groups);

	let reloaded = false;

	if (respacks.length) {
		reloaded = await reloadResourcePacks(cfg);
	}

	respackNode?.complete(
		respacks.length
			? t("core.addons.rewritten", { count: respacks.length }) + (reloaded ? ` ${t("core.addons.proxyReloaded")}` : "")
			: "nothing to change",
	);

	const datapacks = await deployDataPacks(cfg, packs, {
		instances: opts.instances,
		groups,
		reporter: progress?.child("Data packs", 3),
	});

	return { respacks, reloaded, datapacks };
}

/** The addon kinds an instance can be carrying when luna first meets it. */
export type SeenAddonKind = "plugin" | "mod" | "datapack";

/** One of the instance's own files that turned out to be a pooled addon. */
export interface AdoptedAddon {
	kind: SeenAddonKind;
	/** Pool identity: the lockfile entry key, or the data pack's name */
	addon: string;
	/** The file as the instance had it */
	file: string;
	/** Set when the file was renamed to the pool's name to become the deployment */
	renamedTo?: string;
	/** Pooled version the instance was assigned, when it matched an older build */
	version?: string;
}

/** One of the instance's own files that luna leaves entirely alone. */
export interface UnmanagedAddon {
	kind: SeenAddonKind;
	/** Path inside the instance directory, e.g. "mods/create-1.21.1.jar" */
	path: string;
}

export interface AddonAdoption {
	adopted: AdoptedAddon[];
	unmanaged: UnmanagedAddon[];
}

/** The pooled build an instance's jar is, if it is one of ours at all. */
function matchPooledJar(
	lock: PluginsLock,
	dir: "plugins" | "mods",
	file: string,
	hash: string,
): { key: string; version?: string } | undefined {
	for (const [key, entry] of Object.entries(lock.plugins)) {
		if (addonDirForFamily(familyOf(entry)) !== dir) {
			continue;
		}

		if (entry.installed?.sha512 === hash) {
			return { key };
		}

		for (const variant of Object.values(entry.variants ?? {})) {
			if (variant.sha512 === hash) {
				return { key, version: variant.versionNumber };
			}
		}

		// A standardized file name is written by a luna deploy and nothing else,
		// so a server arriving with one came from a luna cluster; that is ours
		// even when the build drifted from what the pool holds today.
		if (identityFromFile(entry.file) && file.toLowerCase() === entry.file.toLowerCase()) {
			return { key };
		}
	}

	return undefined;
}

/**
 * Work out what an instance brought with it, and register only the parts that
 * are already in luna's addon store.
 *
 * The rule (DESIGN.md; adoption): a server joining the cluster keeps its own
 * plugins, mods and data packs. They stay in its directory, untouched and
 * unmanaged, because the directory is configured and working and rewriting it
 * is exactly how a working server stops working. The single exception is a file
 * that *is* one of ours; byte-identical to a pooled build, or carrying the
 * standardized pool file name; which is registered as a deployment of that
 * addon rather than left to drift as a stranger's copy.
 *
 * Registering renames the instance's file to the pool's name when they differ,
 * so the copy already there becomes the deployment instead of a duplicate the
 * server would load twice; that rename is the only write this makes, and
 * `opts.apply: false` skips it for a dry run.
 *
 * The lockfiles are read here, never written: this runs on the daemon that owns
 * the instance, while the state files belong to the primary. `applyAddonAdoption`
 * is the other half, and it is pure.
 */
export async function adoptInstanceAddons(
	cfg: ClusterConfig,
	lock: PluginsLock,
	packs: PacksLock,
	instance: string,
	opts: { apply?: boolean } = {},
): Promise<AddonAdoption> {
	const inst = managedInstances(cfg)[instance];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name: instance }));
	}

	const apply = opts.apply !== false;
	const adoption: AddonAdoption = { adopted: [], unmanaged: [] };

	const dir = addonDirOf(inst.software);
	const addonDir = instanceAddonDir(inst);

	if (existsSync(addonDir)) {
		const jars = (await readdir(addonDir)).filter((file) => file.toLowerCase().endsWith(".jar"));

		for (const file of jars.sort()) {
			const hash = await sha512File(join(addonDir, file));
			const match = matchPooledJar(lock, dir, file, hash);

			if (!match) {
				adoption.unmanaged.push({ kind: dir === "mods" ? "mod" : "plugin", path: `${dir}/${file}` });

				continue;
			}

			const entry = lock.plugins[match.key]!;
			const adopted: AdoptedAddon = { kind: dir === "mods" ? "mod" : "plugin", addon: match.key, file };

			if (match.version) {
				adopted.version = match.version;
			}

			if (file !== entry.file) {
				adopted.renamedTo = entry.file;
			}

			if (apply && file !== entry.file) {
				await rename(join(addonDir, file), join(addonDir, entry.file));
			}

			adoption.adopted.push(adopted);
		}
	}

	// the proxy has no world, so it has no data packs to account for
	if (inst.software !== "velocity") {
		const worldDir = await worldDatapacksDir(inst);

		if (existsSync(worldDir)) {
			const zips = (await readdir(worldDir)).filter((file) => file.toLowerCase().endsWith(".zip"));
			// reported relative to the instance, so a renamed world reads correctly
			const worldRel = relative(instanceDir(inst), worldDir);

			for (const file of zips.sort()) {
				const hash = await sha512File(join(worldDir, file));

				const match = Object.entries(packs.datapacks).find(
					([, entry]) =>
						entry.installed?.sha512 === hash || file.toLowerCase() === entry.file.toLowerCase(),
				);

				if (!match) {
					adoption.unmanaged.push({ kind: "datapack", path: `${worldRel}/${file}` });

					continue;
				}

				const [name, entry] = match;
				const adopted: AdoptedAddon = { kind: "datapack", addon: name, file };

				if (file !== entry.file) {
					adopted.renamedTo = entry.file;
				}

				if (apply && file !== entry.file) {
					await rename(join(worldDir, file), join(worldDir, entry.file));
				}

				adoption.adopted.push(adopted);
			}
		}
	}

	return adoption;
}

/**
 * Record an adoption in the lockfiles: every recognised addon gains the
 * instance as a target, and a match against an older pooled build assigns that
 * version so the next deploy does not push a newer one over a working server.
 *
 * Pure; the disk work already happened in `adoptInstanceAddons`. Mutates
 * `lock`/`packs`; the caller saves them. Returns the addons it registered, so a
 * second run over the same adoption reports nothing new.
 */
export function applyAddonAdoption(
	cfg: ClusterConfig,
	lock: PluginsLock,
	packs: PacksLock,
	instance: string,
	adoption: AddonAdoption,
): string[] {
	const registered: string[] = [];

	for (const item of adoption.adopted) {
		if (item.kind === "datapack") {
			const entry = packs.datapacks[item.addon];

			if (!entry || entry.targets.includes(instance)) {
				continue;
			}

			entry.targets = [...entry.targets, instance].sort();
			registered.push(item.addon);

			continue;
		}

		const entry = lock.plugins[item.addon];

		if (!entry) {
			continue;
		}

		// an explicit target is only needed when no group already grants it
		if (!effectiveTargets(cfg, lock, item.addon).includes(instance)) {
			entry.targets = [...new Set([...entry.targets, instance])].sort();
			registered.push(item.addon);
		}

		if (item.version) {
			entry.assign ??= {};
			entry.assign[instance] = item.version;
		}
	}

	return registered;
}
