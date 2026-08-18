// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import { loadCluster, saveCluster } from '$core/config';
import { setProxyRegistration, syncVelocityToml } from '$core/proxy';
import { sendCommand, getStatus } from '$core/instances';
import { pushEvent } from '$lib/server/luna';
import { jsonBody, errorMessage } from '$lib/server/http';

/** GET → this instance's registration, with every peer's for try-list context. */
export async function GET({ params }) {
	const cfg = await loadCluster();
	const inst = cfg.instances[params.name];

	if (!inst) {
		throw error(404, `unknown instance: ${params.name}`);
	}

	const peers = Object.entries(cfg.instances)
		.filter(([name]) => name !== params.name)
		.map(([name, entry]) => ({
			name,
			register: entry.proxy?.register ?? false,
			priority: entry.proxy?.priority ?? null,
			forcedHosts: entry.proxy?.forcedHosts ?? []
		}));

	return json({
		registration: inst.proxy ?? null,
		external: !!inst.external,
		peers
	});
}

/**
 * PUT { register?, priority?, forcedHosts?, sync?, reload? } → change the
 * registration; with `sync`, land it in velocity.toml right away (and with
 * `reload`, tell a running proxy to pick it up).
 */
export async function PUT({ params, request }) {
	const body = await jsonBody(request);
	const cfg = await loadCluster();

	let result: { changed: string[]; registration?: unknown };

	try {
		result = setProxyRegistration(cfg, params.name, {
			register: typeof body.register === 'boolean' ? body.register : undefined,
			priority:
				body.priority === null
					? null
					: typeof body.priority === 'number'
						? body.priority
						: undefined,
			forcedHosts: Array.isArray(body.forcedHosts) ? body.forcedHosts.map(String) : undefined
		});
	} catch (err) {
		throw error(400, errorMessage(err));
	}

	if (result.changed.length) {
		await saveCluster(cfg);
		pushEvent('proxy', 'action', `${params.name} registration updated (${result.changed.join(', ')})`);
	}

	let synced = false;
	let reloaded = false;

	if (body.sync) {
		const res = await syncVelocityToml(cfg, false);

		synced = res.changed;

		if (body.reload && synced) {
			const status = await getStatus(cfg, 'proxy');

			if (status.state !== 'stopped') {
				reloaded = await sendCommand(cfg, 'proxy', 'velocity reload');
			}
		}
	}

	return json({
		ok: true,
		changed: result.changed,
		registration: result.registration ?? null,
		synced,
		reloaded
	});
}
