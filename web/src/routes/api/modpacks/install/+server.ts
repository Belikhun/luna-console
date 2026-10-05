// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import { loadCluster, loadLock, saveCluster } from '$core/config';
import { completeProvision, installModpack } from '$core/modpack';
import { pushEvent } from '$lib/server/luna';
import { startJob } from '$lib/server/jobs';
import { errorMessage, jsonBody } from '$lib/server/http';

/**
 * POST { name, slug, versionId?, memory?, port?, profile?, runtime?, daemon?,
 * register?, skipOptional? } → provision an instance from a Modrinth modpack, as
 * a job: the pack alone is hundreds of downloads.
 */
export async function POST({ request }) {
	const body = await jsonBody(request);
	const name = String(body.name ?? '').trim();
	const slug = String(body.slug ?? '').trim();

	if (!/^[a-z0-9_-]+$/.test(name)) {
		throw error(400, 'name must be lowercase letters, digits, - or _');
	}

	if (!slug) {
		throw error(400, 'slug required');
	}

	const register = body.register !== false;
	const targetDaemon = typeof body.daemon === 'string' && body.daemon ? body.daemon : null;

	const job = startJob('modpack-install', name, `Install modpack ${slug} as ${name}`, async (reporter) => {
		const cfg = await loadCluster();
		const lock = await loadLock();

		reporter.weighOwn(0);

		const pack = reporter.child('Modpack', 10);
		const plugins = reporter.child('Plugins', 2);
		const packs = reporter.child('Packs', 1);
		const ports = reporter.child('Port allocations', 1);
		const proxy = reporter.child('Proxy registration', 1);

		try {
			const result = await installModpack(cfg, name, {
				slug,
				versionId: body.versionId ? String(body.versionId) : undefined,
				memory: body.memory ? String(body.memory) : undefined,
				port: body.port ? Number(body.port) : undefined,
				profile: body.profile ? String(body.profile) : undefined,
				runtime: body.runtime ? String(body.runtime) : undefined,
				daemon: targetDaemon ?? undefined,
				register,
				skipOptional: body.skipOptional === true,
				reporter: pack
			});

			await saveCluster(cfg);

			const outcome = await completeProvision(cfg, lock, name, { plugins, packs, ports, proxy }, register);

			pushEvent(
				name,
				'action',
				`instance created from modpack ${result.modpack.name} ${result.modpack.versionNumber} (${result.software} ${result.mcVersion}, port ${result.port})`
			);

			return { ...result, ...outcome };
		} catch (err) {
			pushEvent(name, 'error', `modpack install failed: ${errorMessage(err)}`);

			throw err;
		}
	}, { daemon: targetDaemon, software: 'modpack' });

	return json({ ok: true, job });
}
