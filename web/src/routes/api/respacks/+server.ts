import { json, error } from '@sveltejs/kit';
import { loadCluster, loadLock } from '$core/config';
import { loadPacksLock, savePacksLock } from '$core/packslock';
import { addResourcePackFile, listResourcePacks } from '$core/respacks';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/** GET → every resource pack: registration, file status, provenance. */
export async function GET() {
	const cfg = await loadCluster();
	const lock = await loadPacksLock();

	return json({ packs: await listResourcePacks(cfg, lock, (await loadLock()).groups) });
}

/**
 * POST { name, data } → upload a pack zip (new, or replacing an existing
 * pack's file). `data` is the zip base64-encoded: JSON rather than multipart
 * because SvelteKit's CSRF check rejects form posts when the served origin is
 * ambiguous (the console answers on several addresses), and JSON is exempt —
 * a plain form cannot send it cross-site.
 */
export async function POST({ request }) {
	const body = await request.json();
	const name = String(body.name ?? '');
	const data = String(body.data ?? '');

	if (!name || !data) {
		throw error(400, 'name and data are required');
	}

	const cfg = await loadCluster();
	const lock = await loadPacksLock();

	try {
		const row = await addResourcePackFile(cfg, lock, name, data);

		await savePacksLock(lock);
		pushEvent('packs', 'action', `resource pack ${row.key} uploaded (${row.sizeBytes} bytes)`);

		return json({ ok: true, pack: row });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
