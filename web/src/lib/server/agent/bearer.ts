// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Per-run bearers for Mèo Béo's calls into `/api/mcp`.
 *
 * The agent acts through an ordinary MCP token, but that token's own secret is
 * never handed to anything: each run gets a random bearer that lives only in
 * this process's memory and dies with the run. The endpoint resolves it to the
 * token's principal plus the console account the run belongs to, so the call
 * log's `onBehalfOf` is a fact the console established rather than a claim a
 * client made.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

import { getMcpToken } from '$core/mcp';
import type { McpOnBehalfOf, McpPrincipal } from '$core/mcp';

/** Prefix that tells a run bearer from a minted token's `mcp_<id>.<secret>`. */
const PREFIX = 'agent_';

interface RunGrant {
	secret: Buffer;
	tokenId: string;
	onBehalfOf: McpOnBehalfOf;
}

const grants = new Map<string, RunGrant>();

/** Issue a bearer for one run; revoke it when the run ends. */
export function issueRunBearer(tokenId: string, onBehalfOf: McpOnBehalfOf): { bearer: string; revoke: () => void } {
	const id = randomBytes(8).toString('hex');
	const secret = randomBytes(32);

	grants.set(id, { secret, tokenId, onBehalfOf });

	return {
		bearer: `${PREFIX}${id}.${secret.toString('hex')}`,
		revoke: () => {
			grants.delete(id);
		}
	};
}

/** Whether a bearer is shaped like a run bearer, so the endpoint knows which check applies. */
export function isRunBearer(bearer: string): boolean {
	return bearer.startsWith(PREFIX);
}

/**
 * Resolve a run bearer to the agent token's principal, re-reading the token so
 * that disabling or narrowing it takes effect mid-run. Null for anything that
 * does not check out, alike.
 */
export async function authorizeRunBearer(
	bearer: string
): Promise<{ principal: McpPrincipal; onBehalfOf: McpOnBehalfOf } | null> {
	const match = /^agent_([0-9a-f]{16})\.([0-9a-f]{64})$/.exec(bearer.trim());

	if (!match) {
		return null;
	}

	const grant = grants.get(match[1]!);
	const presented = Buffer.from(match[2]!, 'hex');

	if (!grant || !timingSafeEqual(grant.secret, presented)) {
		return null;
	}

	const token = await getMcpToken(grant.tokenId);

	if (!token || !token.enabled || token.expired) {
		return null;
	}

	return {
		principal: { id: token.id, name: token.name, scope: token.scope, tools: token.tools },
		onBehalfOf: grant.onBehalfOf
	};
}
