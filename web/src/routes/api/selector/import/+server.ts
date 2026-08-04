import { json, error } from '@sveltejs/kit';

import { loadCluster } from '$core/config';
import { importServersYml } from '$core/selector';
import { pushEvent } from '$lib/server/luna';
import { errorMessage, jsonBody } from '$lib/server/http';

/** POST → read the existing servers.yml into cluster.json. */
export async function POST({ request }) {
	const body = (await jsonBody(request)) as { dryRun?: boolean; force?: boolean };

	try {
		const cfg = await loadCluster();
		const report = await importServersYml(cfg, { dryRun: !!body?.dryRun, force: !!body?.force });

		if (report.saved) {
			pushEvent('proxy', 'action', `server selector imported from servers.yml (${report.imported.length} server(s))`);
		}

		return json({ report });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
