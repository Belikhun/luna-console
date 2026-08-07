// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { loadCluster, saveCluster } from '$core/config';
import { createProfile, listProfiles } from '$core/profiles';
import { parseJavaArgs } from '$core/settings';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/** GET → every java profile, with the instances launching from it. */
export async function GET() {
	const cfg = await loadCluster();

	return json({ profiles: listProfiles(cfg) });
}

/** POST { name, java?, runtime?, flags?, jarArgs?, copyFrom? } → define one. */
export async function POST({ request }) {
	const body = (await request.json().catch(() => ({}))) as {
		name?: string;
		java?: string;
		runtime?: string;
		flags?: string | string[];
		jarArgs?: string | string[];
		copyFrom?: string;
	};

	const cfg = await loadCluster();
	const name = String(body.name ?? '').trim();

	if (!name) {
		throw error(400, 'a profile needs a name');
	}

	const base = body.copyFrom ? cfg.javaProfiles[String(body.copyFrom)] : undefined;

	if (body.copyFrom && !base) {
		throw error(404, `no such java profile: ${body.copyFrom}`);
	}

	const flags = Array.isArray(body.flags)
		? body.flags
		: body.flags !== undefined
			? parseJavaArgs(body.flags)
			: [...(base?.flags ?? [])];

	const jarArgs = Array.isArray(body.jarArgs)
		? body.jarArgs
		: body.jarArgs !== undefined
			? parseJavaArgs(body.jarArgs)
			: base?.jarArgs
				? [...base.jarArgs]
				: undefined;

	try {
		createProfile(cfg, name, {
			java: body.java !== undefined ? String(body.java) : base?.java,
			runtime: body.runtime !== undefined ? String(body.runtime) : base?.runtime,
			flags,
			jarArgs
		});
	} catch (err) {
		throw error(400, errorMessage(err));
	}

	await saveCluster(cfg);
	pushEvent('profiles', 'action', `java profile ${name} created`);

	return json({ ok: true });
}
