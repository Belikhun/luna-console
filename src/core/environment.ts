// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Environment manager (DESIGN.md §3.3); the SSM-Parameter-Store half of the
 * config-template design: named variables at the cluster root, optionally
 * secret, overridable per machine and per instance. Config templates reference
 * them as `${NAME}`; builtins are computed fresh at resolve time so a port or
 * version change never leaves a stale copy behind.
 *
 * Scopes narrow in one direction only; builtin < global < machine < instance -
 * so the value an instance sees is the most specific one defined for it. The
 * machine an instance belongs to is its `daemon` field (absent = the primary),
 * the same key the port ledger is scoped by, which is why resolution needs no
 * knowledge of which daemon happens to be running the call.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ClusterConfig, InstanceConfig } from "./types";
import { t } from "../shared/i18n";
import { managedInstances, notifySave, root, statePath } from "./config";
import { readForwardingSecret } from "./proxy";

const ENV_FILE = "environment.json";

export interface EnvVarDef {
	value: string;
	/** Masked in every UI and never returned by the read API */
	secret?: boolean;
	description?: string;
	/** ISO 8601 of the last change to this global value */
	updatedAt?: string;
}

/**
 * One recorded change to the environment. Values are deliberately **not** here:
 * the trail says a secret changed, never what it changed to, so the audit is not
 * itself a place secrets accumulate.
 */
export interface EnvChange {
	/** Epoch millis */
	t: number;
	action: "set" | "unset" | "reveal";
	name: string;
	scope: EnvScope;
	/** Machine key or instance name, for the scopes that have one */
	target?: string;
}

/** Recorded changes kept per store, oldest dropped first. */
export const MAX_HISTORY = 300;

export interface EnvironmentStore {
	variables: Record<string, EnvVarDef>;
	/** Per-machine overrides, daemon name → name → value ("" = the primary) */
	machines: Record<string, Record<string, string>>;
	/** Per-instance overrides, instance → name → value */
	instances: Record<string, Record<string, string>>;
	/**
	 * Append-only trail of changes, newest last. It lives in the store rather than
	 * the daemon's event log because that log is in-memory and capped; "when was
	 * this database password last changed" has to survive a daemon restart.
	 */
	history?: EnvChange[];
}

/** Where a variable's value is defined. Later scopes override earlier ones. */
export type EnvScope = "builtin" | "global" | "machine" | "instance";

/** Order of precedence, weakest first; the resolution order itself. */
export const ENV_SCOPES: EnvScope[] = ["builtin", "global", "machine", "instance"];

/**
 * The machine key an instance's overrides live under: its owning daemon, or `""`
 * for the primary; the same "absent `daemon` field" convention the port ledger
 * is scoped by (core/ports.ts). Reading it off the instance rather than the
 * running daemon is what lets the primary resolve a follower's values correctly.
 */
export function machineKeyOf(inst: InstanceConfig): string {
	return inst.daemon ?? "";
}

/** Variable names the store accepts; the substitution syntax only sees these. */
export const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Builtins whose value is a credential. They are computed rather than stored, so
 * no `secret` flag can be set on them; this list is what masks them anyway.
 */
export const BUILTIN_SECRETS = new Set(["LUNA_FORWARDING_SECRET"]);

/** Variables seeded when the store is first created. */
const SEED_VARIABLES: Record<string, EnvVarDef> = {
	LUNA_HTTP_PORT: {
		value: "32452",
		description: "Port of LunaCore's HTTP API on the proxy",
	},
};

function envPath(): string {
	return statePath(ENV_FILE);
}

/**
 * Where THIS machine reaches the velocity proxy. The proxy always runs on the
 * primary's host, so the default loopback is right there; a follower daemon
 * injects the primary's address at startup, because a config template applied
 * on a follower must point its instances across the LAN, not at themselves.
 */
let proxyHost = "127.0.0.1";

/** Injected by the daemon runtime (follower.ts); never called from core. */
export function setProxyHost(host: string): void {
	proxyHost = host;
}

/** Read the environment store, seeding the defaults on first use. */
export async function loadEnv(): Promise<EnvironmentStore> {
	if (!existsSync(envPath())) {
		return { variables: { ...SEED_VARIABLES }, machines: {}, instances: {}, history: [] };
	}

	const store: EnvironmentStore = await Bun.file(envPath()).json();

	store.variables ??= {};
	store.machines ??= {};
	store.instances ??= {};
	store.history ??= [];

	return store;
}

/**
 * Append a change to the store's trail, dropping the oldest past the cap. Callers
 * still have to `saveEnv`; this only updates the object, so a set that fails a
 * later validation leaves no trace of having happened.
 */
export function recordChange(store: EnvironmentStore, change: Omit<EnvChange, "t">): void {
	store.history ??= [];
	store.history.push({ t: Date.now(), ...change });

	if (store.history.length > MAX_HISTORY) {
		store.history = store.history.slice(-MAX_HISTORY);
	}
}

/** Persist the environment store, key-sorted to keep diffs small. */
export async function saveEnv(store: EnvironmentStore): Promise<void> {
	const sorted: EnvironmentStore = { variables: {}, machines: {}, instances: {} };

	for (const name of Object.keys(store.variables).sort()) {
		sorted.variables[name] = store.variables[name]!;
	}

	// an empty override map is noise in the file; the scope simply has none
	for (const machine of Object.keys(store.machines).sort()) {
		if (Object.keys(store.machines[machine]!).length) {
			sorted.machines[machine] = store.machines[machine]!;
		}
	}

	for (const inst of Object.keys(store.instances).sort()) {
		if (Object.keys(store.instances[inst]!).length) {
			sorted.instances[inst] = store.instances[inst]!;
		}
	}

	if (store.history?.length) {
		sorted.history = store.history.slice(-MAX_HISTORY);
	}

	await Bun.write(envPath(), JSON.stringify(sorted, null, "\t") + "\n");

	await notifySave("env", sorted);
}

/**
 * Which override map a scope writes into. The primary's machine key is `""`,
 * which is a legitimate target; hence the explicit `machine` opt rather than
 * treating a falsy name as "no scope given".
 */
export interface ScopeTarget {
	/** Daemon name whose override this is; `""` targets the primary */
	machine?: string;
	instance?: string;
}

/** Set a variable at one scope: global by default, else a machine or an instance. */
export function setVariable(
	store: EnvironmentStore,
	name: string,
	value: string,
	opts: ScopeTarget & { secret?: boolean; description?: string } = {},
): void {
	if (!ENV_NAME_PATTERN.test(name)) {
		throw new Error(t("core.configfiles.badVarName"));
	}

	if (name.startsWith("LUNA_")) {
		throw new Error(t("core.environment.lunaComputed"));
	}

	if (opts.instance !== undefined && opts.machine !== undefined) {
		throw new Error(t("core.configfiles.scopeConflict"));
	}

	if (opts.instance !== undefined) {
		store.instances[opts.instance] ??= {};
		store.instances[opts.instance]![name] = value;

		recordChange(store, { action: "set", name, scope: "instance", target: opts.instance });

		return;
	}

	if (opts.machine !== undefined) {
		store.machines[opts.machine] ??= {};
		store.machines[opts.machine]![name] = value;

		recordChange(store, { action: "set", name, scope: "machine", target: opts.machine });

		return;
	}

	const existing = store.variables[name];

	store.variables[name] = {
		value,
		...(opts.secret ?? existing?.secret ? { secret: true } : {}),
		...((opts.description ?? existing?.description)
			? { description: opts.description ?? existing?.description }
			: {}),
		updatedAt: new Date().toISOString(),
	};

	recordChange(store, { action: "set", name, scope: "global" });
}

/** Remove a variable at one scope. Returns false when it was not set there. */
export function unsetVariable(
	store: EnvironmentStore,
	name: string,
	scope: ScopeTarget = {},
): boolean {
	if (scope.instance !== undefined) {
		if (store.instances[scope.instance]?.[name] === undefined) {
			return false;
		}

		delete store.instances[scope.instance]![name];
		recordChange(store, { action: "unset", name, scope: "instance", target: scope.instance });

		return true;
	}

	if (scope.machine !== undefined) {
		if (store.machines[scope.machine]?.[name] === undefined) {
			return false;
		}

		delete store.machines[scope.machine]![name];
		recordChange(store, { action: "unset", name, scope: "machine", target: scope.machine });

		return true;
	}

	if (store.variables[name] === undefined) {
		return false;
	}

	delete store.variables[name];
	recordChange(store, { action: "unset", name, scope: "global" });

	return true;
}

/**
 * Read a secret's real value and record that it was read.
 *
 * The console withholds secret values from every listing, so revealing one is a
 * deliberate act worth a trail entry; that is the whole reason this is a
 * function and not just a field the read API stops masking. The CLI needs no
 * equivalent: a shell that can talk to the daemon socket already has the store.
 *
 * The caller must `saveEnv` for the record to persist.
 */
export function revealVariable(
	store: EnvironmentStore,
	name: string,
	scope: ScopeTarget = {},
): { value: string; scope: EnvScope; target?: string } {
	if (scope.instance !== undefined) {
		const value = store.instances[scope.instance]?.[name];

		if (value === undefined) {
			throw new Error(t("core.environment.notSetInstance", { name, instance: scope.instance ?? "" }));
		}

		recordChange(store, { action: "reveal", name, scope: "instance", target: scope.instance });

		return { value, scope: "instance", target: scope.instance };
	}

	if (scope.machine !== undefined) {
		const value = store.machines[scope.machine]?.[name];

		if (value === undefined) {
			throw new Error(t("core.environment.notSetMachine", { name, machine: scope.machine || "(primary)" }));
		}

		recordChange(store, { action: "reveal", name, scope: "machine", target: scope.machine });

		return { value, scope: "machine", target: scope.machine };
	}

	const def = store.variables[name];

	if (!def) {
		throw new Error(t("core.environment.notDefined", { name }));
	}

	recordChange(store, { action: "reveal", name, scope: "global" });

	return { value: def.value, scope: "global" };
}

/**
 * Reveal a secret and persist the record of it, in one step the daemon owns.
 *
 * `revealVariable` is the pure half and mutates the store it is handed, which
 * cannot survive a trip over the RPC bridge; so this is the entry point every
 * client uses, and the store is loaded and saved on the side that holds it.
 */
export async function revealAndRecord(
	name: string,
	scope: ScopeTarget = {},
): Promise<{ value: string; scope: EnvScope; target?: string }> {
	const store = await loadEnv();
	const revealed = revealVariable(store, name, scope);

	await saveEnv(store);

	return revealed;
}

/** Every scope that defines `name`, weakest first; the variable seen as an object. */
export function scopesOf(
	store: EnvironmentStore,
	name: string,
): Array<{ scope: EnvScope; target?: string; value: string }> {
	const out: Array<{ scope: EnvScope; target?: string; value: string }> = [];
	const def = store.variables[name];

	if (def) {
		out.push({ scope: "global", value: def.value });
	}

	for (const machine of Object.keys(store.machines).sort()) {
		const value = store.machines[machine]![name];

		if (value !== undefined) {
			out.push({ scope: "machine", target: machine, value });
		}
	}

	for (const instance of Object.keys(store.instances).sort()) {
		const value = store.instances[instance]![name];

		if (value !== undefined) {
			out.push({ scope: "instance", target: instance, value });
		}
	}

	return out;
}

/** Drop every override scoped to one instance. Returns true when any existed. */
export function unsetInstanceScope(store: EnvironmentStore, instance: string): boolean {
	if (!store.instances[instance]) {
		return false;
	}

	delete store.instances[instance];

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
		throw new Error(t("core.instances.unknown", { name: instance }));
	}

	return {
		LUNA_INSTANCE: instance,
		LUNA_PORT: String(inst.port),
		LUNA_MEMORY: inst.memory,
		LUNA_MC_VERSION: inst.mcVersion ?? "",
		LUNA_SOFTWARE: inst.software,
		LUNA_DIR: inst.dir,
		LUNA_ROOT: root(),
		LUNA_PROXY_HOST: proxyHost,
		LUNA_PROXY_PORT: String(cfg.proxy.port),
		LUNA_FORWARDING_SECRET: await readForwardingSecret(cfg),
	};
}

/** Full variable map for an instance: builtin < global < machine < instance. */
export async function resolveVars(
	cfg: ClusterConfig,
	store: EnvironmentStore,
	instance: string,
): Promise<Record<string, string>> {
	const resolved = await resolveDetailed(cfg, store, instance);
	const vars: Record<string, string> = {};

	for (const entry of resolved) {
		vars[entry.name] = entry.value;
	}

	return vars;
}

/** One variable as an instance sees it, with the scope that won and what it shadowed. */
export interface ResolvedVar {
	name: string;
	value: string;
	/** Scope the winning value came from */
	scope: EnvScope;
	/** True when the name is defined as secret globally; masked at every scope */
	secret: boolean;
	description?: string;
	/** Values this one overrides, weakest first */
	shadowed: Array<{ scope: EnvScope; value: string }>;
}

/**
 * Every variable an instance resolves, carrying where each value came from.
 * This is what lets the console show "DB_HOST; machine override on infdun,
 * shadowing the global value" instead of a flat map that hides the layering.
 */
export async function resolveDetailed(
	cfg: ClusterConfig,
	store: EnvironmentStore,
	instance: string,
): Promise<ResolvedVar[]> {
	return layerScopes(cfg, store, instance, await builtinVars(cfg, instance));
}

/**
 * The layering itself, over builtins the caller already has.
 *
 * Split out because it is **pure**: the store is byte-identical on every machine
 * (the primary is its single writer and every follower mirrors it), so only the
 * builtins are machine-dependent. That lets the client bridge fetch just the
 * builtins from the instance's own daemon; an op that has existed since the
 * first release; and do the layering locally, instead of depending on a newer
 * op existing on a follower that has not been upgraded yet.
 */
export function layerScopes(
	cfg: ClusterConfig,
	store: EnvironmentStore,
	instance: string,
	builtins: Record<string, string>,
): ResolvedVar[] {
	const inst = managedInstances(cfg)[instance];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name: instance }));
	}

	const layers: Array<{ scope: EnvScope; vars: Record<string, string> }> = [
		{ scope: "builtin", vars: builtins },
		{
			scope: "global",
			vars: Object.fromEntries(
				Object.entries(store.variables).map(([name, def]) => [name, def.value]),
			),
		},
		{ scope: "machine", vars: store.machines[machineKeyOf(inst)] ?? {} },
		{ scope: "instance", vars: store.instances[instance] ?? {} },
	];

	const byName = new Map<string, ResolvedVar>();

	for (const layer of layers) {
		for (const [name, value] of Object.entries(layer.vars)) {
			const existing = byName.get(name);

			if (!existing) {
				byName.set(name, {
					name,
					value,
					scope: layer.scope,
					secret: !!store.variables[name]?.secret || BUILTIN_SECRETS.has(name),
					...(store.variables[name]?.description
						? { description: store.variables[name]!.description }
						: {}),
					shadowed: [],
				});

				continue;
			}

			existing.shadowed.push({ scope: existing.scope, value: existing.value });
			existing.value = value;
			existing.scope = layer.scope;
		}
	}

	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Generated per-instance environment file, sourced by `run.sh` before the JVM
 * starts. It lives beside the run script inside the instance directory, is
 * rewritten from the store on every start, and carries secrets; hence 0600.
 */
export const ENV_SCRIPT = ".luna-env";

/**
 * Quote a value as a POSIX single-quoted string. Everything is literal inside
 * single quotes except the quote itself, which is closed, escaped and reopened -
 * so an env value can hold `$`, backticks, spaces or newlines without the shell
 * ever interpreting them.
 */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The env file's body: one `export` per variable, sorted so a regenerated file
 * only differs when a value really changed. Builtins are included, which is what
 * lets a start script or a plugin read `LUNA_PORT` without luna templating it in.
 */
export function renderEnvFile(vars: Record<string, string>): string {
	const lines = [
		"# Generated by luna. Do not edit; it is rewritten on every start.",
		"# Sourced by run.sh, so every variable reaches the server JVM.",
		"",
	];

	for (const name of Object.keys(vars).sort()) {
		lines.push(`export ${name}=${shellQuote(vars[name]!)}`);
	}

	return lines.join("\n") + "\n";
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
