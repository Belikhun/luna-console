// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { error } from '@sveltejs/kit';
import * as luna from '$core/services/luna';

/** The Luna streams the console is allowed to subscribe to. */
const STREAMS: Record<string, string> = {
	telemetry: '/dashboard/stream',
	players: '/players/stream'
};

/** Whether one SSE block is a chat line: the `chat` event, or a payload typed as one. */
function isChatBlock(block: string): boolean {
	let event = 'message';
	const data: string[] = [];

	for (const line of block.split('\n')) {
		if (line.startsWith('event:')) {
			event = line.slice(6).trim();
		} else if (line.startsWith('data:')) {
			data.push(line.slice(5).replace(/^ /, ''));
		}
	}

	if (event === 'chat') {
		return true;
	}

	try {
		return JSON.parse(data.join('\n'))?.type === 'chat';
	} catch {
		return false;
	}
}

/**
 * Pass an SSE body through block by block, dropping chat events. Blocks are
 * forwarded verbatim otherwise, keepalive comments included, so nothing a
 * screen relies on changes.
 */
function withoutChat(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = '';

	return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');

			let end = buffer.indexOf('\n\n');

			while (end >= 0) {
				const block = buffer.slice(0, end);

				buffer = buffer.slice(end + 2);
				end = buffer.indexOf('\n\n');

				if (!isChatBlock(block)) {
					controller.enqueue(encoder.encode(`${block}\n\n`));
				}
			}
		}
	}));
}

/**
 * GET ?stream=telemetry|players → pipe a LunaCore event stream through to the
 * browser.
 *
 * The body is forwarded untouched: re-framing the events here would mean parsing
 * and re-emitting them, which only adds a place for one to be dropped. The token
 * stays server-side; the browser never sees the forwarding secret.
 */
export async function GET({ url, request }) {
	const name = url.searchParams.get('stream') ?? 'telemetry';
	const path = STREAMS[name];

	if (!path) {
		throw error(400, `unknown stream: ${name}`);
	}

	let upstream: Response;

	// Handing the request's own signal to the upstream fetch is what closes our
	// connection to the proxy when the browser goes away; otherwise LunaCore keeps
	// writing to a subscriber nobody reads. The body itself can't be cancelled here:
	// returning it in a Response locks the stream.
	try {
		upstream = await luna.openStream(path, request.signal);
	} catch (err) {
		throw error(503, (err as Error)?.message ?? 'LunaCore is unreachable');
	}

	if (!upstream.ok || !upstream.body) {
		throw error(upstream.status === 401 ? 401 : 502, `LunaCore refused the stream (${upstream.status})`);
	}

	// the players stream also carries every chat line LunaCore records; the
	// console's screens only use it to notice that the roster changed, so chat
	// events never leave the server, whatever the account may read
	const body = name === 'players'
		? withoutChat(upstream.body)
		: upstream.body;

	return new Response(body, {
		headers: {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive'
		}
	});
}
