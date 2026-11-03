// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { SSE_HEADERS, closeQuietly } from '$lib/server/http';
import { watchRunStarts } from '$lib/server/agent/runner';
import { enterConversation } from '$lib/server/agent/presence';
import { conversationFor } from '$lib/server/agent/sharing';

/** Heartbeat interval; nginx drops an SSE connection that says nothing for a minute. */
const PING_MS = 20_000;

/**
 * GET → SSE that says `run` once a run starts in this conversation (at once
 * if one is going), then closes. An idle chat holds it open, because a
 * background task, a trigger or another participant can start a run with
 * nobody typing here, and the chat then attaches to the run's own stream.
 * Meanwhile it reports who has the conversation open (`presence`).
 */
export async function GET({ params, locals }) {
	const { account } = await conversationFor(locals, params.id);
	let stop: (() => void) | undefined;
	let leave: (() => void) | undefined;
	let ping: ReturnType<typeof setInterval> | undefined;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			let closed = false;

			const send = (data: { type: 'run' } | { type: 'ping' } | { type: 'presence'; viewers: string[] }): boolean => {
				if (closed) {
					return false;
				}

				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

					return true;
				} catch {
					return false;
				}
			};

			const finish = (): void => {
				if (closed) {
					return;
				}

				closed = true;
				clearInterval(ping);
				stop?.();
				leave?.();
				closeQuietly(controller);
			};

			stop = watchRunStarts(params.id, () => {
				send({ type: 'run' });
				finish();
			});
			leave = enterConversation(params.id, account, (viewers) => {
				send({ type: 'presence', viewers });
			});

			ping = setInterval(() => {
				if (!send({ type: 'ping' })) {
					finish();
				}
			}, PING_MS);
		},
		cancel() {
			clearInterval(ping);
			stop?.();
			leave?.();
		}
	});

	return new Response(stream, { headers: SSE_HEADERS });
}
