// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { t } from "../shared/i18n";
import { allInstances } from "./config";
import { validateRuntimeId } from "./runtimes";
import { validateJavaArgs } from "./settings";
import type { ClusterConfig, JavaProfile } from "./types";

/**
 * Java profiles: the named JVM flag sets an instance launches with.
 *
 * Profiles have lived in `cluster.json` since the beginning and were only ever
 * readable; this is the editing half. Everything here is pure - it mutates the
 * config object it is handed and leaves persisting it to the caller's
 * `saveCluster`, which is what lets the same functions serve the CLI and the
 * console without an op of their own.
 */

/** Profile names: what a directory and a CLI argument can both carry safely. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** A profile with the instances that launch from it. */
export interface ProfileSummary {
	name: string;
	java?: string;
	runtime?: string;
	flags: string[];
	jarArgs?: string[];
	/** Instances whose `profile` is this one */
	usedBy: string[];
}

/** Every profile in the cluster, with its users, sorted by name. */
export function listProfiles(cfg: ClusterConfig): ProfileSummary[] {
	return Object.entries(cfg.javaProfiles)
		.map(([name, profile]) => ({
			name,
			java: profile.java,
			runtime: profile.runtime,
			flags: [...profile.flags],
			jarArgs: profile.jarArgs ? [...profile.jarArgs] : undefined,
			usedBy: profileConsumers(cfg, name),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** Instances launching from a profile, the proxy included. */
export function profileConsumers(cfg: ClusterConfig, name: string): string[] {
	return Object.entries(allInstances(cfg))
		.filter(([, inst]) => inst.profile === name)
		.map(([instance]) => instance)
		.sort();
}

/** Read one profile, or throw naming it. */
export function getProfile(cfg: ClusterConfig, name: string): JavaProfile {
	const profile = cfg.javaProfiles[name];

	if (!profile) {
		throw new Error(t("core.profiles.unknown", { name }));
	}

	return profile;
}

/**
 * Check a profile's contents. Flags go through the same validator the
 * per-instance ones do, because they land in the same unquoted line of the
 * generated `run.sh`; jar arguments only get the shell check, since a jar
 * argument (`nogui`) is legitimately not a flag.
 */
function validateBody(data: Partial<JavaProfile>): void {
	if (data.flags) {
		const bad = validateJavaArgs(data.flags);

		if (bad) {
			throw new Error(bad);
		}
	}

	if (data.jarArgs) {
		for (const arg of data.jarArgs) {
			if (/[;&|<>$`(){}\\"'\s]/.test(arg)) {
				throw new Error(t("core.settings.shellCharacters", { arg }));
			}
		}
	}

	if (data.runtime) {
		const bad = validateRuntimeId(data.runtime);

		if (bad) {
			throw new Error(bad);
		}
	}

	if (data.java && /\s/.test(data.java)) {
		throw new Error(t("core.profiles.javaPathSpaces"));
	}
}

function validateName(name: string): void {
	if (!NAME_PATTERN.test(name)) {
		throw new Error(t("core.profiles.badName", { name }));
	}
}

/** Add a profile. Refuses a name already taken. */
export function createProfile(cfg: ClusterConfig, name: string, data: JavaProfile): void {
	validateName(name);

	if (cfg.javaProfiles[name]) {
		throw new Error(t("core.profiles.exists", { name }));
	}

	validateBody(data);

	cfg.javaProfiles[name] = {
		java: data.java || undefined,
		runtime: data.runtime || undefined,
		flags: [...(data.flags ?? [])],
		jarArgs: data.jarArgs?.length ? [...data.jarArgs] : undefined,
	};
}

/**
 * Change a profile in place. A field is only touched when the patch carries it;
 * passing an empty string clears `java` or `runtime`, which is how a profile
 * goes back to the machine's default java.
 */
export function updateProfile(
	cfg: ClusterConfig,
	name: string,
	patch: Partial<JavaProfile>,
): { changed: string[] } {
	const profile = getProfile(cfg, name);

	validateBody(patch);

	const changed: string[] = [];

	if (patch.java !== undefined) {
		profile.java = patch.java || undefined;
		changed.push("java");
	}

	if (patch.runtime !== undefined) {
		profile.runtime = patch.runtime || undefined;
		changed.push("runtime");
	}

	if (patch.flags !== undefined) {
		profile.flags = [...patch.flags];
		changed.push("flags");
	}

	if (patch.jarArgs !== undefined) {
		profile.jarArgs = patch.jarArgs.length ? [...patch.jarArgs] : undefined;
		changed.push("jarArgs");
	}

	return { changed };
}

/**
 * Rename a profile, moving every instance that launches from it. An instance's
 * `profile` is required and is looked up by name, so leaving one pointing at
 * the old name would make it unlaunchable.
 */
export function renameProfile(
	cfg: ClusterConfig,
	from: string,
	to: string,
): { updatedInstances: string[] } {
	const profile = getProfile(cfg, from);

	validateName(to);

	if (from === to) {
		return { updatedInstances: [] };
	}

	if (cfg.javaProfiles[to]) {
		throw new Error(t("core.profiles.exists", { name: to }));
	}

	cfg.javaProfiles[to] = profile;
	delete cfg.javaProfiles[from];

	const updated: string[] = [];

	for (const [name, inst] of Object.entries(allInstances(cfg))) {
		if (inst.profile === from) {
			inst.profile = to;
			updated.push(name);
		}
	}

	return { updatedInstances: updated.sort() };
}

/**
 * Delete a profile. Refused while an instance launches from it, and refused
 * when it is the last one: every instance names a profile, so a cluster with
 * none could not launch anything or create anything.
 */
export function removeProfile(cfg: ClusterConfig, name: string): void {
	getProfile(cfg, name);

	const used = profileConsumers(cfg, name);

	if (used.length > 0) {
		throw new Error(t("core.profiles.inUse", { name, instances: used.join(", ") }));
	}

	if (Object.keys(cfg.javaProfiles).length <= 1) {
		throw new Error(t("core.profiles.lastProfile", { name }));
	}

	delete cfg.javaProfiles[name];
}
