// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/modpack. Installing runs on the daemon that will own the
 * instance (the pack's files land on its disk), updating on the one that owns it.
 *
 * `completeProvision` is composed here rather than in core on purpose: the
 * steps after a create (the forwarding mod, the deploy, the group packs, the
 * ports, velocity) are each routed to the owning daemon by their own ops, and a
 * core function running inside one daemon could not write another's disk. It is
 * the sequence `instance create` runs, shared so the CLI, the console route and
 * the MCP tool do not each repeat it.
 */

import type * as core from "../../core/modpack";
import type { ProgressReporter } from "../../core/progress";
import type { ClusterConfig, PluginsLock } from "../../core/types";
import { t } from "../../shared/i18n";

import { call, jobCall } from "../rpc";
import { applyAddonGroups } from "./addons";
import { ensureForwardingMod } from "./admin";
import { saveCluster, saveLock } from "./config";
import { loadPacksLock, savePacksLock } from "./packslock";
import { deploy } from "./plugins";
import { ensurePortAllocations } from "./ports";
import { syncVelocityToml } from "./proxy";

export type {
	ModpackInstallOptions,
	ModpackInstallResult,
	ModpackManifest,
	ModpackSearchHit,
	ModpackSource,
	ModpackUpdateOptions,
	ModpackUpdateResult,
	ModpackVersion,
} from "../../core/modpack";
export { MODPACK_MANIFEST, MRPACK_HOSTS } from "../../core/modpack";

export const searchModpacks = call("modpack.search") as typeof core.searchModpacks;
export const modpackVersions = call("modpack.versions") as typeof core.modpackVersions;
export const installModpack = jobCall("modpack.install", {
	cfg: 0,
	reporter: { arg: 2, prop: "reporter" },
	kind: "modpack-install",
	targetArg: 1,
}) as typeof core.installModpack;
export const updateModpack = jobCall("modpack.update", {
	cfg: 0,
	reporter: { arg: 2, prop: "reporter" },
	kind: "modpack-update",
	targetArg: 1,
}) as typeof core.updateModpack;

/** The progress nodes `completeProvision` reports into, one per step. */
export interface ProvisionSteps {
	plugins: ProgressReporter;
	packs: ProgressReporter;
	ports: ProgressReporter;
	proxy: ProgressReporter;
}

export interface ProvisionOutcome {
	forwarding: { installed: boolean; slug?: string; required: string[]; configOnly?: boolean };
	pluginsChanged: number;
	respackRules: number;
	datapacks: number;
	velocityUpdated: boolean;
}

/**
 * What a create still owes after the instance exists: the forwarding mod and
 * every pool jar that targets it, the addon groups' packs, the plugin ports,
 * and its line in velocity.toml. The cluster and lock are saved along the way.
 */
export async function completeProvision(
	cfg: ClusterConfig,
	lock: PluginsLock,
	name: string,
	steps: ProvisionSteps,
	register = true,
): Promise<ProvisionOutcome> {
	let forwarding: ProvisionOutcome["forwarding"] = { installed: false, required: [] };

	const deployed = await steps.plugins.task({ start: t("core.modpack.provision.deploying") }, async (step) => {
		forwarding = await ensureForwardingMod(cfg, lock, name);
		await saveLock(lock);

		return await deploy(cfg, lock, { instances: [name], reporter: step });
	});

	const pluginsChanged = deployed.filter((action) => action.action !== "unchanged").length;

	steps.plugins.complete(t("core.modpack.provision.deployed", { changed: pluginsChanged, total: deployed.length }));

	const applied = await steps.packs.task({ start: t("core.modpack.provision.applyingPacks") }, async () => {
		const packsLock = await loadPacksLock();
		const outcome = await applyAddonGroups(cfg, packsLock, lock.groups, { instances: [name] });

		await savePacksLock(packsLock);

		return outcome;
	});

	const datapacks = applied.datapacks.filter((action) => action.action !== "unchanged").length;

	steps.packs.complete(t("core.modpack.provision.packsApplied", { rules: applied.respacks.length, datapacks }));

	await steps.ports.task(
		{ start: t("core.modpack.provision.allocatingPorts"), done: t("core.modpack.provision.portsAllocated") },
		async () => {
			await ensurePortAllocations(cfg, lock);
			await saveCluster(cfg);
			await saveLock(lock);
		},
	);

	let velocityUpdated = false;

	if (register) {
		await steps.proxy.task({ start: t("core.modpack.provision.registering") }, async (step) => {
			velocityUpdated = (await syncVelocityToml(cfg)).changed;

			step.report(
				1,
				"okay",
				velocityUpdated ? t("core.modpack.provision.velocityUpdated") : t("core.modpack.provision.velocityUpToDate"),
			);
		});
	} else {
		steps.proxy.complete(t("core.modpack.provision.notRegistered"));
	}

	return {
		forwarding,
		pluginsChanged,
		respackRules: applied.respacks.length,
		datapacks,
		velocityUpdated,
	};
}
