// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { loadCluster } from '$core/config';
import { createHostname, domainAudit, domainSettings, listHostnames } from '$core/domains';
import { errorMessage, jsonBody } from '$lib/server/http';
import { journal } from '$lib/server/session';

/**
 * The domains screen: settings (the API key only as a hint), the managed
 * hostnames, the audit trail and the instance names a hostname can route to.
 */
export async function GET() {
	const [settings, hostnames, audit, cfg] = await Promise.all([
		domainSettings(),
		listHostnames(),
		domainAudit(300),
		loadCluster()
	]);

	// the proxy is not a target: velocity cannot route a forced host to itself
	const instances = Object.entries(cfg.instances)
		.filter(([, inst]) => !inst.external)
		.map(([name]) => name)
		.sort();

	return json({ settings, hostnames, audit, instances });
}

/** POST { name, instance?, address?, adopt? } → the created hostname. */
export async function POST({ request, locals }) {
	const body = await jsonBody(request);
	const actor = locals.account?.username ?? 'console';

	try {
		const cfg = await loadCluster();
		const result = await createHostname(cfg, String(body.name ?? ''), {
			instance: body.instance ? String(body.instance) : undefined,
			address: body.address ? String(body.address) : undefined,
			adopt: body.adopt === true
		}, actor);

		journal(`hostname ${result.hostname.fqdn} created`, { actor, detail: result.hostname.instance ?? undefined });

		return json(result);
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
