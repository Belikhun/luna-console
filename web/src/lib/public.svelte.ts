// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Keeping the public page live.
 *
 * Both public screens start from the server-rendered snapshot and then follow
 * the same SSE stream, so a visitor who leaves the tab open sees players come
 * and go. One helper rather than an effect in each page: the reconnect
 * behaviour is the fiddly part and it should not exist twice.
 */

import type { PublicSnapshot } from '$core/publicsite';

/** How long to wait before reconnecting a dropped stream. */
const RETRY_MS = 5000;

/**
 * Follow the public snapshot stream, calling `onFrame` with each document.
 *
 * Returns a stop function. The browser's own `EventSource` reconnects on its
 * own, but not when the server answered an error, so a failed stream is retried
 * here too: the page is long-lived and a console restart must not leave it
 * frozen on a stale document forever.
 */
export function followPublic(onFrame: (snapshot: PublicSnapshot) => void): () => void {
	let source: EventSource | undefined;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;

	const open = (): void => {
		if (stopped) {
			return;
		}

		source = new EventSource('/api/public/stream');

		source.onmessage = (event) => {
			try {
				onFrame(JSON.parse(event.data) as PublicSnapshot);
			} catch {
				// a truncated frame is not worth tearing the stream down for; the next
				// one is five seconds away
			}
		};

		source.onerror = () => {
			source?.close();
			source = undefined;

			if (!stopped) {
				retry = setTimeout(open, RETRY_MS);
			}
		};
	};

	open();

	return () => {
		stopped = true;
		clearTimeout(retry);
		source?.close();
	};
}
