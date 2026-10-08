// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { error } from '@sveltejs/kit';

import { SSE_HEADERS, closeQuietly } from '$lib/server/http';
import { watchRunStarts } from '$lib/server/agent/runner';

/** Heartbeat interval; nginx drops an SSE connection that says nothing for a minute. */
const PING_MS = 20_000;

/**
 * GET → SSE that says `run` once a run starts in this conversation (at once
 * if one is going), then closes. An idle chat holds it open, because a
 * background task or a trigger can start a run with nobody typing, and the
 * chat then attaches to the run's own stream.
 */
export async function GET({ params, locals }) {
	if (!locals.account) {
		throw error(401, 'sign in first');
	}

	const owner = locals.account.username;
	let stop: (() => void) | undefined;
	let ping: ReturnType<typeof setInterval> | undefined;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			const send = (data: { type: 'run' } | { type: 'ping' }): boolean => {
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

					return true;
				} catch {
					return false;
				}
			};

			const finish = (): void => {
				clearInterval(ping);
				stop?.();
				closeQuietly(controller);
			};

			stop = watchRunStarts(params.id, owner, () => {
				send({ type: 'run' });
				finish();
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
		}
	});

	return new Response(stream, { headers: SSE_HEADERS });
}
