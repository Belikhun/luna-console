// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { SSE_HEADERS, closeQuietly } from '$lib/server/http';
import { followRun } from '$lib/server/agent/runner';
import type { AgentEvent } from '$lib/server/agent/runner';
import { enterConversation } from '$lib/server/agent/presence';
import { conversationFor, REDACTED, toolVisibility } from '$lib/server/agent/sharing';

/** Heartbeat interval; nginx drops an SSE connection that says nothing for a minute. */
const PING_MS = 20_000;

type Frame = AgentEvent | { type: 'idle' } | { type: 'ping' } | { type: 'presence'; viewers: string[] };

/**
 * GET → SSE of the conversation's live run: every event so far, then each new
 * one, closing after `done`. A conversation with nothing running answers one
 * `idle` state and closes, so the panel knows the saved transcript is complete.
 *
 * Every participant follows the same run, and each hears who else has the
 * conversation open (`presence`). A luna tool's output reaches only the
 * account whose run made the call, and its input anyone whose own policies
 * would allow it (`sharing.ts`); the check is asynchronous, so events go
 * through one chain to keep their order.
 */
export async function GET({ params, locals }) {
	const { account, conversation } = await conversationFor(locals, params.id);
	const sight = toolVisibility(account, conversation);
	let stop: (() => void) | undefined;
	let leave: (() => void) | undefined;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			let chain: Promise<unknown> = Promise.resolve();
			let ping: ReturnType<typeof setInterval> | undefined;
			let closed = false;

			const write = (frame: Frame): boolean => {
				if (closed) {
					return false;
				}

				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));

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

			const shape = async (event: AgentEvent): Promise<AgentEvent> => {
				if (event.type !== 'tool' || (event.input === undefined && event.output === undefined)) {
					return event;
				}

				const seen = await sight(event.id, event.name, event.input, event.actor);
				const { input, output, ...rest } = event;

				return {
					...rest,
					...(input !== undefined && seen.input ? { input } : {}),
					...(output !== undefined ? { output: seen.output ? output : REDACTED } : {})
				};
			};

			const unfollow = followRun(params.id, (event) => {
				chain = chain.then(async () => {
					if (!write(await shape(event))) {
						finish();

						return;
					}

					if (event.type === 'done') {
						finish();
					}
				});
			});

			if (!unfollow) {
				write({ type: 'idle' });
				closeQuietly(controller);

				return;
			}

			stop = unfollow;
			leave = enterConversation(params.id, account, (viewers) => {
				chain = chain.then(() => write({ type: 'presence', viewers }));
			});
			ping = setInterval(() => {
				if (!write({ type: 'ping' })) {
					finish();
				}
			}, PING_MS);
		},

		cancel() {
			stop?.();
			leave?.();
		}
	});

	return new Response(stream, { headers: SSE_HEADERS });
}
