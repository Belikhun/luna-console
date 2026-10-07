// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { loadCluster } from '$core/config';
import { linkHostname } from '$core/domains';
import { errorMessage, jsonBody } from '$lib/server/http';
import { journal } from '$lib/server/session';

/** POST { instance } → route the hostname to that instance. */
export async function POST({ params, request, locals }) {
	const body = await jsonBody(request);
	const actor = locals.account?.username ?? 'console';

	try {
		const result = await linkHostname(await loadCluster(), params.name, String(body.instance ?? ''), actor);

		journal(`hostname ${result.hostname.fqdn} linked to ${result.hostname.instance}`, { actor });

		return json(result);
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
