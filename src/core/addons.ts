/**
 * Applying an addon group's *pack* half.
 *
 * A group carries three kinds of addon and each reaches an instance by its own
 * road: plugins are deployed as jars (plugins.ts), data packs are copied into
 * the instance's world (datapacks.ts), and resource packs never leave the
 * proxy at all — their membership is materialized into the `.yml` rules
 * luna-pack reads (respacks.ts). This module is the one call that walks all
 * three, so "the group changed" means the same thing to the CLI, the console
 * and an instance's launch.
 *
 * Plugin deployment stays out of it: it has its own lockfile, its own routing
 * and its own progress tree, and the group screens already drive it directly.
 */

import { deployDataPacks, type DataPackDeployAction } from "./datapacks";
import type { PacksLock } from "./packslock";
import type { ProgressReporter } from "./progress";
import { reloadResourcePacks, syncResourcePackGroups } from "./respacks";
import type { AddonGroup, ClusterConfig } from "./types";

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
 * the pool into the instances' worlds. Idempotent — a run that changes nothing
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
			? `${respacks.length} definition(s) rewritten${reloaded ? " — proxy reloaded" : ""}`
			: "nothing to change",
	);

	const datapacks = await deployDataPacks(cfg, packs, {
		instances: opts.instances,
		groups,
		reporter: progress?.child("Data packs", 3),
	});

	return { respacks, reloaded, datapacks };
}
