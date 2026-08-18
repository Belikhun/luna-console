// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Reading and writing an instance's server.properties, against the schema.
 *
 * Separate from `settings.ts` because these two functions are the only part of
 * it that touches a disk, and that difference decides who may import what. The
 * schema is imported by a Svelte component (the configuration tab renders
 * `SERVER_SETTINGS` directly), and a module reaching `core/config` drags
 * `node:fs` into the browser bundle, where Vite externalises it and the page
 * dies at hydration. Production hides it because rollup tree-shakes the unused
 * export away, so this only ever showed up under `luna web --dev`.
 *
 * The dependency therefore points this way and never back: this module knows
 * about the schema, the schema knows nothing about files.
 */

import { join } from "node:path";

import type { ClusterConfig, InstanceConfig } from "./types";
import { t } from "../shared/i18n";
import { instanceDir, managedInstances } from "./config";
import { deleteProperty, readProperties, upsertProperty } from "./confedit";
import type { ProgressReporter } from "./progress";
import { settingSpec, validateSetting } from "./settings";

/** Absolute path of an instance's server.properties. */
function propertiesPath(inst: InstanceConfig): string {
	return join(instanceDir(inst), "server.properties");
}

/** Every key/value pair in an instance's server.properties. */
export async function readServerProperties(
	cfg: ClusterConfig,
	name: string,
): Promise<Record<string, string>> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name }));
	}

	return await readProperties(propertiesPath(inst));
}

// what readProperties can round-trip; anything else would never parse back
const PROPERTY_KEY = /^[A-Za-z0-9._-]+$/;

export interface RawPropertyResult {
	key: string;
	from?: string;
	to: string;
	/** false when the file already held exactly this value */
	changed: boolean;
	/** the line was added because the file had no such key yet */
	appended: boolean;
}

/**
 * Write one raw server.properties key, spec'd or not; the escape hatch behind
 * the configuration tab's properties table and the only path that may *add* a
 * key the schema does not know.
 *
 * The schema still has the last word where it has one: a value with a spec is
 * validated against it, and a managed key is refused outright, because a raw
 * path around that guard would break the same velocity logins the guard
 * exists for. The value lands Java-escaped through `upsertProperty`.
 */
export async function setRawProperty(
	cfg: ClusterConfig,
	name: string,
	key: string,
	value: string,
): Promise<RawPropertyResult> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name }));
	}

	if (!PROPERTY_KEY.test(key)) {
		throw new Error(t("core.settings.badKey", { key }));
	}

	if (/[\r\n]/.test(value)) {
		throw new Error(t("core.settings.mustBeSingleLine", { key }));
	}

	const spec = settingSpec(key);

	if (spec) {
		const problem = validateSetting(spec, value);

		if (problem) {
			throw new Error(problem);
		}
	}

	const path = propertiesPath(inst);
	const current = await readProperties(path);

	if (current[key] === value) {
		return { key, from: current[key], to: value, changed: false, appended: false };
	}

	const outcome = await upsertProperty(path, key, value);

	return {
		key,
		from: current[key],
		to: value,
		changed: true,
		appended: outcome === "appended",
	};
}

/**
 * Remove one raw key's line from server.properties. A managed key is refused
 * with the same reason writing one is; anything else is fine to drop, the
 * server just boots with its own default. Returns the removed value, or an
 * `existed: false` result when the file had no such line.
 */
export async function deleteRawProperty(
	cfg: ClusterConfig,
	name: string,
	key: string,
): Promise<{ key: string; existed: boolean; removed?: string }> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name }));
	}

	if (!PROPERTY_KEY.test(key)) {
		throw new Error(t("core.settings.badKey", { key }));
	}

	const spec = settingSpec(key);

	if (spec?.managed) {
		throw new Error(t("core.settings.managedError", { key, reason: t(spec.managed) }));
	}

	const removed = await deleteProperty(propertiesPath(inst), key);

	return { key, existed: removed !== undefined, removed };
}

export interface SettingChange {
	key: string;
	from?: string;
	to: string;
	/** the line was added because the file had no such key yet */
	appended: boolean;
}

export interface ApplySettingsResult {
	changed: SettingChange[];
	/** values that failed validation, or keys with no spec */
	rejected: Array<{ key: string; error: string }>;
	/** already had the requested value */
	unchanged: string[];
}

/**
 * Write a batch of settings into an instance's server.properties, validating
 * each against its spec first. Values equal to what is already on disk are
 * skipped, so the result says exactly what the call touched. A rejected value
 * never blocks the rest of the batch; the caller reports both lists.
 */
export async function applySettings(
	cfg: ClusterConfig,
	name: string,
	values: Record<string, string>,
	reporter?: ProgressReporter,
): Promise<ApplySettingsResult> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name }));
	}

	const path = propertiesPath(inst);
	const current = await readProperties(path);

	const result: ApplySettingsResult = { changed: [], rejected: [], unchanged: [] };
	const entries = Object.entries(values);
	let done = 0;

	for (const [key, raw] of entries) {
		const spec = settingSpec(key);
		const value = String(raw);

		done += 1;

		const progress = done / Math.max(1, entries.length);

		if (!spec) {
			result.rejected.push({ key, error: t("core.settings.notEditable", { key }) });
			reporter?.warn(progress, t("core.settings.skipped", { key }));

			continue;
		}

		const problem = validateSetting(spec, value);

		if (problem) {
			result.rejected.push({ key, error: problem });
			reporter?.warn(progress, problem);

			continue;
		}

		if (current[key] === value) {
			result.unchanged.push(key);
			reporter?.info(progress, t("core.settings.alreadyValue", { key, value }));

			continue;
		}

		const outcome = await upsertProperty(path, key, value);

		result.changed.push({
			key,
			from: current[key],
			to: value,
			appended: outcome === "appended"
		});

		reporter?.okay(progress, `${key} = ${value || "(blank)"}`);
	}

	return result;
}
