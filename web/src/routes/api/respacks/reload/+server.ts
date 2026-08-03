import { json } from '@sveltejs/kit';
import { loadCluster } from '$core/config';
import { reloadResourcePacks } from '$core/respacks';
import { pushEvent } from '$lib/server/luna';

/** POST → ask the running proxy to re-read the packs directory. */
export async function POST() {
	const cfg = await loadCluster();
	const sent = await reloadResourcePacks(cfg);

	if (sent) {
		pushEvent('packs', 'action', 'resource pack reload sent to the proxy');
	}

	return json({ ok: true, sent });
}
