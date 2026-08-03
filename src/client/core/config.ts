/**
 * Bridge mirror of core/config: path helpers answer from the daemon handshake
 * (the daemon told us the root), pure helpers run locally, and the state files
 * are read and written through the daemon — the only process that touches disk.
 */

import { join } from "node:path";

import type * as core from "../../core/config";
import type { ClusterConfig, InstanceConfig } from "../../core/types";

import { call } from "../rpc";
import { clientRoot } from "../socket";

export { allInstances, managedInstances, managesPlugins, expandTargets } from "../../core/config";

/** Cluster root, as reported by the daemon's handshake. */
export function root(): string {
	return clientRoot();
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

/** Absolute path of an instance's live server directory. */
export function instanceDir(inst: InstanceConfig): string {
	return join(root(), inst.dir);
}

export const loadCluster = call("config.loadCluster") as typeof core.loadCluster;
export const saveCluster = call("config.saveCluster", { cfg: 0 }) as typeof core.saveCluster;
export const loadLock = call("config.loadLock") as typeof core.loadLock;
export const saveLock = call("config.saveLock", { lock: 0 }) as typeof core.saveLock;

export type { ClusterConfig };
