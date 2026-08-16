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
import { readProperties, upsertProperty } from "./confedit";
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
