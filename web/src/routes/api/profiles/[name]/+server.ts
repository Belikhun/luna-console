// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { loadCluster, saveCluster } from '$core/config';
import {
	getProfile,
	profileConsumers,
	removeProfile,
	renameProfile,
	updateProfile
} from '$core/profiles';
import { parseJavaArgs } from '$core/settings';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/** GET → one profile with its users. */
export async function GET({ params }) {
	const cfg = await loadCluster();

	try {
		const profile = getProfile(cfg, params.name);

		return json({ profile: { name: params.name, ...profile }, usedBy: profileConsumers(cfg, params.name) });
	} catch (err) {
		throw error(404, errorMessage(err));
	}
}

/**
 * PATCH { name?, java?, runtime?, flags?, jarArgs? } → edit, and rename when the
 * body carries a different name. An empty string clears `java` or `runtime`.
 */
export async function PATCH({ params, request }) {
	const body = (await request.json().catch(() => ({}))) as {
		name?: string;
		java?: string;
		runtime?: string;
		flags?: string | string[];
		jarArgs?: string | string[];
	};

	const cfg = await loadCluster();

	try {
		getProfile(cfg, params.name);
	} catch (err) {
		throw error(404, errorMessage(err));
	}

	const patch: Record<string, unknown> = {};

	if (body.java !== undefined) {
		patch.java = String(body.java);
	}

	if (body.runtime !== undefined) {
		patch.runtime = String(body.runtime);
	}

	if (body.flags !== undefined) {
		patch.flags = Array.isArray(body.flags) ? body.flags : parseJavaArgs(body.flags);
	}

	if (body.jarArgs !== undefined) {
		patch.jarArgs = Array.isArray(body.jarArgs) ? body.jarArgs : parseJavaArgs(body.jarArgs);
	}

	const changed: string[] = [];

	try {
		if (Object.keys(patch).length) {
			changed.push(...updateProfile(cfg, params.name, patch).changed);
		}

		// renaming last, so the edit above still addresses the profile by the name
		// the request came in on
		if (body.name && body.name !== params.name) {
			const moved = renameProfile(cfg, params.name, String(body.name));

			changed.push('name');
			pushEvent(
				'profiles',
				'action',
				`java profile ${params.name} renamed to ${body.name}` +
					(moved.updatedInstances.length ? ` (${moved.updatedInstances.join(', ')} moved)` : '')
			);
		}
	} catch (err) {
		throw error(400, errorMessage(err));
	}

	if (!changed.length) {
		return json({ ok: true, changed });
	}

	await saveCluster(cfg);

	return json({ ok: true, changed });
}

/** DELETE → remove a profile nothing launches from. */
export async function DELETE({ params }) {
	const cfg = await loadCluster();

	try {
		removeProfile(cfg, params.name);
	} catch (err) {
		// in use, or the last one left: a refusal the operator can act on
		throw error(409, errorMessage(err));
	}

	await saveCluster(cfg);
	pushEvent('profiles', 'action', `java profile ${params.name} removed`);

	return json({ ok: true });
}
