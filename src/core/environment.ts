/**
 * Environment manager (DESIGN.md §3.3) — the SSM-Parameter-Store half of the
 * config-template design: named variables at the cluster root, optionally
 * secret, with per-instance overrides. Config templates reference them as
 * `${NAME}`; builtins are computed fresh at resolve time so a port or version
 * change never leaves a stale copy behind.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ClusterConfig } from "./types";
import { managedInstances, root } from "./config";
import { readForwardingSecret } from "./proxy";

const ENV_FILE = "environment.json";

export interface EnvVarDef {
	value: string;
	/** Masked in every UI and never returned by the read API */
	secret?: boolean;
	description?: string;
}

export interface EnvironmentStore {
	variables: Record<string, EnvVarDef>;
	/** Per-instance overrides, instance → name → value */
	instances: Record<string, Record<string, string>>;
}

/** Variable names the store accepts — the substitution syntax only sees these. */
export const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** Variables seeded when the store is first created. */
const SEED_VARIABLES: Record<string, EnvVarDef> = {
	LUNA_HTTP_PORT: {
		value: "32452",
		description: "Port of LunaCore's HTTP API on the proxy",
	},
};

function envPath(): string {
	return join(root(), ENV_FILE);
}

/** Read the environment store, seeding the defaults on first use. */
export async function loadEnv(): Promise<EnvironmentStore> {
	if (!existsSync(envPath())) {
		return { variables: { ...SEED_VARIABLES }, instances: {} };
	}

	const store: EnvironmentStore = await Bun.file(envPath()).json();

	store.variables ??= {};
	store.instances ??= {};

	return store;
}

/** Persist the environment store, key-sorted to keep diffs small. */
export async function saveEnv(store: EnvironmentStore): Promise<void> {
	const sorted: EnvironmentStore = { variables: {}, instances: {} };

	for (const name of Object.keys(store.variables).sort()) {
		sorted.variables[name] = store.variables[name]!;
	}

	for (const inst of Object.keys(store.instances).sort()) {
		if (Object.keys(store.instances[inst]!).length) {
			sorted.instances[inst] = store.instances[inst]!;
		}
	}

	await Bun.write(envPath(), JSON.stringify(sorted, null, "\t") + "\n");
}

/** Set a variable (global, or one instance's override). */
export function setVariable(
	store: EnvironmentStore,
	name: string,
	value: string,
	opts: { secret?: boolean; description?: string; instance?: string } = {},
): void {
	if (!ENV_NAME_PATTERN.test(name)) {
		throw new Error("variable names are ALL_UPPERCASE_WITH_UNDERSCORES");
	}

	if (name.startsWith("LUNA_")) {
		throw new Error("LUNA_* names are builtin — they are computed, not stored");
	}

	if (opts.instance) {
		store.instances[opts.instance] ??= {};
		store.instances[opts.instance]![name] = value;

		return;
	}

	const existing = store.variables[name];

	store.variables[name] = {
		value,
		...(opts.secret ?? existing?.secret ? { secret: true } : {}),
		...((opts.description ?? existing?.description)
			? { description: opts.description ?? existing?.description }
			: {}),
	};
}

/** Remove a variable (global, or one instance's override). */
export function unsetVariable(
	store: EnvironmentStore,
	name: string,
	instance?: string,
): boolean {
	if (instance) {
		if (store.instances[instance]?.[name] === undefined) {
			return false;
		}

		delete store.instances[instance]![name];

		return true;
	}

	if (store.variables[name] === undefined) {
		return false;
	}

	delete store.variables[name];

	return true;
}

/**
 * Builtin variables for one instance, computed at call time. These are what
 * lets a template say "point at the proxy" without anyone hardcoding a port.
 */
export async function builtinVars(
	cfg: ClusterConfig,
	instance: string,
): Promise<Record<string, string>> {
	const inst = managedInstances(cfg)[instance];

	if (!inst) {
		throw new Error(`unknown instance: ${instance}`);
	}

	return {
		LUNA_INSTANCE: instance,
		LUNA_PORT: String(inst.port),
		LUNA_MEMORY: inst.memory,
		LUNA_MC_VERSION: inst.mcVersion ?? "",
		LUNA_SOFTWARE: inst.software,
		LUNA_DIR: inst.dir,
		LUNA_ROOT: root(),
		LUNA_PROXY_HOST: "127.0.0.1",
		LUNA_PROXY_PORT: String(cfg.proxy.port),
		LUNA_FORWARDING_SECRET: await readForwardingSecret(cfg),
	};
}

/** Full variable map for an instance: builtin < global < per-instance override. */
export async function resolveVars(
	cfg: ClusterConfig,
	store: EnvironmentStore,
	instance: string,
): Promise<Record<string, string>> {
	const vars = await builtinVars(cfg, instance);

	for (const [name, def] of Object.entries(store.variables)) {
		vars[name] = def.value;
	}

	for (const [name, value] of Object.entries(store.instances[instance] ?? {})) {
		vars[name] = value;
	}

	return vars;
}

/**
 * Substitute `${NAME}` references. Unknown names are collected rather than
 * left in place, so a caller can refuse to write a half-resolved value.
 */
export function substitute(
	text: string,
	vars: Record<string, string>,
): { text: string; missing: string[] } {
	const missing: string[] = [];

	const out = text.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (token, name: string) => {
		if (vars[name] === undefined) {
			missing.push(name);

			return token;
		}

		return vars[name];
	});

	return { text: out, missing: [...new Set(missing)] };
}
