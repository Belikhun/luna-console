// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * A server-sent-events stream held open from the console's server, reconnected
 * with backoff when it drops. The agent's triggers follow LunaCore's player
 * stream, the daemon's event stream and instance consoles through these, so a
 * chat line or a state change wakes them the moment it happens rather than on
 * the next poll.
 */

/** First wait before reconnecting; doubles up to the cap, and resets once a connection holds. */
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/** A connection that stayed up this long counts as healthy again, for the backoff. */
const STABLE_MS = 30_000;

export interface Feed {
	/** Whether the stream is connected right now */
	healthy(): boolean;
	stop(): void;
}

/**
 * Follow a stream until stopped. `open` makes the request (it is called again
 * for every reconnect); `onEvent` receives each event's name (`message` when
 * the stream names none) and its data; `onOpen` runs on every connect, which is
 * a reader's cue to catch up on what it missed while the stream was down.
 */
export function followFeed(
	open: (signal: AbortSignal) => Promise<Response>,
	onEvent: (event: string, data: string) => void,
	onOpen?: () => void
): Feed {
	const abort = new AbortController();
	let connected = false;

	void (async () => {
		let wait = RETRY_MIN_MS;

		while (!abort.signal.aborted) {
			const started = Date.now();

			try {
				const response = await open(abort.signal);

				if (!response.ok || !response.body) {
					throw new Error(`status ${response.status}`);
				}

				connected = true;
				onOpen?.();
				await readEvents(response.body, onEvent);
			} catch {
				// a refused or dropped stream is retried below
			}

			connected = false;

			if (abort.signal.aborted) {
				break;
			}

			wait = Date.now() - started > STABLE_MS
				? RETRY_MIN_MS
				: Math.min(RETRY_MAX_MS, wait * 2);

			await new Promise((resolve) => setTimeout(resolve, wait));
		}
	})();

	return {
		healthy: () => connected,

		stop(): void {
			abort.abort();
			connected = false;
		}
	};
}

/** Parse an SSE body, handing each complete event over; resolves when the body ends. */
async function readEvents(body: ReadableStream<Uint8Array>, onEvent: (event: string, data: string) => void): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	while (true) {
		const { done, value } = await reader.read();

		if (done) {
			return;
		}

		buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

		let end = buffer.indexOf('\n\n');

		while (end >= 0) {
			const block = buffer.slice(0, end);

			buffer = buffer.slice(end + 2);
			end = buffer.indexOf('\n\n');

			let event = 'message';
			const data: string[] = [];

			for (const line of block.split('\n')) {
				if (line.startsWith('event:')) {
					event = line.slice(6).trim();
				} else if (line.startsWith('data:')) {
					data.push(line.slice(5).replace(/^ /, ''));
				}
			}

			// a comment-only block (a keepalive) carries no data
			if (data.length > 0) {
				onEvent(event, data.join('\n'));
			}
		}
	}
}
