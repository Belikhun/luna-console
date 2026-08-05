// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Client side of the console's long-running operations.
 *
 * A route that cannot finish inside one request answers with a job; the page
 * follows it over SSE and renders its ProgressReporter tree. The types are here
 * rather than in `$lib/server/jobs` so both sides share one definition -
 * `$lib/server` is unreachable from browser code.
 */

import type { ProgressSnapshot } from '$core/progress';

export type JobState = 'running' | 'done' | 'failed';

export interface JobView {
	id: string;
	/** what kind of operation this is, e.g. "instance-create" */
	kind: string;
	/** what it acts on, e.g. the instance name */
	target: string;
	state: JobState;
	startedAt: number;
	finishedAt: number | null;
	progress: ProgressSnapshot;
	result: unknown;
	error: string | null;
	/** extra facts about the operation, set at start; e.g. the create job's
	 *  target machine, which the provisioning row shows before the instance
	 *  exists anywhere else */
	meta?: Record<string, unknown>;
}

/** Depth-first list of a progress tree, parents before their children. */
export function flattenProgress(
	node: ProgressSnapshot | null | undefined,
	out: ProgressSnapshot[] = []
): ProgressSnapshot[] {
	if (!node) {
		return out;
	}

	out.push(node);

	for (const child of node.children) {
		flattenProgress(child, out);
	}

	return out;
}

/**
 * Follow a job to its end, calling `onUpdate` on every progress flush. Resolves
 * with the settled job, and rejects when it failed or the stream broke; so a
 * caller can `await` it like any other request.
 */
export function followJob(id: string, onUpdate: (job: JobView) => void): Promise<JobView> {
	return new Promise((resolve, reject) => {
		const source = new EventSource(`/api/jobs/${id}?stream=1`);
		let settled = false;

		const finish = (fn: () => void): void => {
			settled = true;
			source.close();
			fn();
		};

		source.onmessage = (event) => {
			const job = JSON.parse(event.data) as JobView;

			onUpdate(job);

			if (job.state === 'done') {
				finish(() => resolve(job));
			}

			if (job.state === 'failed') {
				finish(() => reject(new Error(job.error ?? 'the operation failed')));
			}
		};

		// EventSource also reports the server's own close as an error, so only a break
		// before the job settled is a real failure
		source.onerror = () => {
			if (!settled) {
				finish(() => reject(new Error('lost the connection to the progress stream')));
			}
		};
	});
}
