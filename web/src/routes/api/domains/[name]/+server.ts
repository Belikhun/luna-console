// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { loadCluster } from '$core/config';
import { deleteHostname, updateHostname } from '$core/domains';
import { errorMessage, jsonBody } from '$lib/server/http';
import { journal } from '$lib/server/session';

/** PATCH { address } → point the hostname elsewhere. */
export async function PATCH({ params, request, locals }) {
	const body = await jsonBody(request);
	const actor = locals.account?.username ?? 'console';

	try {
		const result = await updateHostname(params.name, { address: String(body.address ?? '') }, actor);

		journal(`hostname ${result.hostname.fqdn} pointed at ${result.hostname.address}`, { actor });

		return json(result);
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}

/** DELETE → unlink, remove the DNS record, stop managing it. */
export async function DELETE({ params, locals }) {
	const actor = locals.account?.username ?? 'console';

	try {
		const result = await deleteHostname(await loadCluster(), params.name, actor);

		journal(`hostname ${result.hostname.fqdn} deleted`, { actor });

		return json(result);
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
