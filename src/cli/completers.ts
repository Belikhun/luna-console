// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { loadCluster, loadLock, managedInstances } from "../client/core/config";
import { SOFTWARE_IDS } from "../client/core/software";

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

/**
 * Daemon names a per-machine value can be scoped to. Names, not keys: the
 * primary answers to its own name here, and `machineKeyFor` converts.
 */
export async function machineNames(): Promise<string[]> {
	try {
		const { listDaemons } = await import("../client/daemon");

		return (await listDaemons()).map((row) => row.name).sort();
	} catch {
		return [];
	}
}

/** Names of every java profile in the registry. */
export async function profileNames(): Promise<string[]> {
	try {
		return Object.keys((await loadCluster()).javaProfiles).sort();
	} catch {
		return [];
	}
}

/**
 * Runtime ids worth completing: what the fleet already has installed, plus the
 * catalog for this machine. Installing one that is not installed anywhere yet is
 * the whole point of the command, so the catalog is part of the answer.
 */
export async function runtimeIds(): Promise<string[]> {
	try {
		const { available, inventory } = await import("../client/core/runtimes");
		const cfg = await loadCluster();
		const ids = new Set<string>();

		for (const machine of await inventory(cfg)) {
			for (const runtime of machine.runtimes ?? []) {
				ids.add(runtime.id);
			}
		}

		for (const row of await available(cfg)) {
			ids.add(row.id);
		}

		return [...ids].sort();
	} catch {
		return [];
	}
}

/** Usernames of every console account. */
export async function accountNames(): Promise<string[]> {
	try {
		const { listAccounts } = await import("../client/core/accounts");

		return (await listAccounts()).map((account) => account.username);
	} catch {
		return [];
	}
}

/**
 * Instance names plus the wildcard selectors that target groups of them. The
 * per-software wildcards are derived, so a new software gains its own without
 * this list having to remember it.
 */
export async function targetSelectors(): Promise<string[]> {
	return ["*", ...SOFTWARE_IDS.map((software) => `*${software}`), ...(await instanceNames())];
}

/** Gradle module names in the luna-plugins workspace that produce a deployable jar. */
export async function lunaModules(): Promise<string[]> {
	try {
		const { lunaSource, listModules } = await import("../client/core/luna");
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
