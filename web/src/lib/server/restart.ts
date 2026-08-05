// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { error } from '@sveltejs/kit';

import type { ClusterConfig } from '$core/types';
import { getAllStatuses, startInstance, stopInstance } from '$core/instances';
import { createSchedule, loadSchedules, saveSchedules } from '$core/schedule';
import { pushEvent } from '$lib/server/luna';

export interface RestartChoice {
	mode?: string;
	at?: string;
}

export interface RestartOutcome {
	restarted: string[];
	scheduled: string | null;
}

/**
 * Apply a restart choice to a set of instances after a plugin change: restart
 * the running ones now, create a one-shot restart schedule, or do nothing (the
 * change still deploys; servers load it on their next natural restart).
 */
export async function applyRestartChoice(
	cfg: ClusterConfig,
	affected: string[],
	restart: RestartChoice | undefined,
	reason: string
): Promise<RestartOutcome> {
	if (!restart?.mode || restart.mode === 'none' || !affected.length) {
		return { restarted: [], scheduled: null };
	}

	if (restart.mode === 'now') {
		const statuses = await getAllStatuses(cfg);
		const restarted: string[] = [];

		for (const name of affected) {
			if (statuses.find((status) => status.name === name)?.state === 'stopped') {
				continue;
			}

			await stopInstance(cfg, name);
			await startInstance(cfg, name);
			restarted.push(name);
			pushEvent(name, 'action', `restarted: ${reason}`);
		}

		return { restarted, scheduled: null };
	}

	if (restart.mode === 'schedule') {
		if (!restart.at) {
			throw error(400, 'restart.at is required for a scheduled restart');
		}

		const store = await loadSchedules();

		const schedule = createSchedule(cfg, store, {
			name: `${reason} reboot`,
			action: 'restart',
			instances: affected,
			trigger: { kind: 'at', at: new Date(restart.at).toISOString() }
		});

		await saveSchedules(store);

		return { restarted: [], scheduled: schedule.nextRun ?? null };
	}

	throw error(400, `unknown restart mode: ${restart.mode}`);
}
