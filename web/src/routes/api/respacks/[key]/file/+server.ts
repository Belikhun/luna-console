// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import { loadCluster } from '$core/config';
import { loadPacksLock, savePacksLock } from '$core/packslock';
import { reloadResourcePacks, replaceResourcePackFile } from '$core/respacks';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/**
 * POST { data, reload? } -> replace this pack's zip with an uploaded one.
 *
 * `data` is the zip base64-encoded, for the same reason the upload route takes
 * it that way: SvelteKit's CSRF check rejects form posts when the served origin
 * is ambiguous, and JSON is exempt.
 *
 * The definition is left alone; only the file behind it changes. The proxy is
 * reloaded by default, because it hands clients the hash it read at load time
 * and a swapped zip under an old hash is a pack nobody can apply.
 */
export async function POST({ params, request }) {
	const body = await request.json();
	const data = String(body.data ?? '');

	if (!data) {
		throw error(400, 'data is required');
	}

	const cfg = await loadCluster();
	const lock = await loadPacksLock();

	try {
		const result = await replaceResourcePackFile(cfg, lock, params.key, data);

		await savePacksLock(lock);

		const reloaded = body.reload === false ? false : await reloadResourcePacks(cfg);

		pushEvent(
			'packs',
			'action',
			`resource pack ${params.key} file replaced (${result.sizeAfter} bytes)`
		);

		return json({ ok: true, ...result, reloaded });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
