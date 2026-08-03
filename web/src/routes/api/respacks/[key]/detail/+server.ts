import { json, error } from '@sveltejs/kit';
import { loadCluster, loadLock } from '$core/config';
import { loadPacksLock } from '$core/packslock';
import { resourcePackDetail } from '$core/respackinfo';
import { errorMessage } from '$lib/server/http';

/**
 * GET ?probe=0 → one pack in full: what is in the zip, where the proxy serves
 * it from, whether that URL answers, which backends get it, who is holding it
 * and what the web server logged.
 *
 * `probe=0` skips the outbound HTTP check — the page refreshes on a timer, and
 * an unreachable host would cost the probe timeout on every tick.
 */
export async function GET({ params, url }) {
	const cfg = await loadCluster();
	const lock = await loadPacksLock();

	try {
		return json({
			detail: await resourcePackDetail(cfg, lock, params.key, (await loadLock()).groups, {
				probe: url.searchParams.get('probe') !== '0'
			})
		});
	} catch (err) {
		throw error(404, errorMessage(err));
	}
}
