import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { ClusterConfig, InstanceConfig, PluginFamily, PluginsLock, Software } from "./types";

/**
 * Locate the cluster root: the nearest ancestor of the working directory that
 * holds a `cluster.json`, or the directory containing this tool. Bails out of
 * the process when neither exists — nothing else in `core/` can run without it.
 */
function findRoot(): string {
	if (process.env.LUNA_ROOT) {
		return resolve(process.env.LUNA_ROOT);
	}

	let dir = process.cwd();

	while (true) {
		if (existsSync(join(dir, "cluster.json"))) {
			return dir;
		}

		const parent = dirname(dir);

		if (parent === dir) {
			break;
		}

		dir = parent;
	}

	const toolRoot = resolve(import.meta.dir, "..", "..");

	if (existsSync(join(toolRoot, "cluster.json"))) {
		return toolRoot;
	}

	console.error("error: cluster.json not found (set LUNA_ROOT or run inside the cluster directory)");
	process.exit(1);
}

let cachedRoot: string | undefined;

/** Absolute path of the cluster root, resolved once per process. */
export function root(): string {
	return (cachedRoot ??= findRoot());
}

/** Path of the instance registry — the source of truth for the cluster. */
export function clusterPath(): string {
	return join(root(), "cluster.json");
}

/** Path of the plugin lockfile — the source of truth for plugin versions. */
export function lockPath(): string {
	return join(root(), "plugins.lock.json");
}

/** Path of the shared jar pool. */
export function poolDir(): string {
	return join(root(), "plugins");
}

/** Path of the archived, compacted per-instance logs. */
export function centralLogsDir(): string {
	return join(root(), "logs");
}

/** A cluster-root state file whose single writer is the primary daemon. */
export type SaveFile = "cluster" | "lock" | "env" | "configfiles";

/**
 * Save-through hook for follower daemons: the state files' single writer is the
 * primary, so a follower installs a hook that forwards every save up the
 * cluster link after updating its local copy. Unset (the default) everywhere
 * else — saves are then purely local.
 */
export type SaveHook = (file: SaveFile, data: unknown) => Promise<void>;

let saveHook: SaveHook | undefined;

/** Install (or clear) the save-through hook. */
export function installSaveHook(hook: SaveHook | undefined): void {
	saveHook = hook;
}

/**
 * Announce a state-file save to the hook, if one is installed. Every module that
 * owns a cluster-root state file calls this after writing its local copy, so a
 * follower's write reaches the primary instead of being clobbered by the next
 * sync frame.
 */
export async function notifySave(file: SaveFile, data: unknown): Promise<void> {
	await saveHook?.(file, data);
}

/** Read the instance registry. */
export async function loadCluster(): Promise<ClusterConfig> {
	return await Bun.file(clusterPath()).json();
}

/** Write the instance registry back, tab-indented like the checked-in file. */
export async function saveCluster(cfg: ClusterConfig): Promise<void> {
	await Bun.write(clusterPath(), JSON.stringify(cfg, null, "\t") + "\n");

	await saveHook?.("cluster", cfg);
}

/** Read the plugin lockfile, treating a missing file as an empty lock. */
export async function loadLock(): Promise<PluginsLock> {
	const lock: PluginsLock = existsSync(lockPath())
		? await Bun.file(lockPath()).json()
		: { plugins: {} };

	// dynamic import: families.ts statically imports this module, so a static
	// import here would be a cycle
	const { ensureLockDefaults } = await import("./families");

	if (ensureLockDefaults(lock) && existsSync(lockPath())) {
		await saveLock(lock);
	}

	return lock;
}

/** Write the plugin lockfile with its plugins and groups key-sorted, to keep diffs small. */
export async function saveLock(lock: PluginsLock): Promise<void> {
	const sorted: PluginsLock = { version: lock.version, plugins: {} };

	for (const key of Object.keys(lock.plugins).sort()) {
		sorted.plugins[key] = lock.plugins[key]!;
	}

	if (lock.groups) {
		sorted.groups = {};

		for (const key of Object.keys(lock.groups).sort()) {
			sorted.groups[key] = lock.groups[key]!;
		}
	}

	await Bun.write(lockPath(), JSON.stringify(sorted, null, "\t") + "\n");

	await saveHook?.("lock", sorted);
}

/** All instances including the proxy, keyed by name ("proxy" for the proxy). */
export function allInstances(cfg: ClusterConfig): Record<string, InstanceConfig> {
	return { proxy: cfg.proxy, ...cfg.instances };
}

/** Locally-managed (non-external) instances including proxy. */
export function managedInstances(cfg: ClusterConfig): Record<string, InstanceConfig> {
	const entries = Object.entries(allInstances(cfg)).filter(([, inst]) => !inst.external);

	return Object.fromEntries(entries);
}

/** Absolute path of an instance's live server directory. */
export function instanceDir(inst: InstanceConfig): string {
	return join(root(), inst.dir);
}

/** The directory name an addon of one kind lives in, inside an instance. */
export type AddonDir = "plugins" | "mods";

/**
 * Where luna deploys a server's addons. Mod loaders keep theirs in `mods/`
 * rather than `plugins/`, and the two are not interchangeable: a bukkit jar in
 * `mods/` is ignored at best and a crash at worst. Everything that reads or
 * writes an instance's addons goes through this, so neither kind can ever be
 * written into the other's directory.
 */
export function addonDirOf(software: Software): AddonDir {
	return software === "neoforge" ? "mods" : "plugins";
}

/**
 * The directory a *build* belongs in, from its family. Paired with
 * `addonDirOf`, this is the one comparison that keeps a plugin out of a
 * modpack's `mods/` even when an operator names the instance explicitly.
 */
export function addonDirForFamily(family: PluginFamily): AddonDir {
	return family === "neoforge" ? "mods" : "plugins";
}

/** Software names accepted as a `*<software>` wildcard target. */
const SOFTWARE_WILDCARDS: Software[] = ["paper", "velocity", "neoforge"];

/**
 * Expand target selectors to concrete instance names. Accepts plain names, the
 * `*` wildcard, and the per-software wildcards `*paper` / `*velocity` /
 * `*neoforge`. Throws on a name that is not a managed instance, so a typo can
 * never silently match none.
 */
export function expandTargets(cfg: ClusterConfig, targets: string[]): string[] {
	const all = managedInstances(cfg);
	const out = new Set<string>();

	for (const target of targets) {
		if (target === "*") {
			for (const name of Object.keys(all)) {
				out.add(name);
			}

			continue;
		}

		const software = SOFTWARE_WILDCARDS.find((candidate) => target === `*${candidate}`);

		if (software) {
			for (const [name, inst] of Object.entries(all)) {
				if (inst.software === software) {
					out.add(name);
				}
			}

			continue;
		}

		if (!all[target]) {
			throw new Error(`unknown target: ${target}`);
		}

		out.add(target);
	}

	return [...out].sort();
}
