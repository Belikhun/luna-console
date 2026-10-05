// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import { loadCluster, saveCluster } from '$core/config';
import { updateModpack } from '$core/modpack';
import { pushEvent } from '$lib/server/luna';
import { startJob } from '$lib/server/jobs';
import { errorMessage, jsonBody } from '$lib/server/http';

/** GET → where this instance's modpack came from, or null. */
export async function GET({ params }) {
	const cfg = await loadCluster();
	const inst = cfg.instances[params.name];

	if (!inst) {
		throw error(404, `unknown instance: ${params.name}`);
	}

	return json({ modpack: inst.modpack ?? null });
}

/** POST { versionId?, force?, skipOptional? } → move the instance to another version of its pack, as a job. */
export async function POST({ params, request }) {
	const body = await jsonBody(request);
	const cfg = await loadCluster();

	if (!cfg.instances[params.name]) {
		throw error(404, `unknown instance: ${params.name}`);
	}

	const job = startJob('modpack-update', params.name, `Update modpack on ${params.name}`, async (reporter) => {
		const fresh = await loadCluster();

		try {
			const result = await updateModpack(fresh, params.name, {
				versionId: body.versionId ? String(body.versionId) : undefined,
				force: body.force === true,
				skipOptional: body.skipOptional === true,
				reporter
			});

			await saveCluster(fresh);
			pushEvent(params.name, 'action', `modpack moved to ${result.to.versionNumber}`);

			return result;
		} catch (err) {
			pushEvent(params.name, 'error', `modpack update failed: ${errorMessage(err)}`);

			throw err;
		}
	});

	return json({ ok: true, job });
}
