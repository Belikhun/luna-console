/**
 * The instance lifecycle flows, as flash-card jobs. Every page that starts,
 * stops, restarts or deletes an instance calls these — the card wording, the
 * live log-derived progress and the failure shape stay identical wherever the
 * flow is triggered from.
 */

import { del, post } from '$lib/api';
import { jobFlash } from '$lib/jobflash';
import type { JobView } from '$lib/jobs';

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

/**
 * Start/stop/restart one instance behind a live flash card. Resolves with the
 * settled job, or undefined when it failed (already reported on the card).
 */
export function instanceStateJob(name: string, action: StateAction): Promise<JobView | undefined> {
	return jobFlash({
		title: `${RUNNING_TITLES[action]} ${name}…`,

		start: () => post(`/instances/${name}/state`, { action }),

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
	});
}

/**
 * Delete one instance behind a live flash card — a purge walks a whole world
 * directory, so the card shows what is currently going.
 */
export function deleteInstanceJob(name: string, purge: boolean): Promise<JobView | undefined> {
	return jobFlash({
		title: `Deleting ${name}…`,

		start: () => del(`/instances/${name}?purge=${purge}`),

		success: () => ({
			message: `Deleted ${name}`,
			detail: purge ? 'The instance directory was purged.' : 'The instance directory was kept.'
		}),

		failure: () => ({ message: `Could not delete ${name}` })
	});
}
