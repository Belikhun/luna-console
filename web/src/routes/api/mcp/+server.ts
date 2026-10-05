// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The MCP endpoint: Streamable HTTP, stateless.
 *
 * Every POST carries one JSON-RPC message (or a batch) and its own bearer token,
 * and is answered with plain JSON; there is no session id and no server-initiated
 * stream, which the transport spec allows by answering GET with 405. Stateless is
 * deliberate: a token's scope is re-read on every request, so disabling a token
 * or narrowing it takes effect on the very next call with nothing to tear down.
 *
 * The session gate in `hooks.server.ts` does not apply here (an MCP client has no
 * cookie); this route's own bearer check is the gate.
 */

import { authorizeMcpToken } from '$core/mcp';
import type { McpPrincipal } from '$core/mcp';
import { clientIp } from '$lib/server/session';
import {
	dispatch,
	isJsonRpcMessage,
	rpcError,
	RPC_INVALID_REQUEST,
	RPC_PARSE_ERROR
} from '$lib/server/mcp/protocol';
import type { JsonRpcResponse } from '$lib/server/mcp/protocol';

/** Requests one token may make per minute before it is told to slow down. */
const RATE_PER_MINUTE = 120;

/** Largest request body accepted; a tool call is a few hundred bytes. */
const MAX_BODY_BYTES = 256 * 1024;

interface Bucket {
	tokens: number;
	refilledAt: number;
}

const buckets = new Map<string, Bucket>();

/** Token bucket per MCP token: a burst of RATE_PER_MINUTE, refilled continuously. */
function takeToken(id: string): boolean {
	const now = Date.now();
	const bucket = buckets.get(id) ?? { tokens: RATE_PER_MINUTE, refilledAt: now };
	const refill = ((now - bucket.refilledAt) / 60_000) * RATE_PER_MINUTE;

	bucket.tokens = Math.min(RATE_PER_MINUTE, bucket.tokens + refill);
	bucket.refilledAt = now;

	if (bucket.tokens < 1) {
		buckets.set(id, bucket);

		return false;
	}

	bucket.tokens -= 1;
	buckets.set(id, bucket);

	return true;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers }
	});
}

function unauthorized(): Response {
	// one answer for a missing, malformed, unknown, wrong, disabled or expired token
	return jsonResponse(rpcError(RPC_INVALID_REQUEST, 'invalid or missing MCP token'), 401, {
		'www-authenticate': 'Bearer realm="luna-mcp"'
	});
}

/**
 * The transport spec's DNS-rebinding guard: a browser page on another origin must
 * not be able to drive this endpoint through a victim's network position. MCP
 * clients that are not browsers send no Origin at all, and pass.
 */
function originAllowed(request: Request, url: URL): boolean {
	const origin = request.headers.get('origin');

	if (!origin) {
		return true;
	}

	try {
		return new URL(origin).host === url.host;
	} catch {
		return false;
	}
}

async function authorize(request: Request): Promise<McpPrincipal | null> {
	const header = request.headers.get('authorization') ?? '';
	const match = /^Bearer\s+(.+)$/i.exec(header);

	if (!match) {
		return null;
	}

	return await authorizeMcpToken(match[1]!);
}

export async function POST({ request, url, getClientAddress }) {
	if (!originAllowed(request, url)) {
		return jsonResponse(rpcError(RPC_INVALID_REQUEST, 'cross-origin requests are refused'), 403);
	}

	const principal = await authorize(request);

	if (!principal) {
		return unauthorized();
	}

	if (!takeToken(principal.id)) {
		return jsonResponse(rpcError(RPC_INVALID_REQUEST, 'rate limit exceeded; slow down'), 429, {
			'retry-after': '5'
		});
	}

	const raw = await request.text();

	if (raw.length > MAX_BODY_BYTES) {
		return jsonResponse(rpcError(RPC_INVALID_REQUEST, 'request body too large'), 413);
	}

	let parsed: unknown;

	try {
		parsed = JSON.parse(raw);
	} catch {
		return jsonResponse(rpcError(RPC_PARSE_ERROR, 'request body is not JSON'), 400);
	}

	let address: string | undefined;

	try {
		address = getClientAddress();
	} catch {
		address = undefined;
	}

	const ctx = {
		principal,
		ip: clientIp(request, address),
		client: request.headers.get('user-agent')?.slice(0, 120) ?? undefined
	};

	const batch = Array.isArray(parsed);
	const messages = batch
		? (parsed as unknown[])
		: [parsed];

	if (messages.length === 0 || !messages.every(isJsonRpcMessage)) {
		return jsonResponse(rpcError(RPC_INVALID_REQUEST, 'not a JSON-RPC 2.0 message'), 400);
	}

	const responses: JsonRpcResponse[] = [];

	for (const message of messages) {
		const response = await dispatch(message, ctx);

		if (response) {
			responses.push(response);
		}
	}

	// notifications and client responses only: acknowledged with no body
	if (responses.length === 0) {
		return new Response(null, { status: 202 });
	}

	return jsonResponse(batch ? responses : responses[0]);
}

/** No server-initiated stream on a stateless server; the spec's answer is 405. */
export function GET() {
	return new Response(null, { status: 405, headers: { allow: 'POST' } });
}

/** No sessions to end. */
export function DELETE() {
	return new Response(null, { status: 405, headers: { allow: 'POST' } });
}
