// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { loadCluster } from '$core/config';
import { createHostname, domainAudit, domainSettings, listHostnames } from '$core/domains';
import { errorMessage, jsonBody } from '$lib/server/http';
import { journal } from '$lib/server/session';
import { can, filterAllowed } from '$lib/server/authz';
import { resourceId } from '$shared/iam/resources';

/**
 * The domains screen: settings (the API key only as a hint), the managed
 * hostnames, the audit trail and the instance names a hostname can route to.
 * An account that may not configure the provider sees the hostnames it may
 * describe and their trail, and no provider details.
 */
export async function GET({ locals }) {
	const [settings, all, fullAudit, cfg, configures] = await Promise.all([
		domainSettings(),
		listHostnames(),
		domainAudit(300),
		loadCluster(),
		can(locals, 'domain:ConfigureProvider')
	]);
	const hostnames = await filterAllowed(locals, 'domain:Describe', all, (entry) => resourceId('domain', entry.label));
	const shown = new Set(hostnames.flatMap((entry) => [entry.label, entry.fqdn]));
	const audit = configures
		? fullAudit
		: fullAudit.filter((entry) => entry.hostname !== undefined && shown.has(entry.hostname));
	const view = configures
		? settings
		: { ...settings, provider: null, publicAddress: null };

	// the proxy is not a target: velocity cannot route a forced host to itself
	const instances = Object.entries(cfg.instances)
		.filter(([, inst]) => !inst.external)
		.map(([name]) => name)
		.sort();

	return json({ settings: view, hostnames, audit, instances });
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
