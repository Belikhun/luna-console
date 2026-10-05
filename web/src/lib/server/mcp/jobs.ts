// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Waiting on console jobs from a tool call. Its own module so the handler
 * files can share it without importing each other.
 */

import { watchJob } from '$lib/server/jobs';
import type { JobView } from '$lib/jobs';

/** Wait for a job to settle, or give up and say it is still going. */
export function awaitJob(job: JobView, timeoutMs: number): Promise<JobView> {
	return new Promise((resolve) => {
		let unsubscribe: () => void = () => {};

		const timer = setTimeout(() => {
			unsubscribe();
			resolve(job);
		}, timeoutMs);

		unsubscribe = watchJob(job.id, (view) => {
			job = view;

			if (view.state === 'running') {
				return;
			}

			clearTimeout(timer);
			queueMicrotask(() => unsubscribe());
			resolve(view);
		});
	});
}
