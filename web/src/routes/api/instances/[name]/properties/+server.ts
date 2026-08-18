// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import { loadCluster, managedInstances } from '$core/config';
import { readServerProperties, setRawProperty, deleteRawProperty } from '$core/services/settings';
import { SERVER_SETTINGS } from '$core/settings';
import { traitsOf } from '$core/software';
import { pushEvent } from '$lib/server/luna';
import { jsonBody, errorMessage } from '$lib/server/http';

/**
 * Every key on disk, each carrying what the schema knows about it: whether luna
 * manages it (never writable), and whether it is spec'd at all. The table
 * renders from this rather than from the schema, so a key Paper wrote and luna
 * has no spec for is still listed and still editable.
 */
export async function GET({ params }) {
	const cfg = await loadCluster();
	const inst = managedInstances(cfg)[params.name];

	if (!inst) {
		throw error(404, `unknown instance: ${params.name}`);
	}

	const properties = await readServerProperties(cfg, params.name);

	const rows = Object.entries(properties).map(([key, value]) => {
		const spec = SERVER_SETTINGS.find((entry) => entry.key === key);

		return {
			key,
			value,
			spec: !!spec,
			managed: !!spec?.managed,
			managedReason: spec?.managed ?? null
		};
	});

	return json({
		rows,
		// a proxy has no server.properties at all, which is a different thing from
		// one that is empty; the screen says so rather than showing a bare table
		supported: !traitsOf(inst.software, inst.mcVersion).isProxy
	});
}

/** PUT { key, value } → create or update one raw key. */
export async function PUT({ params, request }) {
	const body = await jsonBody(request);
	const cfg = await loadCluster();

	if (!managedInstances(cfg)[params.name]) {
		throw error(404, `unknown instance: ${params.name}`);
	}

	const key = String(body.key ?? '').trim();

	if (!key) {
		throw error(400, 'a property key is required');
	}

	try {
		const result = await setRawProperty(cfg, params.name, key, String(body.value ?? ''));

		if (result.changed) {
			pushEvent(
				params.name,
				'action',
				`server.properties:${key} = ${result.to || '(blank)'}${result.appended ? ' (added)' : ''}`
			);
		}

		return json({ ok: true, ...result });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}

/** DELETE ?key=… → drop one raw key's line; the server falls back to its default. */
export async function DELETE({ params, url }) {
	const cfg = await loadCluster();

	if (!managedInstances(cfg)[params.name]) {
		throw error(404, `unknown instance: ${params.name}`);
	}

	const key = (url.searchParams.get('key') ?? '').trim();

	if (!key) {
		throw error(400, 'a property key is required');
	}

	try {
		const result = await deleteRawProperty(cfg, params.name, key);

		if (result.existed) {
			pushEvent(params.name, 'action', `server.properties:${key} removed`);
		}

		return json({ ok: true, ...result });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
