// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The instance lifecycle flows, as flash-card jobs. Every page that starts,
 * stops, restarts or deletes an instance calls these; the card wording, the
 * live log-derived progress and the failure shape stay identical wherever the
 * flow is triggered from, and a page that *discovers* a running job (an
 * instance detail opened mid-start) attaches the same card via
 * `attachInstanceJobFlash`.
 */

import { goto } from '$app/navigation';
import { del, post } from '$lib/api';
import { attachJobFlash, jobFlash, type JobFlashConfig } from '$lib/jobflash';
import type { JobView } from '$lib/jobs';
import { attachWorldJobFlash, isWorldJobKind } from '$lib/worldjobs';

export type StateAction = 'start' | 'stop' | 'restart';

const RUNNING_TITLES: Record<StateAction, string> = {
	start: 'Starting',
	stop: 'Stopping',
	restart: 'Restarting'
};

const PAST_TENSE: Record<StateAction, string> = {
	start: 'started',
	stop: 'stopped',
	restart: 'restarted'
};

type FlashConfig = Omit<JobFlashConfig, 'start' | 'started'>;

/** The card wording for one start/stop/restart, shared by run and attach. */
function stateFlashConfig(name: string, action: StateAction): FlashConfig {
	return {
		title: `${RUNNING_TITLES[action]} ${name}…`,

		success: (result) => {
			const res = result as { outcome?: string; tookMs?: number } | null;

			if (res?.outcome === 'already-running') {
				return { message: `${name} is already running` };
			}

			if (res?.outcome === 'not-running') {
				return { message: `${name} was not running` };
			}

			if (res?.outcome === 'forced') {
				return {
					message: `${name} stopped (forced)`,
					detail: 'The graceful stop timed out and the process was terminated.'
				};
			}

			const took = res?.tookMs ? ` in ${(res.tookMs / 1000).toFixed(1)}s` : '';

			return { message: `${name} ${PAST_TENSE[action]}${took}` };
		},

		failure: () => ({ message: `Could not ${action} ${name}` })
	};
}

/** The card wording for one deletion, shared by run and attach. */
function deleteFlashConfig(name: string): FlashConfig {
	return {
		title: `Deleting ${name}…`,

		success: (result) => {
			const res = result as { purged?: boolean } | null;

			return {
				message: `Deleted ${name}`,
				detail: res?.purged
					? 'The instance directory was purged.'
					: 'The instance directory was kept.'
			};
		},

		failure: () => ({ message: `Could not delete ${name}` })
	};
}

/** The card wording for one creation, shared by the launch wizard and attach. */
export function createFlashConfig(name: string): FlashConfig {
	return {
		title: `Creating ${name}…`,

		success: (result) => {
			const res = result as {
				name: string;
				port: number;
				build: number;
				pluginsDeployed: number;
				velocityUpdated: boolean;
			};

			const proxied = res.velocityUpdated ? ', proxy registered' : '';

			return {
				message: `Created ${res.name} on port ${res.port}`,
				detail: `Paper build ${res.build}, ${res.pluginsDeployed} plugin(s) deployed${proxied}.`,
				actions: [
					{ label: 'Start now', run: () => void instanceStateJob(res.name, 'start') },
					{ label: 'View instance', run: () => void goto(`/instances/${res.name}`) }
				]
			};
		},

		failure: () => ({ message: `Could not create ${name}` })
	};
}

/**
 * Start/stop/restart one instance behind a live flash card. Resolves with the
 * settled job, or undefined when it failed (already reported on the card).
 */
export function instanceStateJob(name: string, action: StateAction): Promise<JobView | undefined> {
	return jobFlash({
		...stateFlashConfig(name, action),
		start: () => post(`/instances/${name}/state`, { action })
	});
}

/**
 * Delete one instance behind a live flash card; a purge walks a whole world
 * directory, so the card shows what is currently going.
 */
export function deleteInstanceJob(name: string, purge: boolean): Promise<JobView | undefined> {
	return jobFlash({
		...deleteFlashConfig(name),
		start: () => del(`/instances/${name}?purge=${purge}`)
	});
}

/**
 * Raise the matching flash card for an instance job already in flight; same
 * wording as if this browser had started it. Unknown kinds and jobs already
 * carded here are ignored, so calling this on every poll is safe.
 */
export function attachInstanceJobFlash(job: JobView): void {
	// a world job is an instance job as far as this page is concerned; without
	// this branch a backup started in another tab, by a schedule or from the CLI
	// would run to completion with nothing on screen to say so
	if (isWorldJobKind(job.kind)) {
		attachWorldJobFlash(job);

		return;
	}

	const configs: Record<string, () => FlashConfig> = {
		'instance-start': () => stateFlashConfig(job.target, 'start'),
		'instance-stop': () => stateFlashConfig(job.target, 'stop'),
		'instance-restart': () => stateFlashConfig(job.target, 'restart'),
		'instance-delete': () => deleteFlashConfig(job.target),
		'instance-create': () => createFlashConfig(job.target)
	};

	const config = configs[job.kind];

	if (!config) {
		return;
	}

	void attachJobFlash(job, config());
}
