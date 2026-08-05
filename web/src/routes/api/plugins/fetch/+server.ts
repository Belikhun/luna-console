// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { loadLock, saveLock } from '$core/config';
import { ensureVariantForMc } from '$core/plugins';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/**
 * POST { plugin, mcVersion } → make sure the pool holds a build of the entry
 * that supports the MC version, downloading one from Modrinth when needed.
 * This is the "download compatible version" action behind a validation warning.
 */
export async function POST({ request }) {
	const body = await request.json();
	const lock = await loadLock();
	const plugin = String(body.plugin ?? '');
	const mcVersion = String(body.mcVersion ?? '');

	if (!plugin || !mcVersion) {
		throw error(400, 'plugin and mcVersion are required');
	}

	try {
		const result = await ensureVariantForMc(lock, plugin, mcVersion);

		await saveLock(lock);

		if (result.downloaded) {
			pushEvent('plugins', 'action', `${plugin} ${result.version} pooled for MC ${mcVersion}`);
		}

		return json({ ok: true, ...result });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
