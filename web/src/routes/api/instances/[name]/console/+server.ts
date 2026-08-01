import { json, error } from '@sveltejs/kit';
import { join } from 'node:path';

import { loadCluster, managedInstances, instanceDir } from '$core/config';
import { sendCommand } from '$core/instances';
import { pushEvent } from '$lib/server/mrds';
import { SSE_HEADERS, closeQuietly } from '$lib/server/http';

/** How much backlog a freshly opened console shows. */
const TAIL_LINES = 100;

/** GET → SSE stream of the instance's live console (tail -F latest.log). */
export async function GET({ params }) {
	const cfg = await loadCluster();
	const inst = managedInstances(cfg)[params.name];

	if (!inst) {
		throw error(404, 'unknown instance');
	}

	const logPath = join(instanceDir(inst), 'logs', 'latest.log');

	// -F rather than -f: the server rotates latest.log, and tail has to follow the
	// new file by name instead of holding the old descriptor open
	let proc: ReturnType<typeof Bun.spawn> | undefined;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			proc = Bun.spawn(['tail', '-n', String(TAIL_LINES), '-F', logPath], {
				stdout: 'pipe',
				stderr: 'ignore'
			});

			const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();

			void (async () => {
				try {
					while (true) {
						const { done, value } = await reader.read();

						if (done) {
							break;
						}

						const text = new TextDecoder().decode(value);

						for (const line of text.split('\n')) {
							if (line.length === 0) {
								continue;
							}

							controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));
						}
					}
				} catch {
					// client disconnected mid-read
				}

				closeQuietly(controller);
			})();
		},

		cancel() {
			proc?.kill();
		}
	});

	return new Response(stream, { headers: SSE_HEADERS });
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
