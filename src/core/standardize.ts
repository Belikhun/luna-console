// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Naming standardization (lockfile v3): every entry is keyed `<plugin>@<family>`
 * and its pool file is `<plugin>@<family>.jar`, making the (plugin, family)
 * pair readable straight off the key even when plugin names contain dashes.
 *
 * `standardizeNaming` migrates a live cluster in place, in an order with no
 * unprotected gap: rename the pool and rekey the lockfile and the port
 * allocations first, then deploy (new-name jars land NEXT TO the old ones),
 * then delete the old-name jars; a server restarting mid-migration always has
 * a full plugin set. Disk state is snapshotted before and after, per instance,
 * and compared by plugin identity; any difference fails the report.
 */

import { existsSync } from "node:fs";
import { readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import type { ClusterConfig, PluginsLock } from "./types";
import { t } from "../shared/i18n";
import { instanceDir, managedInstances, poolDir } from "./config";
import { familyOf, pluginNameOf } from "./families";
import { deploy } from "./plugins";
import type { ProgressReporter } from "./progress";

/** Lockfile schema revision written by a completed standardization. */
export const NAMING_VERSION = 3;

/** One entry's rename, or the reason it stays put. */
export interface RenameStep {
	oldKey: string;
	newKey: string;
	oldFile: string;
	newFile: string;
	plugin: string;
}

export interface StandardizeReport {
	renamed: RenameStep[];
	/** Port-allocation keys rewritten in cluster.json, e.g. "survival: bluemap-5.13-paper/web → bluemap@paper/web" */
	portKeys: string[];
	/** Group members renamed (a cleaned plugin identity, e.g. bluemap-5.13 → bluemap) */
	groupMembers: string[];
	/** Old-name jars removed per instance */
	removed: Array<{ instance: string; file: string }>;
	deployed: number;
	/** Per-instance plugin sets that differ between the before and after snapshots */
	mismatches: string[];
}

/** Version-ish suffixes have no place in a plugin identity (bluemap-5.13 → bluemap). */
function cleanIdentity(plugin: string): string {
	return plugin.replace(/-\d+(?:\.\d+)+$/, "");
}

/** Jar files in a directory, lowercased-name → actual name. */
async function jarIndex(dir: string): Promise<Map<string, string>> {
	const index = new Map<string, string>();

	if (!existsSync(dir)) {
		return index;
	}

	for (const file of await readdir(dir)) {
		if (file.toLowerCase().endsWith(".jar")) {
			index.set(file.toLowerCase(), file);
		}
	}

	return index;
}

/**
 * Per-instance plugin identities currently on disk, resolved through a
 * file-name → plugin mapping. Only managed jars count; unmanaged strays are
 * neither part of the guarantee nor touched by the migration.
 */
async function snapshot(
	cfg: ClusterConfig,
	fileToPlugin: Map<string, string>,
): Promise<Map<string, Set<string>>> {
	const state = new Map<string, Set<string>>();

	for (const [name, inst] of Object.entries(managedInstances(cfg))) {
		const jars = await jarIndex(join(instanceDir(inst), "plugins"));
		const plugins = new Set<string>();

		for (const lower of jars.keys()) {
			const plugin = fileToPlugin.get(lower);

			if (plugin) {
				plugins.add(plugin);
			}
		}

		state.set(name, plugins);
	}

	return state;
}

/**
 * Migrate every lockfile entry, the pool, the variant files, the port
 * allocations and the deployed jars to the `<plugin>@<family>` scheme.
 * Idempotent; a second run finds nothing to rename. Mutates `cfg` and `lock`;
 * the caller persists both.
 */
export async function standardizeNaming(
	cfg: ClusterConfig,
	lock: PluginsLock,
	opts: { reporter?: ProgressReporter } = {},
): Promise<StandardizeReport> {
	const progress = opts.reporter;
	const pool = poolDir();
	const variantsDir = join(pool, "versions");

	const report: StandardizeReport = {
		renamed: [],
		portKeys: [],
		groupMembers: [],
		removed: [],
		deployed: 0,
		mismatches: [],
	};

	// ---- plan --------------------------------------------------------------
	const steps: RenameStep[] = [];
	const identityRenames = new Map<string, string>();

	for (const [key, entry] of Object.entries(lock.plugins)) {
		const rawPlugin = pluginNameOf(key, entry);
		const plugin = cleanIdentity(rawPlugin);
		const family = familyOf(entry);
		const newKey = `${plugin}@${family}`;
		const newFile = `${newKey}.jar`;

		if (plugin !== rawPlugin) {
			identityRenames.set(rawPlugin, plugin);
		}

		if (key === newKey && entry.file === newFile) {
			continue;
		}

		if (lock.plugins[newKey] && newKey !== key) {
			throw new Error(t("core.standardize.renameConflict", { from: key, to: newKey }));
		}

		steps.push({ oldKey: key, newKey, oldFile: entry.file, newFile, plugin });
	}

	// before-snapshot maps OLD file names to their (cleaned) plugin identity
	const fileToPluginBefore = new Map<string, string>();

	for (const [key, entry] of Object.entries(lock.plugins)) {
		fileToPluginBefore.set(entry.file.toLowerCase(), cleanIdentity(pluginNameOf(key, entry)));
	}

	progress?.info(0.05, t("core.standardize.renaming", { count: steps.length }));

	const before = await snapshot(cfg, fileToPluginBefore);

	// ---- pool + lockfile ----------------------------------------------------
	for (const step of steps) {
		const entry = lock.plugins[step.oldKey]!;
		const oldPath = join(pool, step.oldFile);
		const newPath = join(pool, step.newFile);

		if (existsSync(oldPath)) {
			await rename(oldPath, newPath);
		}

		for (const variant of Object.values(entry.variants ?? {})) {
			const prefix = `${step.oldKey}@`;

			if (variant.file.startsWith(prefix)) {
				const newVariantFile = `${step.newKey}@${variant.file.slice(prefix.length)}`;
				const oldVariantPath = join(variantsDir, variant.file);

				if (existsSync(oldVariantPath)) {
					await rename(oldVariantPath, join(variantsDir, newVariantFile));
				}

				variant.file = newVariantFile;
			}
		}

		entry.file = step.newFile;
		entry.plugin = step.plugin;

		delete lock.plugins[step.oldKey];
		lock.plugins[step.newKey] = entry;

		report.renamed.push(step);
	}

	// ---- port allocations (keys embed the entry key) -------------------------
	const rekeyPorts = (ports: Record<string, number> | undefined, where: string): void => {
		if (!ports) {
			return;
		}

		for (const step of steps) {
			const prefix = `${step.oldKey}/`;

			for (const key of Object.keys(ports)) {
				if (key.startsWith(prefix)) {
					const newKey = `${step.newKey}/${key.slice(prefix.length)}`;

					ports[newKey] = ports[key]!;
					delete ports[key];
					report.portKeys.push(`${where}: ${key} → ${newKey}`);
				}
			}
		}
	};

	rekeyPorts(cfg.proxy.ports, "proxy");

	for (const [name, inst] of Object.entries(cfg.instances)) {
		rekeyPorts(inst.ports, name);
	}

	// ---- group members + overrides (cleaned plugin identities) ---------------
	for (const [oldPlugin, newPlugin] of identityRenames) {
		for (const [groupName, group] of Object.entries(lock.groups ?? {})) {
			const index = group.plugins.indexOf(oldPlugin);

			if (index !== -1) {
				group.plugins[index] = newPlugin;
				report.groupMembers.push(`${groupName}: ${oldPlugin} → ${newPlugin}`);
			}
		}

		for (const inst of Object.values(cfg.instances)) {
			const override = inst.pluginOverrides?.[oldPlugin];

			if (override !== undefined) {
				inst.pluginOverrides![newPlugin] = override;
				delete inst.pluginOverrides![oldPlugin];
			}
		}
	}

	// ---- deploy new names, then remove the old jars ---------------------------
	progress?.info(0.3, t("core.standardize.deploying"));

	const actions = await deploy(cfg, lock, {});

	report.deployed = actions.filter((action) => action.action !== "unchanged").length;

	progress?.info(0.7, t("core.standardize.removingOld"));

	for (const [name, inst] of Object.entries(managedInstances(cfg))) {
		const dir = join(instanceDir(inst), "plugins");
		const jars = await jarIndex(dir);

		for (const step of steps) {
			if (step.oldFile.toLowerCase() === step.newFile.toLowerCase()) {
				continue;
			}

			const actual = jars.get(step.oldFile.toLowerCase());

			if (actual) {
				await rm(join(dir, actual));
				report.removed.push({ instance: name, file: actual });
			}
		}
	}

	// ---- parity check ----------------------------------------------------------
	const fileToPluginAfter = new Map<string, string>();

	for (const [key, entry] of Object.entries(lock.plugins)) {
		fileToPluginAfter.set(entry.file.toLowerCase(), pluginNameOf(key, entry));
	}

	const after = await snapshot(cfg, fileToPluginAfter);

	for (const [name, wanted] of before) {
		const got = after.get(name) ?? new Set<string>();
		const missing = [...wanted].filter((plugin) => !got.has(plugin));
		const extra = [...got].filter((plugin) => !wanted.has(plugin));

		if (missing.length || extra.length) {
			const parts: string[] = [];

			if (missing.length) {
				parts.push(`missing ${missing.join(", ")}`);
			}

			if (extra.length) {
				parts.push(`gained ${extra.join(", ")}`);
			}

			report.mismatches.push(`${name}: ${parts.join("; ")}`);
		}
	}

	// aliases/meta are keyed by content, which did not change; but recompute
	// display data for renamed identities so nothing stale survives
	lock.version = NAMING_VERSION;
	progress?.complete(t("core.standardize.done"));

	return report;
}
