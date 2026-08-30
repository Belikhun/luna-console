// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import { loadCluster } from '$core/config';
import { loadPacksLock, savePacksLock } from '$core/packslock';
import { resourcePackVersions, setResourcePackVersion } from '$core/respacks';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/**
 * GET -> the builds this pack's provider has published, newest first.
 *
 * What the version picker reads. Unfiltered by channel, because the reason to
 * open the picker is usually that the channel-gated automatic path chose a
 * build the operator does not want.
 */
export async function GET({ params }) {
	const lock = await loadPacksLock();

	try {
		return json({ ok: true, versions: await resourcePackVersions(lock, params.key) });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}

/**
 * POST { version } -> put the pack on that build, newer or older.
 *
 * The deliberate counterpart to /respacks/update, which refuses to go
 * backwards: here a downgrade is the point, so the response reports what the
 * choice implied (auto-update switched off, the channel widened) rather than
 * refusing it.
 */
export async function POST({ params, request }) {
	const body = await request.json().catch(() => ({}));
	const version = String(body.version ?? '').trim();

	if (!version) {
		throw error(400, 'a version to switch to is required');
	}

	const cfg = await loadCluster();
	const lock = await loadPacksLock();

	try {
		const result = await setResourcePackVersion(cfg, lock, params.key, version);

		await savePacksLock(lock);
		pushEvent(
			'packs',
			'action',
			`resource pack ${params.key} set to ${result.to}` +
				(result.downgrade ? ` (down from ${result.from ?? '?'})` : '')
		);

		return json({ ok: true, ...result });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
