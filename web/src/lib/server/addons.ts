// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * One consistent view of everything an instance loads; plugins or mods, plus
 * the world's data packs; assembled from the same inputs the individual tab
 * routes use.
 *
 * It lives here rather than in a route because the stream and the plain GET
 * must not drift: a viewer watching the live stream and a viewer who just hit
 * refresh are looking at the same screen, and two copies of "what state is this
 * addon in" would eventually disagree.
 */

import { loadCluster, loadLock, managedInstances, saveLock } from '$core/config';
import { instanceDataPackReport } from '$core/datapacks';
import { loadPacksLock } from '$core/packslock';
import { ensureAliases, instancePluginReport } from '$core/pluginstate';
import type { InstancePluginRow, ReportLifecycle, UnmanagedAddonRow } from '$core/pluginstate';
import type { InstanceDataPackRow } from '$core/datapacks';

import { instanceStatus } from '$lib/server/luna';

export interface AddonSnapshot {
	/** Lifecycle the report reasoned from; the console's transient states included */
	state: ReportLifecycle;
	plugins: InstancePluginRow[];
	sessionComplete: boolean;
	/** The daemon's session store facts for this boot; absent from older daemons */
	session?: {
		startedAt: number;
		lines: number;
		dropped: number;
	};
	warnings: number;
	errors: number;
	/** Addon jars in the instance's directory that luna does not manage */
	unmanaged: UnmanagedAddonRow[];
	/** Absent for software with no world of its own (the proxy) */
	datapacks?: { world: string; rows: InstanceDataPackRow[] };
}

/**
 * Assemble the snapshot for one instance.
 *
 * `state` is the sampler's, so the client can label the transition the console
 * asked for. The addon phases deliberately do *not* use it: they come from the
 * report's own probe, because "is a process up right now" is what decides
 * whether the log on disk still describes anything live, and a transient
 * "restarting" hides that in both directions.
 *
 * Throws when the instance is unknown; a world-less instance simply reports no
 * data packs.
 */
export async function addonSnapshot(name: string): Promise<AddonSnapshot> {
	const cfg = await loadCluster();

	if (!managedInstances(cfg)[name]) {
		throw new Error(`unknown instance: ${name}`);
	}

	const lock = await loadLock();

	if (await ensureAliases(lock)) {
		await saveLock(lock);
	}

	const status = await instanceStatus(name);
	const state = (status.state as ReportLifecycle) ?? 'unknown';

	const { rows, session, unmanaged } = await instancePluginReport(cfg, lock, name);

	const snapshot: AddonSnapshot = {
		state,
		plugins: rows,
		sessionComplete: session.complete,
		...(session.sessionStartedAt !== undefined
			? {
					session: {
						startedAt: session.sessionStartedAt,
						lines: session.sessionLines ?? 0,
						dropped: session.sessionDropped ?? 0
					}
				}
			: {}),
		warnings: rows.reduce((sum, row) => sum + row.warnings, 0),
		errors: rows.reduce((sum, row) => sum + row.errors, 0),
		unmanaged
	};

	try {
		snapshot.datapacks = await instanceDataPackReport(cfg, await loadPacksLock(), name, lock.groups);
	} catch {
		// the proxy has no world, which is not an error worth failing the tab over
	}

	return snapshot;
}

const inFlight = new Map<string, Promise<AddonSnapshot>>();

/**
 * `addonSnapshot`, coalesced per instance.
 *
 * Building one parses a whole boot session on the instance's own host, so two
 * people watching the same instance must not each pay for it. Everyone who asks
 * while a build is running gets that build's result.
 */
export async function sharedAddonSnapshot(name: string): Promise<AddonSnapshot> {
	const running = inFlight.get(name);

	if (running) {
		return await running;
	}

	const build = addonSnapshot(name);

	inFlight.set(name, build);

	try {
		return await build;
	} finally {
		inFlight.delete(name);
	}
}
