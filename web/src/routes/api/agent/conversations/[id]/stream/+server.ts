// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { error } from '@sveltejs/kit';

import { SSE_HEADERS, closeQuietly } from '$lib/server/http';
import { followRun } from '$lib/server/agent/runner';
import type { AgentEvent } from '$lib/server/agent/runner';

/** Heartbeat interval; nginx drops an SSE connection that says nothing for a minute. */
const PING_MS = 20_000;

/**
 * GET → SSE of the conversation's live run: every event so far, then each new
 * one, closing after `done`. A conversation with nothing running answers one
 * `idle` state and closes, so the panel knows the saved transcript is complete.
 */
export async function GET({ params, locals }) {
	if (!locals.account) {
		throw error(401, 'sign in first');
	}

	const owner = locals.account.username;
	let stop: (() => void) | undefined;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			const send = (event: AgentEvent | { type: 'idle' } | { type: 'ping' }): boolean => {
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));

					return true;
				} catch {
					return false;
				}
			};

			let ping: ReturnType<typeof setInterval> | undefined;

			const finish = (): void => {
				clearInterval(ping);
				stop?.();
				closeQuietly(controller);
			};

			const unfollow = followRun(params.id, owner, (event) => {
				if (!send(event)) {
					finish();

					return;
				}

				if (event.type === 'done') {
					// queueMicrotask: followRun replays synchronously, before `stop` is assigned
					queueMicrotask(finish);
				}
			});

			if (!unfollow) {
				send({ type: 'idle' });
				closeQuietly(controller);

				return;
			}

			stop = unfollow;
			ping = setInterval(() => {
				if (!send({ type: 'ping' })) {
					finish();
				}
			}, PING_MS);
		},

		cancel() {
			stop?.();
		}
	});

	return new Response(stream, { headers: SSE_HEADERS });
}
