import { json, error } from '@sveltejs/kit';
import { loadCluster, managedInstances } from '$core/config';
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
 * POST { action: "start" | "stop" | "restart" } — every action runs as a job
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
	// while the job runs; a start needs none — the session itself reads "starting"
	if (action !== 'start') {
		markTransition(name, action === 'stop' ? 'stopping' : 'restarting');
	}

	pushEvent(name, 'action', `${action} requested`);

	const job = startJob(`instance-${action}`, name, `${action} ${name}`, async (reporter) => {
		try {
			const result = await run(cfg, name, reporter);

			pushEvent(name, 'action', `${action} finished`);

			return result;
		} catch (err) {
			clearTransition(name);
			pushEvent(name, 'error', `${action} failed: ${errorMessage(err)}`);

			throw err;
		}
	});

	return json({ ok: true, job });
}
