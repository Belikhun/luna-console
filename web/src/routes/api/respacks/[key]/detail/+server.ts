import { json, error } from '@sveltejs/kit';
import { loadCluster, loadLock } from '$core/config';
import { loadPacksLock } from '$core/packslock';
import { resourcePackDetail } from '$core/respackinfo';
import { errorMessage } from '$lib/server/http';

/**
 * GET ?retest=1 → one pack in full: what is in the zip, where the proxy serves
 * it from, whether that URL answers, which backends get it, who is holding it,
 * who failed to load it and what the web server logged.
 *
 * Reachability is the stored answer unless `retest=1`: the page refreshes on a
 * timer, and an outbound HTTP request per tick would cost the probe timeout
 * whenever the host is down. The daemon re-measures by itself only when the
 * proxy logs a player failing to load this pack.
 */
export async function GET({ params, url }) {
	const cfg = await loadCluster();
	const lock = await loadPacksLock();

	try {
		return json({
			detail: await resourcePackDetail(cfg, lock, params.key, (await loadLock()).groups, {
				retest: url.searchParams.get('retest') === '1'
			})
		});
	} catch (err) {
		throw error(404, errorMessage(err));
	}
}
