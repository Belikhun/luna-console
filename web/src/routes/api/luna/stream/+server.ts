import { error } from '@sveltejs/kit';
import * as luna from '$core/services/luna';

/** The Luna streams the console is allowed to subscribe to. */
const STREAMS: Record<string, string> = {
	telemetry: '/dashboard/stream',
	players: '/players/stream'
};

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

	return new Response(upstream.body, {
		headers: {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive'
		}
	});
}
