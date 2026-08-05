// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import { loadCluster } from '$core/config';
import { loadPacksLock, savePacksLock } from '$core/packslock';
import { installResourcePackFromProvider } from '$core/respacks';
import { getProject } from '$core/services/providers';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';
import type { ProviderId } from '$core/types';

/** POST { slug, channel?, provider?, id? } → install a resource pack from a provider. */
export async function POST({ request }) {
	const body = await request.json();
	const cfg = await loadCluster();
	const lock = await loadPacksLock();
	const provider = (body.provider ?? 'modrinth') as ProviderId;
	const project = await getProject(provider, body.id ?? body.slug, 'resourcepack');

	if (!project) {
		throw error(404, `${provider} project "${body.slug ?? body.id}" not found`);
	}

	try {
		const row = await installResourcePackFromProvider(cfg, lock, provider, project, {
			channel: body.channel
		});

		await savePacksLock(lock);
		pushEvent('packs', 'action', `resource pack ${row.key} installed (${row.versionNumber})`);

		return json({ ok: true, pack: row });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
