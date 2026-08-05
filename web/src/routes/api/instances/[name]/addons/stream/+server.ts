import { error } from '@sveltejs/kit';

import { loadCluster, managedInstances } from '$core/config';
import { sharedAddonSnapshot, type AddonSnapshot } from '$lib/server/addons';
import { SSE_HEADERS, closeQuietly, errorMessage } from '$lib/server/http';

/**
 * How often the snapshot is rebuilt while the instance is settled, and while it
 * is moving. Building one parses a boot session on the instance's own host, so
 * the idle rate is deliberately slow; a settled server's addons do not change
 * on their own. A transition is the one time the answer changes second to
 * second, which is exactly when someone is watching.
 */
const IDLE_MS = 8_000;
const MOVING_MS = 1_500;

/** Comment frame cadence, so an unchanged stream still proves it is alive. */
const KEEPALIVE_MS = 20_000;

/** States in which the next answer is expected to differ from this one. */
const MOVING = new Set(['starting', 'stopping', 'restarting', 'unknown']);

/**
 * GET → SSE stream of everything this instance loads: plugins or mods with
 * their runtime state, and the world's data packs.
 *
 * A frame is the whole snapshot rather than a delta; it is small, and a client
 * that reconnects then needs no replay to be correct. Frames are sent only when
 * the payload actually changes, so an idle instance costs one comment every
 * `KEEPALIVE_MS` instead of a redraw every tick.
 */
export async function GET({ params, request }) {
	const cfg = await loadCluster();
	const name = params.name;

	if (!managedInstances(cfg)[name]) {
		throw error(404, `unknown instance: ${name}`);
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			let lastSent = '';
			let lastFrameAt = 0;

			const send = (payload: string): boolean => {
				try {
					controller.enqueue(encoder.encode(payload));

					return true;
				} catch {
					// the client went away between the build and the write
					return false;
				}
			};

			const halt = (): void => {
				stopped = true;

				clearTimeout(timer);
				closeQuietly(controller);
			};

			const tick = async (): Promise<void> => {
				if (stopped) {
					return;
				}

				let snapshot: AddonSnapshot | undefined;

				try {
					snapshot = await sharedAddonSnapshot(name);
				} catch (err) {
					// A build can fail transiently; a follower mid-restart refuses the
					// call. Report it and keep the stream open rather than dropping the
					// viewer at the exact moment the state is most interesting.
					if (!send(`event: error\ndata: ${JSON.stringify({ error: errorMessage(err) })}\n\n`)) {
						halt();

						return;
					}
				}

				if (stopped) {
					return;
				}

				const body = snapshot ? JSON.stringify(snapshot) : undefined;

				if (body !== undefined && body !== lastSent) {
					if (!send(`data: ${body}\n\n`)) {
						halt();

						return;
					}

					lastSent = body;
					lastFrameAt = Date.now();
				} else if (Date.now() - lastFrameAt >= KEEPALIVE_MS) {
					if (!send(': keepalive\n\n')) {
						halt();

						return;
					}

					lastFrameAt = Date.now();
				}

				const moving = !snapshot || MOVING.has(snapshot.state);

				timer = setTimeout(() => void tick(), moving ? MOVING_MS : IDLE_MS);
			};

			// the abort fires on navigation away, which cancel() alone can miss
			request.signal.addEventListener('abort', halt);

			void tick();
		},

		cancel() {
			stopped = true;

			clearTimeout(timer);
		}
	});

	return new Response(stream, { headers: SSE_HEADERS });
}
