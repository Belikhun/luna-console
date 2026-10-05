// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * What an MCP token (Mèo Béo, a bot, an editor) may delete. An agent can reach
 * a delete, but a server people have been playing on for weeks is not
 * something a program gets to remove: only a test instance, or one that is
 * genuinely new, is deletable over MCP. Operators delete anything from the
 * console or the CLI as before.
 *
 * "New" needs both signals, because each can be fooled alone: the registry's
 * `createdAt` (absent on anything created before luna recorded it, or adopted,
 * which therefore counts as long-standing) and the server's own dated log
 * files, which record every day it actually ran and which stopping the server
 * does not reset.
 */

/** An instance younger than this, by its registry record, counts as new. */
export const AGENT_DELETE_NEW_MS = 7 * 24 * 60 * 60 * 1000;

/** A server that has run on this many distinct days is in use, however new. */
export const AGENT_DELETE_MAX_RUN_DAYS = 3;

/** What the rule is decided from, gathered by the caller. */
export interface DeletionFacts {
	createdAt?: number;
	test?: boolean;
	/** Proxy-registered but run elsewhere; luna owns none of it */
	external?: boolean;
	/** The cluster's proxy */
	proxy?: boolean;
	/** Distinct days (YYYY-MM-DD) the server's own logs record it running */
	runDays: string[];
	now: number;
}

/** A dated server log, the rotated name Paper, Fabric, Forge and Velocity all use. */
const DATED_LOG = /^(\d{4}-\d{2}-\d{2})-\d+\.log(\.gz)?$/;

/**
 * The distinct days a server's `logs/` directory says it ran, oldest first,
 * from the entry names and modification times a directory listing gives.
 * `latest.log` counts for the day it was last written.
 */
export function logRunDays(entries: Array<{ name: string; modified: number }>): string[] {
	const days = new Set<string>();

	for (const entry of entries) {
		const dated = DATED_LOG.exec(entry.name);

		if (dated?.[1]) {
			days.add(dated[1]);

			continue;
		}

		if (entry.name === "latest.log" && entry.modified > 0) {
			days.add(new Date(entry.modified).toISOString().slice(0, 10));
		}
	}

	return [...days].sort();
}

/** Why an MCP token may not delete this instance, or null when it may. */
export function agentDeletionRefusal(name: string, facts: DeletionFacts): string | null {
	if (facts.proxy) {
		return `${name} is the proxy; it is never deleted over MCP`;
	}

	if (facts.external) {
		return `${name} is an external server luna does not own; unregister it from the console instead`;
	}

	if (facts.test) {
		return null;
	}

	const operator = "Only an operator can delete it, from the console or the CLI.";

	if (facts.createdAt === undefined) {
		return `${name} has no creation record (it predates luna recording one, or was adopted), so it counts as long-standing. ${operator}`;
	}

	const ageMs = facts.now - facts.createdAt;

	if (ageMs > AGENT_DELETE_NEW_MS) {
		const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));

		return `${name} was created ${days} days ago, so it is long-standing. ${operator}`;
	}

	if (facts.runDays.length >= AGENT_DELETE_MAX_RUN_DAYS) {
		return `${name} has run on ${facts.runDays.length} different days (since ${facts.runDays[0]}), so it is in use. ${operator}`;
	}

	return null;
}
