// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { loadCluster, saveCluster } from '$core/config';
import { checkDaemonUpgrade, daemonDetail, listDaemons, upgradeDaemon } from '$client/daemon';
import { pushEvent } from '$lib/server/luna';
import { startJob } from '$lib/server/jobs';

/** GET → one daemon's row, health history and its own event log. */
export async function GET({ params }) {
	const detail = await daemonDetail(params.name);

	if (!detail) {
		throw error(404, `unknown daemon: ${params.name}`);
	}

	return json(detail);
}

/**
 * POST { action } → the two build actions on one daemon.
 *
 * `check-upgrade` reports what each channel offers (the primary's binary first,
 * the GitHub release as the fallback) and applies nothing. `upgrade` applies
 * the preferred one as a job: fetching a 90 MB binary outlasts a request, so
 * the route answers with the job and the page follows its progress tree. The
 * daemon exits as the job settles, so a finished job means the swap happened
 * and its service manager is bringing the new build up.
 */
export async function POST({ params, request }) {
	const body = (await request.json().catch(() => ({}))) as {
		action?: string;
		force?: boolean;
		refresh?: boolean;
	};

	if (body.action === 'check-upgrade') {
		try {
			return json({ ok: true, check: await checkDaemonUpgrade(params.name, !!body.refresh) });
		} catch (err) {
			throw error(409, (err as Error).message);
		}
	}

	if (body.action !== 'upgrade') {
		throw error(400, `unknown action: ${body.action ?? '(none)'}`);
	}

	const job = startJob(
		'daemon-upgrade',
		params.name,
		`Upgrade ${params.name}`,
		async (reporter) => {
			const result = await upgradeDaemon(params.name, !!body.force, reporter);

			pushEvent(`daemon:${params.name}`, 'action', `upgraded ${result.from} → ${result.to}`);

			return result;
		}
	);

	return json({ ok: true, job });
}

/** DELETE → drop a follower daemon's registration (must be offline and own nothing). */
export async function DELETE({ params }) {
	const cfg = await loadCluster();
	const name = params.name;

	if (!cfg.daemons?.[name]) {
		throw error(404, `unknown daemon: ${name}`);
	}

	const live = (await listDaemons()).find((row) => row.name === name);

	if (live?.online) {
		throw error(409, `daemon "${name}" is currently connected; stop it first`);
	}

	const owned = Object.entries(cfg.instances)
		.filter(([, inst]) => inst.daemon === name)
		.map(([instName]) => instName);

	if (owned.length > 0) {
		throw error(409, `daemon "${name}" still owns ${owned.join(', ')}; reassign or delete those instances first`);
	}

	delete cfg.daemons[name];
	await saveCluster(cfg);

	pushEvent(`daemon:${name}`, 'action', `registration removed from the cluster`);

	return json({ ok: true });
}
