import { json, error } from '@sveltejs/kit';

import { loadCluster, managedInstances } from '$core/config';
import { readInstanceLogs, DEFAULT_LOG_LINES } from '$core/logs';

/**
 * GET ?lines= → the tail of latest.log plus the instance's monthly archives,
 * read by the daemon that owns the instance; a follower's logs live on the
 * follower's disk, so reading them here would only ever find silence.
 */
export async function GET({ params, url }) {
	const cfg = await loadCluster();

	if (!managedInstances(cfg)[params.name]) {
		throw error(404, 'unknown instance');
	}

	const lines = Number(url.searchParams.get('lines') ?? DEFAULT_LOG_LINES);

	try {
		return json(await readInstanceLogs(cfg, params.name, lines));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);

		// an old follower build has no remote log read to offer
		if (message.includes('unknown operation')) {
			throw error(501, `the daemon owning ${params.name} predates remote log reads; upgrade it`);
		}

		throw error(502, message);
	}
}
