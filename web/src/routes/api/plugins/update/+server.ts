// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';
import { loadCluster, loadLock, saveLock, saveCluster } from '$core/config';
import { updatePlugins } from '$core/plugins';
import { startJob } from '$lib/server/jobs';
import { pushEvent } from '$lib/server/luna';
import { jsonBody } from '$lib/server/http';

/**
 * POST { names?, deploy? } → a job that checks, downloads and (optionally)
 * deploys.
 *
 * A job rather than a plain request: it is a provider round trip per entry and
 * then a jar per pending group, so it outlasts a request by a wide margin, and
 * the jars are worth watching arrive.
 */
export async function POST({ request }) {
	const body = await jsonBody(request);

	const job = startJob(
		'plugins-update',
		body.names?.length ? body.names.join(', ') : 'every addon',
		'Update addons',
		async (reporter) => {
			const cfg = await loadCluster();
			const lock = await loadLock();

			const outcome = await updatePlugins(cfg, lock, {
				names: body.names,
				deploy: body.deploy,
				reporter
			});

			await saveLock(lock);
			await saveCluster(cfg);

			if (outcome.applied.length) {
				const names = [...new Set(outcome.applied.map((entry) => entry.name))].join(', ');

				pushEvent('plugins', 'action', `updated: ${names}`);
			}

			return {
				applied: outcome.applied,
				deployed: outcome.actions.filter((action) => action.action !== 'unchanged').length
			};
		}
	);

	return json({ job });
}
