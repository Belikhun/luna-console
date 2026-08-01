import { loadCluster, loadLock, managedInstances } from "../core/config";

/**
 * Completion sources are called while the user is mid-keystroke, so every one of
 * them swallows load failures and completes nothing rather than erroring at the
 * prompt.
 */

/** Names of every managed instance. */
export async function instanceNames(): Promise<string[]> {
	try {
		return Object.keys(managedInstances(await loadCluster())).sort();
	} catch {
		return [];
	}
}

/** Names of every plugin in the lockfile. */
export async function pluginNames(): Promise<string[]> {
	try {
		return Object.keys((await loadLock()).plugins).sort();
	} catch {
		return [];
	}
}

/** Instance names plus the wildcard selectors that target groups of them. */
export async function targetSelectors(): Promise<string[]> {
	return ["*", "*paper", "*velocity", ...(await instanceNames())];
}

/** Gradle module names in the luna-plugins workspace that produce a deployable jar. */
export async function lunaModules(): Promise<string[]> {
	try {
		const { lunaSource, listModules } = await import("../core/luna");
		const source = lunaSource(await loadCluster());
		const modules = await listModules(source);

		return modules
			.filter((module) => module.file && source.platforms.includes(module.platform))
			.map((module) => module.name)
			.sort();
	} catch {
		return [];
	}
}
