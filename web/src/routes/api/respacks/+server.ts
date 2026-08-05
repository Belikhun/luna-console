// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import { loadCluster, loadLock } from '$core/config';
import { loadPacksLock, savePacksLock } from '$core/packslock';
import { addResourcePackFile, listResourcePacksLive } from '$core/respacks';
import { projectUrl } from '$core/services/providers';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/**
 * GET → every resource pack: registration, file status, provenance.
 *
 * The live listing, so a pack a plugin registers at runtime arrives as what it
 * is rather than as an abandoned zip. `dynamic.available` is false when the
 * proxy is not answering, and the screen says so instead of guessing.
 */
export async function GET() {
	const cfg = await loadCluster();
	const lock = await loadPacksLock();
	const { rows, dynamic } = await listResourcePacksLive(cfg, lock, (await loadLock()).groups);

	// the provider's web page is built here; the browser has no URL scheme
	const packs = rows.map((row) => ({
		...row,
		url: row.remote ? projectUrl(row.remote, 'resourcepack') : null
	}));

	return json({ packs, dynamic });
}

/**
 * POST { name, data } → upload a pack zip (new, or replacing an existing
 * pack's file). `data` is the zip base64-encoded: JSON rather than multipart
 * because SvelteKit's CSRF check rejects form posts when the served origin is
 * ambiguous (the console answers on several addresses), and JSON is exempt -
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
