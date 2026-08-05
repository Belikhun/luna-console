/**
 * The editable server settings the CLI and the console both expose.
 *
 * `server.properties` has ~60 keys; this is the subset worth a form field, each
 * with the type, range and choices needed to validate an edit before it reaches
 * the file. The keys that wire velocity forwarding are listed too but marked
 * `managed`: they are shown read-only, because editing one silently breaks
 * player logins for the whole backend.
 */

import { join } from "node:path";

import type { ClusterConfig, InstanceConfig } from "./types";
import { t } from "../shared/i18n";
import { instanceDir, managedInstances } from "./config";
import { readProperties, upsertProperty } from "./confedit";
import type { ProgressReporter } from "./progress";

export type SettingType = "text" | "number" | "boolean" | "choice";

export type SettingGroup = "world" | "gameplay" | "players" | "performance" | "network";

export interface SettingSpec {
	/** server.properties key */
	key: string;
	/** i18n key of the human label; render with t() */
	label: string;
	group: SettingGroup;
	type: SettingType;
	/** i18n key of the explanatory hint; render with t() */
	hint?: string;
	/** for `choice`, in the order the picker offers them; labels are i18n keys */
	choices?: Array<{ value: string; label: string }>;
	min?: number;
	max?: number;
	/**
	 * Ask the UI for a slider instead of a number box. Only for a `number` whose
	 * whole range is worth dragging through: a value picked by feel between two
	 * meaningful ends. A range so wide that a pixel is worth thousands (max world
	 * size) or where the exact figure matters more than its position (max players)
	 * stays a number box.
	 */
	control?: "slider";
	/** granularity for a slider, and the increment a stepper offers */
	step?: number;
	/** appended to a slider's readout, e.g. " chunks" */
	unit?: string;
	/** what a fresh instance gets when the caller does not say */
	fallback: string;
	/** i18n key of why luna owns this key; set means "render read-only" */
	managed?: string;
}

/** Human labels for the groups, in display order. */
/** The groups' labels and hints are i18n keys; render them with t(). */
export const SETTING_GROUPS: Array<{ id: SettingGroup; label: string; hint: string }> = [
	{ id: "world", label: "core.settings.groups.world.label", hint: "core.settings.groups.world.hint" },
	{ id: "gameplay", label: "core.settings.groups.gameplay.label", hint: "core.settings.groups.gameplay.hint" },
	{ id: "players", label: "core.settings.groups.players.label", hint: "core.settings.groups.players.hint" },
	{ id: "performance", label: "core.settings.groups.performance.label", hint: "core.settings.groups.performance.hint" },
	{ id: "network", label: "core.settings.groups.network.label", hint: "core.settings.groups.network.hint" }
];

const DIFFICULTIES = ["peaceful", "easy", "normal", "hard"];

const GAMEMODES = ["survival", "creative", "adventure", "spectator"];

const LEVEL_TYPES = [
	{ value: "minecraft:normal", label: "core.settings.levelTypes.normal" },
	{ value: "minecraft:flat", label: "core.settings.levelTypes.superflat" },
	{ value: "minecraft:large_biomes", label: "core.settings.levelTypes.largeBiomes" },
	{ value: "minecraft:amplified", label: "core.settings.levelTypes.amplified" },
	{ value: "minecraft:single_biome_surface", label: "core.settings.levelTypes.singleBiome" }
];

/** Turn a bare value list into `choices`, using the value as its own label. */
function plainChoices(values: string[]): Array<{ value: string; label: string }> {
	return values.map((value) => ({ value, label: value }));
}

export const SERVER_SETTINGS: SettingSpec[] = [
	{
		key: "level-name",
		label: "core.settings.spec.level-name.label",
		group: "world",
		type: "text",
		hint: "core.settings.spec.level-name.hint",
		fallback: "world"
	},
	{
		key: "level-type",
		label: "core.settings.spec.level-type.label",
		group: "world",
		type: "choice",
		choices: LEVEL_TYPES,
		hint: "core.settings.spec.level-type.hint",
		fallback: "minecraft:normal"
	},
	{
		key: "level-seed",
		label: "core.settings.spec.level-seed.label",
		group: "world",
		type: "text",
		hint: "core.settings.spec.level-seed.hint",
		fallback: ""
	},
	{
		key: "difficulty",
		label: "core.settings.spec.difficulty.label",
		group: "world",
		type: "choice",
		choices: plainChoices(DIFFICULTIES),
		fallback: "normal"
	},
	{
		key: "hardcore",
		label: "core.settings.spec.hardcore.label",
		group: "world",
		type: "boolean",
		hint: "core.settings.spec.hardcore.hint",
		fallback: "false"
	},
	{
		key: "allow-nether",
		label: "core.settings.spec.allow-nether.label",
		group: "world",
		type: "boolean",
		fallback: "true"
	},
	{
		key: "generate-structures",
		label: "core.settings.spec.generate-structures.label",
		group: "world",
		type: "boolean",
		fallback: "true"
	},
	{
		key: "gamemode",
		label: "core.settings.spec.gamemode.label",
		group: "gameplay",
		type: "choice",
		choices: plainChoices(GAMEMODES),
		fallback: "survival"
	},
	{
		key: "force-gamemode",
		label: "core.settings.spec.force-gamemode.label",
		group: "gameplay",
		type: "boolean",
		hint: "core.settings.spec.force-gamemode.hint",
		fallback: "false"
	},
	{
		key: "pvp",
		label: "core.settings.spec.pvp.label",
		group: "gameplay",
		type: "boolean",
		fallback: "true"
	},
	{
		key: "spawn-monsters",
		label: "core.settings.spec.spawn-monsters.label",
		group: "gameplay",
		type: "boolean",
		fallback: "true"
	},
	{
		key: "spawn-animals",
		label: "core.settings.spec.spawn-animals.label",
		group: "gameplay",
		type: "boolean",
		fallback: "true"
	},
	{
		key: "spawn-npcs",
		label: "core.settings.spec.spawn-npcs.label",
		group: "gameplay",
		type: "boolean",
		fallback: "true"
	},
	{
		key: "allow-flight",
		label: "core.settings.spec.allow-flight.label",
		group: "gameplay",
		type: "boolean",
		hint: "core.settings.spec.allow-flight.hint",
		fallback: "true"
	},
	{
		key: "enable-command-block",
		label: "core.settings.spec.enable-command-block.label",
		group: "gameplay",
		type: "boolean",
		fallback: "false"
	},
	{
		key: "spawn-protection",
		label: "core.settings.spec.spawn-protection.label",
		group: "gameplay",
		type: "number",
		control: "slider",
		min: 0,
		max: 256,
		step: 8,
		unit: " blocks",
		hint: "core.settings.spec.spawn-protection.hint",
		fallback: "0"
	},
	{
		key: "max-players",
		label: "core.settings.spec.max-players.label",
		group: "players",
		type: "number",
		min: 1,
		max: 2000,
		hint: "core.settings.spec.max-players.hint",
		fallback: "64"
	},
	{
		key: "motd",
		label: "core.settings.spec.motd.label",
		group: "players",
		type: "text",
		hint: "core.settings.spec.motd.hint",
		fallback: "A Luna Minecraft Server"
	},
	{
		key: "white-list",
		label: "core.settings.spec.white-list.label",
		group: "players",
		type: "boolean",
		hint: "core.settings.spec.white-list.hint",
		fallback: "false"
	},
	{
		key: "enforce-whitelist",
		label: "core.settings.spec.enforce-whitelist.label",
		group: "players",
		type: "boolean",
		hint: "core.settings.spec.enforce-whitelist.hint",
		fallback: "false"
	},
	{
		key: "player-idle-timeout",
		label: "core.settings.spec.player-idle-timeout.label",
		group: "players",
		type: "number",
		min: 0,
		max: 1440,
		hint: "core.settings.spec.player-idle-timeout.hint",
		fallback: "0"
	},
	{
		key: "view-distance",
		label: "core.settings.spec.view-distance.label",
		group: "performance",
		type: "number",
		control: "slider",
		min: 3,
		max: 32,
		step: 1,
		unit: " chunks",
		hint: "core.settings.spec.view-distance.hint",
		fallback: "10"
	},
	{
		key: "simulation-distance",
		label: "core.settings.spec.simulation-distance.label",
		group: "performance",
		type: "number",
		control: "slider",
		min: 3,
		max: 32,
		step: 1,
		unit: " chunks",
		hint: "core.settings.spec.simulation-distance.hint",
		fallback: "10"
	},
	{
		key: "entity-broadcast-range-percentage",
		label: "core.settings.spec.entity-broadcast-range-percentage.label",
		group: "performance",
		type: "number",
		control: "slider",
		min: 10,
		max: 500,
		step: 10,
		unit: "%",
		hint: "core.settings.spec.entity-broadcast-range-percentage.hint",
		fallback: "100"
	},
	{
		key: "max-world-size",
		label: "core.settings.spec.max-world-size.label",
		group: "performance",
		type: "number",
		min: 1,
		max: 29_999_984,
		hint: "core.settings.spec.max-world-size.hint",
		fallback: "29999984"
	},
	{
		key: "server-ip",
		label: "core.settings.spec.server-ip.label",
		group: "network",
		type: "text",
		managed: "core.settings.spec.server-ip.managed",
		fallback: "127.0.0.1"
	},
	{
		key: "online-mode",
		label: "core.settings.spec.online-mode.label",
		group: "network",
		type: "boolean",
		managed: "core.settings.spec.online-mode.managed",
		fallback: "false"
	},
	{
		key: "enforce-secure-profile",
		label: "core.settings.spec.enforce-secure-profile.label",
		group: "network",
		type: "boolean",
		// Not a hard requirement of modern forwarding (lobby runs with it on and
		// players log in fine), but a new instance ships with it off, which is what
		// works for every client the proxy accepts.
		managed: "core.settings.spec.enforce-secure-profile.managed",
		fallback: "false"
	},
	{
		key: "prevent-proxy-connections",
		label: "core.settings.spec.prevent-proxy-connections.label",
		group: "network",
		type: "boolean",
		managed: "core.settings.spec.prevent-proxy-connections.managed",
		fallback: "false"
	}
];

/** Look up one spec by its server.properties key. */
export function settingSpec(key: string): SettingSpec | undefined {
	return SERVER_SETTINGS.find((spec) => spec.key === key);
}

/** Keys a caller is allowed to write, i.e. everything not managed by luna. */
export function editableSettingKeys(): string[] {
	return SERVER_SETTINGS.filter((spec) => !spec.managed).map((spec) => spec.key);
}

/**
 * Check a value against its spec. Returns the reason it was rejected, or
 * undefined when it is acceptable.
 */
export function validateSetting(spec: SettingSpec, value: string): string | undefined {
	if (spec.managed) {
		return t("core.settings.managedError", { key: spec.key, reason: t(spec.managed) });
	}

	switch (spec.type) {
		case "boolean": {
			if (value !== "true" && value !== "false") {
				return t("core.settings.mustBeBoolean", { key: spec.key });
			}

			return undefined;
		}

		case "number": {
			if (!/^-?\d+$/.test(value)) {
				return t("core.settings.mustBeNumber", { key: spec.key });
			}

			const numeric = Number(value);

			if (spec.min !== undefined && numeric < spec.min) {
				return t("core.settings.mustBeAtLeast", { key: spec.key, min: spec.min });
			}

			if (spec.max !== undefined && numeric > spec.max) {
				return t("core.settings.mustBeAtMost", { key: spec.key, max: spec.max });
			}

			return undefined;
		}

		case "choice": {
			const allowed = (spec.choices ?? []).map((choice) => choice.value);

			if (!allowed.includes(value)) {
				return t("core.settings.mustBeOneOf", { key: spec.key, allowed: allowed.join(", ") });
			}

			return undefined;
		}

		case "text": {
			// the value is written as one properties line, so it cannot carry a newline
			if (/[\r\n]/.test(value)) {
				return t("core.settings.mustBeSingleLine", { key: spec.key });
			}

			return undefined;
		}
	}
}

/**
 * Validate a whole batch without writing anything, for callers that must fail
 * before they start (instance creation) rather than report per-key afterwards.
 */
export function validateSettings(
	values: Record<string, string>,
): Array<{ key: string; error: string }> {
	const problems: Array<{ key: string; error: string }> = [];

	for (const [key, value] of Object.entries(values)) {
		const spec = settingSpec(key);

		if (!spec) {
			problems.push({ key, error: t("core.settings.notEditable", { key }) });

			continue;
		}

		const problem = validateSetting(spec, String(value));

		if (problem) {
			problems.push({ key, error: problem });
		}
	}

	return problems;
}

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

/** JVM flags luna sets from the instance's own fields, so a custom arg cannot restate them. */
const RESERVED_JAVA_FLAGS = ["-Xmx", "-Xms", "-jar"];

/**
 * Split a user-entered string into JVM arguments. Arguments are whitespace
 * separated; they end up on one line of the generated `run.sh`, so an argument
 * cannot contain a space anyway.
 */
export function parseJavaArgs(text: string): string[] {
	return text
		.split(/\s+/)
		.map((arg) => arg.trim())
		.filter((arg) => arg.length > 0);
}

/**
 * Check custom JVM arguments. They are interpolated into the generated `run.sh`
 * unquoted, so anything the shell would treat as syntax is rejected rather than
 * escaped: the field is for flags, not for shell.
 */
export function validateJavaArgs(args: string[]): string | undefined {
	for (const arg of args) {
		if (/[;&|<>$`(){}\\"'\s]/.test(arg)) {
			return t("core.settings.shellCharacters", { arg });
		}

		if (!arg.startsWith("-")) {
			return t("core.settings.notAFlag", { arg });
		}

		const reserved = RESERVED_JAVA_FLAGS.find((flag) => arg.startsWith(flag));

		if (reserved) {
			return t("core.settings.reservedFlag", { flag: reserved });
		}
	}

	return undefined;
}
