// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import { loadCluster, loadLock } from '$core/config';
import { deployDataPacks, installDataPackFromProvider } from '$core/datapacks';
import { loadPacksLock, savePacksLock } from '$core/packslock';
import { getProject } from '$core/services/providers';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';
import type { ProviderId } from '$core/types';

/**
 * POST { slug, targets?, channel?, provider?, id? } → install a data pack from
 * a provider and deploy it. Targets may be empty: a pack can reach its
 * instances through an addon group instead, and then there is no MC version to
 * gate the install on.
 */
export async function POST({ request }) {
	const body = await request.json();
	const cfg = await loadCluster();
	const lock = await loadPacksLock();
	const provider = (body.provider ?? 'modrinth') as ProviderId;
	const project = await getProject(provider, body.id ?? body.slug, 'datapack');

	if (!project) {
		throw error(404, `${provider} project "${body.slug ?? body.id}" not found`);
	}

	const targets = Array.isArray(body.targets) ? body.targets.map(String) : [];

	try {
		const res = await installDataPackFromProvider(cfg, lock, provider, project, targets, {
			channel: body.channel
		});

		await savePacksLock(lock);

		const actions = await deployDataPacks(cfg, lock, {
			pack: res.name,
			groups: (await loadLock()).groups
		});

		pushEvent(
			'packs',
			'action',
			`data pack ${res.name} installed (${res.entry.installed?.versionNumber})`
		);

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
