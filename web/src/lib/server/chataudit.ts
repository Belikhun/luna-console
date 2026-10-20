// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Who read which chat, and when: every console or agent read of player chat is
 * noted in the console journal, so the most private data the cluster keeps has
 * a trail of its own.
 *
 * A chat tab polls and a player screen pages through history, so a read is
 * recorded once per account and scope per `CHAT_AUDIT_EVERY_MS`, not per request;
 * the first read of a scope after that gap is always recorded.
 */

import { authorizeMany } from '$core/iam';
import { ROOT_ACTOR } from '$core/accounts';
import { resourceId } from '$shared/iam/resources';

import { journal } from './session';

/** How often one account's reads of one scope are journalled. */
export const CHAT_AUDIT_EVERY_MS = 10 * 60 * 1000;

const lastNoted = new Map<string, number>();

/**
 * Note a chat read in the journal, throttled per account and scope. `scope` is
 * what was read, e.g. `chat of survival` or `chat history of Notch`.
 */
export function noteChatRead(actor: string | undefined, scope: string, via: 'console' | 'agent' = 'console'): void {
	const who = actor ?? ROOT_ACTOR;
	const key = `${who}|${scope}|${via}`;
	const now = Date.now();
	const last = lastNoted.get(key) ?? 0;

	if (now - last < CHAT_AUDIT_EVERY_MS) {
		return;
	}

	lastNoted.set(key, now);

	journal(`${who} read ${scope}${via === 'agent' ? ' through Mèo Béo' : ''}`, { actor: who, detail: 'chat' });
}

/**
 * Keep the chat lines an account may read: one decision per distinct server,
 * from `chat:Read` on `luna:chat/<server>`. What every route or tool that
 * returns lines from several servers runs before answering.
 */
export async function readableChat<T>(
	username: string | undefined,
	entries: T[],
	serverOf: (entry: T) => string
): Promise<T[]> {
	if (entries.length === 0) {
		return entries;
	}

	const who = username ?? ROOT_ACTOR;
	const servers = [...new Set(entries.map(serverOf))];
	const allowed = await authorizeMany(who, 'chat:Read', servers.map((server) => resourceId('chat', server)));

	return entries.filter((entry) => allowed[resourceId('chat', serverOf(entry))]);
}
