// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import { loadPacksLock, savePacksLock } from '$core/packslock';
import { applyResourcePackUpdate, checkResourcePackUpdates } from '$core/respacks';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/**
 * POST { names?, apply? } → check resource packs for Modrinth updates; with
 * apply, download them over the pack files (a reload makes them live).
 */
export async function POST({ request }) {
	const body = await request.json().catch(() => ({}));
	const lock = await loadPacksLock();

	try {
		const { updates, skipped } = await checkResourcePackUpdates(lock, body.names);

		if (!body.apply) {
			return json({ ok: true, updates, skipped, applied: [] });
		}

		for (const update of updates) {
			await applyResourcePackUpdate(lock, update);
			pushEvent('packs', 'action', `resource pack ${update.key} updated to ${update.to}`);
		}

		await savePacksLock(lock);

		return json({ ok: true, updates, skipped, applied: updates.map((update) => update.key) });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
