/**
 * The editable server settings the CLI and the console both expose.
 *
 * `server.properties` has ~60 keys; this is the subset worth a form field, each
 * with the type, range and choices needed to validate an edit before it reaches
 * the file. The keys that wire velocity forwarding are listed too but marked
 * `managed` — they are shown read-only, because editing one silently breaks
 * player logins for the whole backend.
 */

import { join } from "node:path";

import type { ClusterConfig, InstanceConfig } from "./types";
import { instanceDir, managedInstances } from "./config";
import { readProperties, upsertProperty } from "./confedit";
import type { ProgressReporter } from "./progress";

export type SettingType = "text" | "number" | "boolean" | "choice";

export type SettingGroup = "world" | "gameplay" | "players" | "performance" | "network";

export interface SettingSpec {
	/** server.properties key */
	key: string;
	label: string;
	group: SettingGroup;
	type: SettingType;
	hint?: string;
	/** for `choice`, in the order the picker offers them */
	choices?: Array<{ value: string; label: string }>;
	min?: number;
	max?: number;
	/**
	 * Ask the UI for a slider instead of a number box. Only for a `number` whose
	 * whole range is worth dragging through — a value picked by feel between two
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
	/** why mrds owns this key — set means "render read-only" */
	managed?: string;
}

/** Human labels for the groups, in display order. */
export const SETTING_GROUPS: Array<{ id: SettingGroup; label: string; hint: string }> = [
	{ id: "world", label: "World", hint: "Applied when the world is generated or loaded" },
	{ id: "gameplay", label: "Gameplay", hint: "Rules the server enforces while players are on" },
	{ id: "players", label: "Players", hint: "Capacity, access and how the server presents itself" },
	{
		id: "performance",
		label: "Performance",
		hint: "Cost per player and per chunk — raise these carefully"
	},
	{ id: "network", label: "Network", hint: "Owned by mrds so velocity forwarding keeps working" }
];

const DIFFICULTIES = ["peaceful", "easy", "normal", "hard"];

const GAMEMODES = ["survival", "creative", "adventure", "spectator"];

const LEVEL_TYPES = [
	{ value: "minecraft:normal", label: "normal" },
	{ value: "minecraft:flat", label: "superflat" },
	{ value: "minecraft:large_biomes", label: "large biomes" },
	{ value: "minecraft:amplified", label: "amplified" },
	{ value: "minecraft:single_biome_surface", label: "single biome" }
];

/** Turn a bare value list into `choices`, using the value as its own label. */
function plainChoices(values: string[]): Array<{ value: string; label: string }> {
	return values.map((value) => ({ value, label: value }));
}

export const SERVER_SETTINGS: SettingSpec[] = [
	{
		key: "level-name",
		label: "Level name",
		group: "world",
		type: "text",
		hint: "World directory inside the instance — renaming it starts a new world",
		fallback: "world"
	},
	{
		key: "level-type",
		label: "Level type",
		group: "world",
		type: "choice",
		choices: LEVEL_TYPES,
		hint: "Only affects chunks generated from now on",
		fallback: "minecraft:normal"
	},
	{
		key: "level-seed",
		label: "Level seed",
		group: "world",
		type: "text",
		hint: "Blank picks a random seed on first generation",
		fallback: ""
	},
	{
		key: "difficulty",
		label: "Difficulty",
		group: "world",
		type: "choice",
		choices: plainChoices(DIFFICULTIES),
		fallback: "normal"
	},
	{
		key: "hardcore",
		label: "Hardcore",
		group: "world",
		type: "boolean",
		hint: "Death is permanent and difficulty is locked to hard",
		fallback: "false"
	},
	{
		key: "allow-nether",
		label: "Allow nether",
		group: "world",
		type: "boolean",
		fallback: "true"
	},
	{
		key: "generate-structures",
		label: "Generate structures",
		group: "world",
		type: "boolean",
		fallback: "true"
	},
	{
		key: "gamemode",
		label: "Default gamemode",
		group: "gameplay",
		type: "choice",
		choices: plainChoices(GAMEMODES),
		fallback: "survival"
	},
	{
		key: "force-gamemode",
		label: "Force gamemode",
		group: "gameplay",
		type: "boolean",
		hint: "Put players back into the default gamemode on every join",
		fallback: "false"
	},
	{
		key: "pvp",
		label: "PvP",
		group: "gameplay",
		type: "boolean",
		fallback: "true"
	},
	{
		key: "spawn-monsters",
		label: "Spawn monsters",
		group: "gameplay",
		type: "boolean",
		fallback: "true"
	},
	{
		key: "spawn-animals",
		label: "Spawn animals",
		group: "gameplay",
		type: "boolean",
		fallback: "true"
	},
	{
		key: "spawn-npcs",
		label: "Spawn villagers",
		group: "gameplay",
		type: "boolean",
		fallback: "true"
	},
	{
		key: "allow-flight",
		label: "Allow flight",
		group: "gameplay",
		type: "boolean",
		hint: "Without this, survival-mode flight from a mod or plugin gets players kicked",
		fallback: "true"
	},
	{
		key: "enable-command-block",
		label: "Command blocks",
		group: "gameplay",
		type: "boolean",
		fallback: "false"
	},
	{
		key: "spawn-protection",
		label: "Spawn protection",
		group: "gameplay",
		type: "number",
		control: "slider",
		min: 0,
		max: 256,
		step: 8,
		unit: " blocks",
		hint: "Radius non-ops cannot build in; 0 disables it",
		fallback: "0"
	},
	{
		key: "max-players",
		label: "Max players",
		group: "players",
		type: "number",
		min: 1,
		max: 2000,
		hint: "The proxy enforces its own limit too — this one is per backend",
		fallback: "64"
	},
	{
		key: "motd",
		label: "MOTD",
		group: "players",
		type: "text",
		hint: "Server-list description; behind the proxy only direct connections see it",
		fallback: "A Luna Minecraft Server"
	},
	{
		key: "white-list",
		label: "Whitelist",
		group: "players",
		type: "boolean",
		hint: "Only whitelisted players may join",
		fallback: "false"
	},
	{
		key: "enforce-whitelist",
		label: "Enforce whitelist",
		group: "players",
		type: "boolean",
		hint: "Also kick players already online when they are not on the list",
		fallback: "false"
	},
	{
		key: "player-idle-timeout",
		label: "Idle timeout",
		group: "players",
		type: "number",
		min: 0,
		max: 1440,
		hint: "Minutes before an idle player is kicked; 0 never kicks",
		fallback: "0"
	},
	{
		key: "view-distance",
		label: "View distance",
		group: "performance",
		type: "number",
		control: "slider",
		min: 3,
		max: 32,
		step: 1,
		unit: " chunks",
		hint: "Chunks sent to each player — the single biggest cost per player",
		fallback: "10"
	},
	{
		key: "simulation-distance",
		label: "Simulation distance",
		group: "performance",
		type: "number",
		control: "slider",
		min: 3,
		max: 32,
		step: 1,
		unit: " chunks",
		hint: "Chunks that keep ticking around each player",
		fallback: "10"
	},
	{
		key: "entity-broadcast-range-percentage",
		label: "Entity broadcast range",
		group: "performance",
		type: "number",
		control: "slider",
		min: 10,
		max: 500,
		step: 10,
		unit: "%",
		hint: "Percentage of the default distance at which entities are sent to clients",
		fallback: "100"
	},
	{
		key: "max-world-size",
		label: "Max world size",
		group: "performance",
		type: "number",
		min: 1,
		max: 29_999_984,
		hint: "World border limit in blocks",
		fallback: "29999984"
	},
	{
		key: "server-ip",
		label: "Bind address",
		group: "network",
		type: "text",
		managed:
			"the proxy is the public entrypoint — backends on this host bind to loopback, " +
			"backends on a follower daemon bind to 0.0.0.0 so the proxy can reach them",
		fallback: "127.0.0.1"
	},
	{
		key: "online-mode",
		label: "Online mode",
		group: "network",
		type: "boolean",
		managed: "velocity authenticates players and forwards their identity",
		fallback: "false"
	},
	{
		key: "enforce-secure-profile",
		label: "Enforce secure profile",
		group: "network",
		type: "boolean",
		// Not a hard requirement of modern forwarding — lobby runs with it on and
		// players log in fine — but a new instance ships with it off, which is what
		// works for every client the proxy accepts.
		managed: "off on instances mrds creates; existing servers keep their own setting",
		fallback: "false"
	},
	{
		key: "prevent-proxy-connections",
		label: "Prevent proxy connections",
		group: "network",
		type: "boolean",
		managed: "every connection arrives through velocity by design",
		fallback: "false"
	}
];

/** Look up one spec by its server.properties key. */
export function settingSpec(key: string): SettingSpec | undefined {
	return SERVER_SETTINGS.find((spec) => spec.key === key);
}

/** Keys a caller is allowed to write, i.e. everything not managed by mrds. */
export function editableSettingKeys(): string[] {
	return SERVER_SETTINGS.filter((spec) => !spec.managed).map((spec) => spec.key);
}

/**
 * Check a value against its spec. Returns the reason it was rejected, or
 * undefined when it is acceptable.
 */
export function validateSetting(spec: SettingSpec, value: string): string | undefined {
	if (spec.managed) {
		return `${spec.key} is managed by mrds (${spec.managed})`;
	}

	switch (spec.type) {
		case "boolean": {
			if (value !== "true" && value !== "false") {
				return `${spec.key} must be true or false`;
			}

			return undefined;
		}

		case "number": {
			if (!/^-?\d+$/.test(value)) {
				return `${spec.key} must be a whole number`;
			}

			const numeric = Number(value);

			if (spec.min !== undefined && numeric < spec.min) {
				return `${spec.key} must be at least ${spec.min}`;
			}

			if (spec.max !== undefined && numeric > spec.max) {
				return `${spec.key} must be at most ${spec.max}`;
			}

			return undefined;
		}

		case "choice": {
			const allowed = (spec.choices ?? []).map((choice) => choice.value);

			if (!allowed.includes(value)) {
				return `${spec.key} must be one of: ${allowed.join(", ")}`;
			}

			return undefined;
		}

		case "text": {
			// the value is written as one properties line, so it cannot carry a newline
			if (/[\r\n]/.test(value)) {
				return `${spec.key} must be a single line`;
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
			problems.push({ key, error: `${key} is not an editable server setting` });

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
		throw new Error(`unknown instance: ${name}`);
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
 * never blocks the rest of the batch — the caller reports both lists.
 */
export async function applySettings(
	cfg: ClusterConfig,
	name: string,
	values: Record<string, string>,
	reporter?: ProgressReporter,
): Promise<ApplySettingsResult> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(`unknown instance: ${name}`);
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
			result.rejected.push({ key, error: `${key} is not an editable server setting` });
			reporter?.warn(progress, `skipped ${key}`);

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
			reporter?.info(progress, `${key} already ${value}`);

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

/** JVM flags mrds sets from the instance's own fields, so a custom arg cannot restate them. */
const RESERVED_JAVA_FLAGS = ["-Xmx", "-Xms", "-jar"];

/**
 * Split a user-entered string into JVM arguments. Arguments are whitespace
 * separated — they end up on one line of the generated `run.sh`, so an argument
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
 * escaped — the field is for flags, not for shell.
 */
export function validateJavaArgs(args: string[]): string | undefined {
	for (const arg of args) {
		if (/[;&|<>$`(){}\\"'\s]/.test(arg)) {
			return `"${arg}" contains characters the shell would interpret — flags only`;
		}

		if (!arg.startsWith("-")) {
			return `"${arg}" is not a flag (JVM arguments start with -)`;
		}

		const reserved = RESERVED_JAVA_FLAGS.find((flag) => arg.startsWith(flag));

		if (reserved) {
			return `${reserved} is set by mrds from the instance's own memory setting`;
		}
	}

	return undefined;
}
