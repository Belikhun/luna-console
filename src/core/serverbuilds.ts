// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Newer builds of the software an instance already runs.
 *
 * `setVersion` moves an instance between *Minecraft* versions, which is a
 * migration: plugins have to be compatible, worlds may be upgraded in place, and
 * the operator picks the target. This is the other, far more common job. Paper
 * publishes a build most days against the same Minecraft version, each one a bug
 * fix nobody chose to skip, and until now the only way to take one was to retype
 * the version the instance already had and hope the guard let it through.
 *
 * The check is deliberately cheap: one provider call per instance, cached by the
 * software registry, plus one small file read. Nothing is downloaded to find out
 * whether there is anything to download.
 */

import { existsSync } from "node:fs";

import { detectBuildId, setVersion, type SetVersionResult } from "./admin";
import { instanceDir, managedInstances } from "./config";
import { ProgressReporter } from "./progress";
import { resolveBuild } from "./services/software/registry";
import type { SoftwareBuild } from "./services/software/types";
import { hasProvider, traitsOf } from "./software";
import type { ClusterConfig, InstanceConfig, Software } from "./types";
import { buildPlatform } from "../version";
import { t } from "../shared/i18n";

/** Where an instance's current build id came from, which decides how far to trust it. */
export type BuildSource = "registry" | "loader" | "serverFile" | "unknown";

/** What an instance runs now, as well as luna can establish it. */
export interface InstalledBuild {
	buildId?: string;
	source: BuildSource;
}

/**
 * The build id an instance is running.
 *
 * Three sources, in order of authority. The registry is what luna itself wrote
 * when it installed the build. An args-file loader has no separate build id, so
 * its loader version *is* the answer. Failing both, the paper family writes its
 * own build number into `version_history.json` on every boot, which covers every
 * backend adopted from a directory somebody else set up.
 *
 * `unknown` is a real and reportable answer: velocity, the hybrids and pumpkin
 * leave nothing on disk to read, so an instance of those created before luna
 * recorded build ids cannot be compared against anything until it is upgraded
 * once. Guessing there would mean claiming an update exists on every check.
 */
export async function installedBuild(inst: InstanceConfig): Promise<InstalledBuild> {
	if (traitsOf(inst.software, inst.mcVersion).pinsLoaderVersion) {
		return inst.loaderVersion
			? { buildId: inst.loaderVersion, source: "loader" }
			: { source: "unknown" };
	}

	if (inst.buildId) {
		return { buildId: inst.buildId, source: "registry" };
	}

	const dir = instanceDir(inst);

	if (!existsSync(dir)) {
		return { source: "unknown" };
	}

	const detected = await detectBuildId(dir);

	return detected ? { buildId: detected, source: "serverFile" } : { source: "unknown" };
}

/** A newer build waiting for one instance. */
export interface BuildUpdate {
	instance: string;
	software: Software;
	/** The Minecraft version this stays on; the whole point is that it does not move */
	mcVersion?: string;
	/** What it runs now, absent when nothing on disk or in the registry says */
	from?: string;
	fromSource: BuildSource;
	/** The newest build the provider offers for that same Minecraft version */
	to: string;
	build: SoftwareBuild;
}

/**
 * One instance's answer: an update, or why there is not one.
 *
 * Separate fields rather than a union, because "up to date" and "cannot be
 * checked" are different things an operator acts on differently, and a screen
 * showing both has to tell them apart.
 */
export interface BuildCheck {
	instance: string;
	update?: BuildUpdate;
	/** Why no comparison was possible; absent when one was */
	skipped?: string;
	/** Set when the check ran and found the newest build already installed */
	current?: string;
}

/**
 * Whether luna could offer this instance a build at all, and why not.
 *
 * An external server is somebody else's to update. Software with no provider was
 * only ever adopted, so there is no upstream to ask.
 */
function unavailable(inst: InstanceConfig): string | undefined {
	if (inst.external) {
		return t("core.serverBuilds.skipExternal");
	}

	if (!hasProvider(inst.software)) {
		return t("core.serverBuilds.skipNoProvider", { software: inst.software });
	}

	return undefined;
}

/**
 * Ask the provider whether it has a newer build than the one this instance runs,
 * without changing anything.
 *
 * The Minecraft version is pinned to the instance's own, so the answer is always
 * a same-version build. A loader keeps its Minecraft version too and moves its
 * loader build, which is the same question asked of a different field.
 */
export async function checkServerBuild(cfg: ClusterConfig, name: string): Promise<BuildCheck> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name }));
	}

	const blocked = unavailable(inst);

	if (blocked) {
		return { instance: name, skipped: blocked };
	}

	const current = await installedBuild(inst);

	// this daemon owns the instance, so its own platform is the one a native
	// build has to match; the op is routed to the owner for exactly that reason
	const build = await resolveBuild(inst.software, {
		...(inst.mcVersion ? { mcVersion: inst.mcVersion } : {}),
		platform: buildPlatform(),
	});

	// the resolver settles "newest for this Minecraft version", so a build id that
	// differs from the installed one is newer by construction. Comparing them as
	// numbers would be wrong for three of the seven providers: a forge build id is
	// a loader version and a pumpkin one is a git tag.
	if (current.source === "unknown") {
		return {
			instance: name,
			skipped: t("core.serverBuilds.skipUnknownBuild", { build: build.buildId }),
		};
	}

	if (current.buildId === build.buildId) {
		return { instance: name, current: build.buildId };
	}

	return {
		instance: name,
		update: {
			instance: name,
			software: inst.software,
			...(inst.mcVersion ? { mcVersion: inst.mcVersion } : {}),
			...(current.buildId ? { from: current.buildId } : {}),
			fromSource: current.source,
			to: build.buildId,
			build,
		},
	};
}

/**
 * Check several instances, or the whole cluster.
 *
 * Every instance is reported, including the ones with nothing to offer: a sweep
 * that silently omits them reads as "these are fine" when the truth may be that
 * they could not be asked.
 */
export async function checkServerBuilds(
	cfg: ClusterConfig,
	names?: string[],
	opts: { reporter?: ProgressReporter } = {},
): Promise<BuildCheck[]> {
	const wanted = names?.length ? names : Object.keys(managedInstances(cfg));
	const progress = opts.reporter;
	const out: BuildCheck[] = [];

	let done = 0;

	for (const name of wanted) {
		progress?.info(done / Math.max(1, wanted.length), t("core.serverBuilds.asking", { name }));

		try {
			out.push(await checkServerBuild(cfg, name));
		} catch (err) {
			out.push({
				instance: name,
				skipped: err instanceof Error ? err.message : String(err),
			});
		}

		done += 1;
	}

	progress?.complete(
		t("core.serverBuilds.checked", {
			count: wanted.length,
			updates: out.filter((row) => row.update).length,
		}),
	);

	return out;
}

/**
 * What an upgrade replaced, on top of what `setVersion` reports.
 *
 * `SetVersionResult.from` is the *Minecraft* version moved away from, which for
 * a build bump is the same string as `to` and says nothing. The build that was
 * replaced is the fact worth reporting, and only this function is in a position
 * to know it: once the install has happened, the evidence is gone.
 */
export interface BuildUpdateResult extends SetVersionResult {
	fromBuild?: string;
	toBuild: string;
}

/**
 * Install the newest build of the Minecraft version an instance already runs.
 *
 * This is `setVersion` pointed back at the version the instance is on, which is
 * exactly what it does when asked for "newest" and is why there is no separate
 * download, backup or rollback path here. The instance's own Minecraft version
 * is passed explicitly rather than left absent: absent means "newest release the
 * provider has", which would silently migrate a backend pinned to an older line.
 *
 * Mutates cfg (caller saves).
 */
export async function updateServerBuild(
	cfg: ClusterConfig,
	name: string,
	reporter?: ProgressReporter,
): Promise<BuildUpdateResult> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name }));
	}

	const blocked = unavailable(inst);

	if (blocked) {
		throw new Error(blocked);
	}

	// read before the install, which overwrites the only evidence of it
	const previous = await installedBuild(inst);

	const result = await setVersion(
		cfg,
		name,
		{
			...(inst.mcVersion ? { mcVersion: inst.mcVersion } : {}),
			// deliberately not the current loaderVersion: pinning it would resolve
			// the build already installed, which is a reinstall rather than an update
		},
		reporter,
	);

	return {
		...result,
		...(previous.buildId ? { fromBuild: previous.buildId } : {}),
		toBuild: result.build.buildId,
	};
}
