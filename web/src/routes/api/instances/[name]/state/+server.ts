import { json, error } from '@sveltejs/kit';
import type { ClusterConfig } from '$core/types';
import { loadCluster, managedInstances } from '$core/config';
import { startInstance, stopInstance } from '$core/instances';
import { markTransition, clearTransition, pushEvent } from '$lib/server/mrds';
import { errorMessage } from '$lib/server/http';

/**
 * Stop (and for a restart, start again) without holding the request open — a
 * graceful stop can take a minute. The instance carries a transient state until
 * the sampler sees it settle, which is what the UI polls.
 */
function stopInBackground(cfg: ClusterConfig, name: string, action: 'stop' | 'restart'): void {
	void (async () => {
		try {
			const res = await stopInstance(cfg, name);

			pushEvent(name, 'action', `stopped (${res.outcome})`);

			if (action !== 'restart') {
				clearTransition(name);

				return;
			}

			await startInstance(cfg, name);
			pushEvent(name, 'action', 'started');
		} catch (err) {
			clearTransition(name);
			pushEvent(name, 'error', `${action} failed: ${errorMessage(err)}`);
		}
	})();
}

/** POST { action: "start" | "stop" | "restart" } — stop/restart run async, poll status. */
export async function POST({ params, request }) {
	const { action } = await request.json();
	const cfg = await loadCluster();
	const name = params.name;

	if (!managedInstances(cfg)[name]) {
		throw error(404, `unknown instance: ${name}`);
	}

	if (action === 'start') {
		const res = await startInstance(cfg, name);

		pushEvent(
			name,
			'action',
			res === 'started' ? 'start requested' : 'start requested (already running)'
		);

		return json({ ok: true, result: res });
	}

	if (action === 'stop' || action === 'restart') {
		markTransition(name, action === 'stop' ? 'stopping' : 'restarting');
		pushEvent(name, 'action', `${action} requested`);
		stopInBackground(cfg, name, action);

		return json({ ok: true, result: action === 'stop' ? 'stopping' : 'restarting' });
	}

	throw error(400, `unknown action: ${action}`);
}
