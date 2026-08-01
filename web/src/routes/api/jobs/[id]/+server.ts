import { json, error } from '@sveltejs/kit';

import { getJob, watchJob } from '$lib/server/jobs';
import { SSE_HEADERS, closeQuietly } from '$lib/server/http';

/**
 * GET → the job's current state as JSON, or ?stream=1 for an SSE stream of it.
 *
 * The stream sends the whole job on every flush rather than a delta: a progress
 * tree is small, and a client that connects late or reconnects then needs no
 * replay to be correct.
 */
export async function GET({ params, url }) {
	const job = getJob(params.id);

	if (!job) {
		throw error(404, 'unknown or expired job');
	}

	if (!url.searchParams.has('stream')) {
		return json({ job });
	}

	let unwatch: (() => void) | undefined;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			unwatch = watchJob(params.id, (view) => {
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(view)}\n\n`));
				} catch {
					// client went away between the flush and the write
					return;
				}

				// nothing more will happen to a settled job, so the stream is done
				if (view.state !== 'running') {
					unwatch?.();
					closeQuietly(controller);
				}
			});
		},

		cancel() {
			unwatch?.();
		}
	});

	return new Response(stream, { headers: SSE_HEADERS });
}
