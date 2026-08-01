import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { ClusterConfig, InstanceConfig, PluginsLock } from "./types";

/**
 * Locate the cluster root: the nearest ancestor of the working directory that
 * holds a `cluster.json`, or the directory containing this tool. Bails out of
 * the process when neither exists — nothing else in `core/` can run without it.
 */
function findRoot(): string {
	if (process.env.MRDS_ROOT) {
		return resolve(process.env.MRDS_ROOT);
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

	console.error("error: cluster.json not found (set MRDS_ROOT or run inside the cluster directory)");
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

/** Read the instance registry. */
export async function loadCluster(): Promise<ClusterConfig> {
	return await Bun.file(clusterPath()).json();
}

/** Write the instance registry back, tab-indented like the checked-in file. */
export async function saveCluster(cfg: ClusterConfig): Promise<void> {
	await Bun.write(clusterPath(), JSON.stringify(cfg, null, "\t") + "\n");
}

/** Read the plugin lockfile, treating a missing file as an empty lock. */
export async function loadLock(): Promise<PluginsLock> {
	if (!existsSync(lockPath())) {
		const empty: PluginsLock = { plugins: {} };

		// migrate in memory so groups/identity exist even before the first save
		const { migrateLock } = await import("./families");

		migrateLock(empty);

		return empty;
	}

	const lock: PluginsLock = await Bun.file(lockPath()).json();

	// dynamic import: families.ts statically imports this module, so a static
	// import here would be a cycle
	const { migrateLock } = await import("./families");

	if (migrateLock(lock)) {
		const backup = join(root(), "plugins.lock.v1.backup.json");

		if (!existsSync(backup)) {
			await Bun.write(backup, await Bun.file(lockPath()).text());
		}

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

/**
 * Expand target selectors to concrete instance names. Accepts plain names, the
 * `*` wildcard, and the per-software wildcards `*paper` / `*velocity`. Throws on
 * a name that is not a managed instance, so a typo can never silently match none.
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

		if (target === "*paper" || target === "*velocity") {
			const software = target.slice(1);

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
