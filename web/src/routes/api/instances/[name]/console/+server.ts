import { json, error } from '@sveltejs/kit';

import { loadCluster, managedInstances } from '$core/config';
import { sendCommand } from '$core/instances';
import { dfetch } from '$client/socket';
import { pushEvent } from '$lib/server/luna';
import { SSE_HEADERS } from '$lib/server/http';

/**
 * GET → SSE stream of the instance's live console, piped through from the
 * daemon (which tails latest.log on the instance's own host). The body is
 * forwarded untouched — re-framing the events would only add a place to drop
 * one.
 */
export async function GET({ params, request }) {
	const cfg = await loadCluster();
	const inst = managedInstances(cfg)[params.name];

	if (!inst) {
		throw error(404, 'unknown instance');
	}

	const upstream = await dfetch(`/instances/${params.name}/console`, { signal: request.signal });

	if (!upstream.ok || !upstream.body) {
		throw error(502, `daemon refused the console stream (${upstream.status})`);
	}

	return new Response(upstream.body, { headers: SSE_HEADERS });
}

/** POST { command } → send to the instance's console via screen. */
export async function POST({ params, request }) {
	const { command } = await request.json();

	if (typeof command !== 'string' || !command.trim()) {
		throw error(400, 'command required');
	}

	const cfg = await loadCluster();

	if (!managedInstances(cfg)[params.name]) {
		throw error(404, 'unknown instance');
	}

	if (!(await sendCommand(cfg, params.name, command.trim()))) {
		throw error(409, `${params.name} is not running`);
	}

	pushEvent(params.name, 'action', `console command: ${command.trim()}`);

	return json({ ok: true });
}
