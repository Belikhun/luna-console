// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { error } from '@sveltejs/kit';

import { publicSnapshot } from '$lib/server/publicsnapshot';
import { closeQuietly, SSE_HEADERS } from '$lib/server/http';

/** How often a connected visitor is sent a fresh snapshot. */
const FRAME_INTERVAL_MS = 5000;

/**
 * GET → the public snapshot, re-sent as it changes.
 *
 * Every connected visitor reads through the same cached snapshot, so a hundred
 * open tabs cost one daemon round trip per interval rather than a hundred. SSE
 * rather than a WebSocket, per the console's rule for anything a browser
 * streams.
 */
export async function GET({ request }) {
	// refuse before opening the stream, so a disabled page answers 404 rather
	// than a stream that never carries a frame
	if (!(await publicSnapshot())) {
		throw error(404, 'not found');
	}

	const encoder = new TextEncoder();

	const stream = new ReadableStream({
		start(controller) {
			let timer: ReturnType<typeof setInterval> | undefined;

			const send = async (): Promise<void> => {
				const snapshot = await publicSnapshot();

				if (!snapshot) {
					// switched off while the stream was open
					clearInterval(timer);
					closeQuietly(controller);

					return;
				}

				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(snapshot)}\n\n`));
				} catch {
					clearInterval(timer);
				}
			};

			const stop = (): void => {
				clearInterval(timer);
				closeQuietly(controller);
			};

			request.signal.addEventListener('abort', stop);

			void send();
			timer = setInterval(() => void send(), FRAME_INTERVAL_MS);
		}
	});

	return new Response(stream, { headers: SSE_HEADERS });
}
