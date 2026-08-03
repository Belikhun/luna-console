import { json, error } from '@sveltejs/kit';
import { loadCluster, loadLock } from '$core/config';
import { addDataPackFile, deployDataPacks, listDataPacks } from '$core/datapacks';
import { loadPacksLock, savePacksLock } from '$core/packslock';
import { projectUrl } from '$core/services/providers';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/** GET → every pooled data pack with file status and expanded targets. */
export async function GET() {
	const cfg = await loadCluster();
	const lock = await loadPacksLock();
	const rows = await listDataPacks(cfg, lock, (await loadLock()).groups);

	// the provider's web page is built here — the browser has no URL scheme
	const packs = rows.map((row) => ({
		...row,
		url: row.entry.remote ? projectUrl(row.entry.remote, 'datapack') : null
	}));

	return json({ packs });
}

/**
 * POST { name, data, targets? } → upload a pack zip into the pool (new, or
 * replacing an existing pack's file) and deploy it to its targets. `data` is
 * the zip base64-encoded — JSON rather than multipart for the same CSRF
 * reason as the resource pack upload route.
 */
export async function POST({ request }) {
	const body = await request.json();
	const name = String(body.name ?? '');
	const data = String(body.data ?? '');
	const targets = Array.isArray(body.targets)
		? body.targets.map((target: unknown) => String(target))
		: undefined;

	if (!name || !data) {
		throw error(400, 'name and data are required');
	}

	const cfg = await loadCluster();
	const lock = await loadPacksLock();

	try {
		const res = await addDataPackFile(cfg, lock, name, data, targets);

		await savePacksLock(lock);

		const actions = await deployDataPacks(cfg, lock, {
			pack: res.name,
			groups: (await loadLock()).groups
		});

		pushEvent('packs', 'action', `data pack ${res.name} uploaded`);

		return json({
			ok: true,
			name: res.name,
			entry: res.entry,
			deployed: actions.filter((action) => action.action !== 'unchanged').length
		});
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
