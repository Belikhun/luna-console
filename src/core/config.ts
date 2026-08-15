// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { AddonDir, ClusterConfig, InstanceConfig, PluginFamily, PluginsLock, Software } from "./types";
import { FAMILY_DIRS, SOFTWARE_IDS, traitsOf } from "./software";
import { t } from "../shared/i18n";

export type { AddonDir } from "./types";

/**
 * The directory every cluster state file lives in, relative to the root.
 *
 * Dotted so it sorts away from the instance directories it sits beside: the
 * cluster root is also where `lobby/`, `survival/` and the jar pool live, and a
 * registry loose among them is one `rm -rf` away from being collateral.
 */
export const DATA_DIR = ".data";

/**
 * Where the installed web console lives, beside the binary in `.bin/`.
 *
 * Dotted for the same reason `.data` is, and in the cluster root for the same
 * reason the binary is: an upgrade swaps the whole directory by rename, so what
 * has to be writable is the parent. Keeping it here rather than in the source
 * tree is what makes the console an artifact of the *release* instead of an
 * artifact of whichever checkout happened to be on the machine.
 */
export const WEB_DIR = ".web";

/** The installed console directory for this cluster root. */
export function consoleDir(): string {
	return join(root(), WEB_DIR);
}

/**
 * Whether a directory holds a runnable console: adapter-node's entry point is
 * the one file `luna web` actually spawns, so its absence is what "not
 * installed" means, not the directory being missing.
 */
export function isConsoleDir(dir: string): boolean {
	return existsSync(join(dir, "build", "index.js"));
}

/**
 * Every state file the primary owns, by name.
 *
 * What `syncFilePath` recognises as state rather than as an ordinary
 * root-relative file, so a new state file is added here once.
 */
export const STATE_FILES = [
	"cluster.json",
	"plugins.lock.json",
	"packs.lock.json",
	"environment.json",
	"configfiles.json",
	"accounts.json",
	"sessions.json",
	"schedules.json",
	"uptime.json",
] as const;

/** Whether a directory is a cluster root: it holds the registry. */
function isClusterRoot(dir: string): boolean {
	return existsSync(join(dir, DATA_DIR, "cluster.json"));
}

/**
 * Locate the cluster root: the nearest ancestor of the working directory that
 * holds a registry, or the directory containing this tool. Bails out of the
 * process when neither exists; nothing else in `core/` can run without it.
 */
function findRoot(): string {
	if (process.env.LUNA_ROOT) {
		return resolve(process.env.LUNA_ROOT);
	}

	let dir = process.cwd();

	while (true) {
		if (isClusterRoot(dir)) {
			return dir;
		}

		const parent = dirname(dir);

		if (parent === dir) {
			break;
		}

		dir = parent;
	}

	const toolRoot = resolve(import.meta.dir, "..", "..");

	if (isClusterRoot(toolRoot)) {
		return toolRoot;
	}

	console.error(
		`error: ${DATA_DIR}/cluster.json not found (set LUNA_ROOT or run inside the cluster directory)`,
	);
	process.exit(1);
}

let cachedRoot: string | undefined;

/** Absolute path of the cluster root, resolved once per process. */
export function root(): string {
	return (cachedRoot ??= findRoot());
}

/** Directory holding every cluster state file. */
export function dataDir(): string {
	return join(root(), DATA_DIR);
}

/**
 * Create the state directory if it is not there yet.
 *
 * Called once at daemon startup. `Bun.write` would create it on the first save
 * anyway, but the hub's sync watcher opens it directly and `watch` throws ENOENT
 * on a missing directory, which would take a fresh primary down on boot.
 */
export async function ensureDataDir(): Promise<void> {
	await mkdir(dataDir(), { recursive: true });
}

/**
 * Path of one state file. Every module that owns one resolves through this, so
 * there is a single answer to where cluster state lives.
 */
export function statePath(file: string): string {
	return join(dataDir(), file);
}

/**
 * Where a logical sync name lives on *this* machine.
 *
 * The cluster link carries logical names, not paths, so each daemon decides
 * where a given name belongs. That is what lets a primary on this build sync to
 * a follower that still keeps its state at the root: the name on the wire is
 * unchanged, and only the resolution differs.
 */
export function syncFilePath(name: string): string {
	return (STATE_FILES as readonly string[]).includes(name) ? statePath(name) : join(root(), name);
}

/** Path of the instance registry; the source of truth for the cluster. */
export function clusterPath(): string {
	return statePath("cluster.json");
}

/** Path of the plugin lockfile; the source of truth for plugin versions. */
export function lockPath(): string {
	return statePath("plugins.lock.json");
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
export type SaveFile = "cluster" | "lock" | "env" | "configfiles" | "accounts";

/**
 * Save-through hook for follower daemons: the state files' single writer is the
 * primary, so a follower installs a hook that forwards every save up the
 * cluster link after updating its local copy. Unset (the default) everywhere
 * else; saves are then purely local.
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

/**
 * Every directory a software keeps addons in. Mod loaders keep theirs in
 * `mods/` rather than `plugins/`, and the two are not interchangeable: a bukkit
 * jar in `mods/` is ignored at best and a crash at worst. The hybrids carry
 * both, which is why this answers with a list.
 */
export function addonDirsOf(software: Software): AddonDir[] {
	return traitsOf(software).addonDirs;
}

/**
 * The directory an unqualified question about "this instance's addons" means:
 * the first one the software declares. Anything that has to place a specific
 * *build* asks `addonDirForFamily` instead, because on a hybrid the answer
 * depends on the build, not on the server.
 */
export function addonDirOf(software: Software): AddonDir {
	return addonDirsOf(software)[0] ?? "plugins";
}

/**
 * The directory a *build* belongs in, from its family. Paired with
 * `addonDirsOf`, this is the one comparison that keeps a plugin out of a
 * modpack's `mods/` even when an operator names the instance explicitly.
 */
export function addonDirForFamily(family: PluginFamily): AddonDir {
	return FAMILY_DIRS[family];
}

/**
 * Expand target selectors to concrete instance names. Accepts plain names, the
 * `*` wildcard, and a `*<software>` wildcard for every software luna knows.
 * Throws on a name that is not a managed instance, so a typo can never
 * silently match none.
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

		const software = SOFTWARE_IDS.find((candidate) => target === `*${candidate}`);

		if (software) {
			for (const [name, inst] of Object.entries(all)) {
				if (inst.software === software) {
					out.add(name);
				}
			}

			continue;
		}

		if (!all[target]) {
			throw new Error(t("core.config.unknownTarget", { target }));
		}

		out.add(target);
	}

	return [...out].sort();
}
