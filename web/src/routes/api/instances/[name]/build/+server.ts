// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { loadCluster, saveCluster } from '$core/config';
import { getStatus } from '$core/instances';
import { checkServerBuild, updateServerBuild } from '$core/serverbuilds';
import { pushEvent } from '$lib/server/luna';
import { startJob } from '$lib/server/jobs';
import { errorMessage } from '$lib/server/http';

/**
 * The build of an instance's own software, separately from its Minecraft version.
 *
 * A version change is a migration and lives on the config route, behind the
 * plugin-compatibility gate. A build bump is not: it stays on the same Minecraft
 * version, so no plugin's compatibility can change and there is nothing to gate.
 * They are separate routes because the config route's guard is
 * `mcVersion !== inst.mcVersion`, and the whole point here is that it does not
 * differ.
 */

/** GET → whether a newer build exists, or why that cannot be established. */
export async function GET({ params }) {
	try {
		return json(await checkServerBuild(await loadCluster(), params.name));
	} catch (err) {
		throw error(404, errorMessage(err));
	}
}

/**
 * POST → install the newest build of the version this instance already runs.
 *
 * A job: it downloads a server binary, which outlasts a request, and the page
 * follows the same progress tree a version change uses.
 */
export async function POST({ params }) {
	const cfg = await loadCluster();
	const name = params.name;

	if (!cfg.instances[name]) {
		throw error(404, `unknown instance: ${name}`);
	}

	// the running process has its binary mapped, so a swap underneath it changes
	// nothing until a restart and leaves the registry claiming a build that is not
	// what is loaded; refuse rather than record something untrue
	const status = await getStatus(cfg, name);

	if (status.state !== 'stopped') {
		throw error(409, `${name} is running; stop it before changing its build`);
	}

	const job = startJob('instance-build', name, `${name}: newer build`, async (reporter) => {
		const fresh = await loadCluster();
		const res = await updateServerBuild(fresh, name, reporter);

		await saveCluster(fresh);

		pushEvent(name, 'action', `build ${res.fromBuild ?? '?'} → ${res.toBuild}`);

		// the same {from, to, build} shape a version change returns, so the page's
		// one job tracker renders both; here all three are build ids rather than
		// Minecraft versions, which is what makes the toast read "42 → 130"
		return { from: res.fromBuild ?? null, to: res.toBuild, build: res.toBuild };
	});

	return json({ job });
}
