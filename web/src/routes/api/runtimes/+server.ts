// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { loadCluster } from '$core/config';
import { install, inventory, remove, runtimeConsumers, validateRuntimeId } from '$core/runtimes';
import { listDaemons } from '$client/daemon';
import { machineKeyFor, machineNameFor, machineOptions } from '$shared/machines';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';
import { startJob } from '$lib/server/jobs';

/**
 * A machine arrives as a *name*, as it does everywhere else in the console; the
 * registry keys the primary by `""`, which nobody can type.
 */
async function machineFrom(typed: unknown): Promise<{ key: string; name: string }> {
	const fleet = await listDaemons();
	const name = typed === undefined || typed === null ? '' : String(typed);
	const key = machineKeyFor(fleet, name);

	if (key === undefined) {
		throw error(400, `unknown machine: ${name}`);
	}

	return { key, name: machineNameFor(fleet, key) };
}

/**
 * GET → what every machine has installed, with the machines that could not be
 * reached carrying `runtimes: null` rather than an empty list: "we do not know"
 * and "nothing installed" lead to opposite actions.
 */
export async function GET() {
	const cfg = await loadCluster();
	const fleet = await listDaemons();
	const machines = machineOptions(fleet);
	const rows = await inventory(cfg);

	return json({
		machines: rows.map((row) => ({
			...row,
			name: machineNameFor(fleet, row.machine)
		})),
		machineOptions: machines,
		consumers: runtimeConsumers(cfg)
	});
}

/**
 * POST { action: "install" | "remove", machine, id, force? }
 *
 * The id travels in the body rather than in the path: a Temurin build number
 * carries a "+", and a URL segment is the one place it would need escaping.
 */
export async function POST({ request }) {
	const body = (await request.json().catch(() => ({}))) as {
		action?: string;
		machine?: string;
		id?: string;
		force?: boolean;
	};

	const id = String(body.id ?? '');
	const bad = validateRuntimeId(id);

	// cheap checks answer 400 here, rather than becoming a job that fails a
	// second later with nothing for the client to do about it
	if (bad) {
		throw error(400, bad);
	}

	const machine = await machineFrom(body.machine);
	const cfg = await loadCluster();

	if (body.action === 'remove') {
		try {
			const result = await remove(cfg, machine.key, id, { force: !!body.force });

			if (!result.removed) {
				throw error(404, `${id} is not installed on ${machine.name}`);
			}

			pushEvent('runtimes', 'action', `runtime ${id} removed from ${machine.name}`);

			return json({ ok: true, ...result });
		} catch (err) {
			if (err && typeof err === 'object' && 'status' in err) {
				throw err;
			}

			// "still in use" is a refusal the operator can act on, not a failure
			throw error(409, errorMessage(err));
		}
	}

	if (body.action !== 'install') {
		throw error(400, 'action must be "install" or "remove"');
	}

	const job = startJob(
		'runtime-install',
		id,
		`Install ${id} on ${machine.name}`,
		async (reporter) => {
			const runtime = await install(cfg, machine.key, id, { force: !!body.force, reporter });

			pushEvent('runtimes', 'action', `runtime ${id} installed on ${machine.name}`);

			return runtime;
		},
		{ machine: machine.name }
	);

	return json({ ok: true, job });
}
