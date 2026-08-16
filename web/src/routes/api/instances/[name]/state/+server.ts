// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import type { ProgressReporter } from '$core/progress';
import type { ClusterConfig } from '$core/types';
import { loadCluster, managedInstances } from '$core/config';
import { startInstance, stopInstance } from '$core/instances';
import { worldLock } from '$core/world';
import {
	startInstanceTracked,
	stopInstanceTracked,
	restartInstanceTracked
} from '$core/lifecycle';
import { markTransition, clearTransition, pushEvent } from '$lib/server/luna';
import { startJob } from '$lib/server/jobs';
import { errorMessage } from '$lib/server/http';

const RUNNERS = {
	start: startInstanceTracked,
	stop: stopInstanceTracked,
	restart: restartInstanceTracked
} as const;

type Action = keyof typeof RUNNERS;

/**
 * The tracked ops are new; a follower daemon on an older build answers them
 * with "unknown operation". Rather than failing the user's start, the plain
 * lifecycle ops (which every build has) run instead; only the log-derived
 * phase reporting is lost. Drop this once the whole fleet is on a tracked
 * build.
 */
async function untrackedFallback(
	cfg: ClusterConfig,
	name: string,
	action: Action,
	reporter: ProgressReporter
): Promise<unknown> {
	reporter.say(
		'warn',
		`the daemon owning ${name} predates transition tracking; running the plain ${action}`
	);

	if (action === 'start') {
		const outcome = await startInstance(cfg, name);

		reporter.complete(outcome === 'started' ? 'started' : 'already running');

		return { outcome, tookMs: 0 };
	}

	const stopped = await stopInstance(cfg, name);

	if (action === 'stop') {
		reporter.complete(`stopped (${stopped.outcome})`);

		return stopped;
	}

	const outcome = await startInstance(cfg, name);

	reporter.complete('restarted');

	return { outcome: outcome === 'started' ? 'started' : outcome, tookMs: stopped.tookMs };
}

/**
 * POST { action: "start" | "stop" | "restart" }; every action runs as a job
 * whose progress tree is derived from the server's own log (JVM bootstrap,
 * plugins, world prep on the way up; plugin disable and world saves on the way
 * down), so the client renders the transition live instead of polling blind.
 */
export async function POST({ params, request }) {
	const { action } = (await request.json()) as { action: Action };
	const cfg = await loadCluster();
	const name = params.name;

	if (!managedInstances(cfg)[name]) {
		throw error(404, `unknown instance: ${name}`);
	}

	const run = RUNNERS[action];

	if (!run) {
		throw error(400, `unknown action: ${action}`);
	}

	// the sampler's transient state is what every *other* console client sees
	// while the job runs; a start needs none; the session itself reads "starting"
	if (action === 'start') {
		clearTransition(name);
	} else {
		markTransition(name, action === 'stop' ? 'stopping' : 'restarting');
	}

	// The daemon refuses a locked instance anyway, but doing it here means the
	// operator sees why on the click rather than watching a job fail a moment
	// later with the reason buried in a card.
	if (action !== 'stop') {
		const lock = await worldLock(cfg, name);

		if (lock) {
			throw error(409, `a world ${lock.kind} is running on ${name}; it cannot start until that finishes`);
		}
	}

	pushEvent(name, 'action', `${action} requested`);

	const job = startJob(`instance-${action}`, name, `${action} ${name}`, async (reporter) => {
		try {
			let result: unknown;

			try {
				result = await run(cfg, name, reporter);
			} catch (err) {
				if (!errorMessage(err).includes('unknown operation')) {
					throw err;
				}

				result = await untrackedFallback(cfg, name, action, reporter);
			}

			pushEvent(name, 'action', `${action} finished`);

			return result;
		} catch (err) {
			pushEvent(name, 'error', `${action} failed: ${errorMessage(err)}`);

			throw err;
		} finally {
			// the job outlives nothing: the tracked ops only return once the real
			// end state is confirmed, so the transient state has no business
			// surviving them either; and the sampler cannot settle it for an
			// instance owned by another machine
			clearTransition(name);
		}
	});

	return json({ ok: true, job });
}
