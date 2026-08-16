// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import { loadCluster, managedInstances } from '$core/config';
import { getStatus } from '$core/instances';
import { listBackups } from '$core/backups';
import { worldInfo, worldLock } from '$core/world';
import { errorMessage } from '$lib/server/http';

/**
 * GET → everything the World & Backup tab renders: the world on disk, the
 * backups taken of it, and whether a world operation currently holds the
 * instance down.
 *
 * The lock comes from the daemon rather than from this page's own job list.
 * Another browser, the CLI or a schedule can all start one, and a tab that
 * only knew about work it had started itself would offer verbs that the
 * daemon is about to refuse.
 */
export async function GET({ params }) {
	const cfg = await loadCluster();
	const inst = managedInstances(cfg)[params.name];

	if (!inst) {
		throw error(404, 'unknown instance');
	}

	try {
		const [world, backups, lock, status] = await Promise.all([
			worldInfo(cfg, params.name),
			listBackups(cfg, params.name),
			worldLock(cfg, params.name),
			getStatus(cfg, params.name)
		]);

		return json({ world, backups, lock: lock ?? null, state: status.state });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
