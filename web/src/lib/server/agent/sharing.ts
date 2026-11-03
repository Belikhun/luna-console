// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * What a shared conversation shows to whom.
 *
 * Every agent route resolves the caller's role in the conversation here before
 * doing anything: the owner, a collaborator (may write) or a viewer (may read
 * and follow). An account with no role gets the same 404 as for an id that
 * does not exist.
 *
 * A tool's result reflects the permissions of the account whose run made the
 * call: a listing is already cut down to what that account may see, a log is
 * one it may read. So a luna tool's output is shown only to that account (the
 * run's `actor`; an entry without one predates sharing and is the owner's).
 * Whether the call itself was allowed for the reader says nothing about the
 * result, since the same `cluster_status` answers differently per account. Its
 * input, which only names what was asked for, is shown to anyone whose own
 * policies would allow that exact call (`TOOL_IAM`). The console's own tools
 * (checklist, helpers, questions, screens) carry no cluster data of their own
 * and are shown to all; so are the agent's words, which the share dialog says.
 */

import { error } from '@sveltejs/kit';

import { listAgentConversations } from '$core/agent';
import type { AgentConversationView, AgentEntry, AgentRole } from '$core/agent';
import { getAccount } from '$core/accounts';
import type { AvatarSubject } from '$lib/components/accountavatar';
import { AGENT_ASK_TOOL, AGENT_LOCAL_TOOLS, AGENT_SCREENSHOT_TOOL } from '$shared/agent';
import { refuseFor, toolChecks } from '$lib/server/mcp/iam';

/** What a withheld tool result is replaced with; the panel words it in the reader's language. */
export const REDACTED = '#redacted';

/** The conversation as the account sees it, or a 404 when it may not open it. */
export async function conversationFor(locals: App.Locals, id: string): Promise<{ account: string; conversation: AgentConversationView }> {
	if (!locals.account) {
		throw error(401, 'sign in first');
	}

	const account = locals.account.username;
	const conversation = (await listAgentConversations(account)).find((entry) => entry.id === id);

	if (!conversation) {
		throw error(404, 'no such conversation');
	}

	return { account, conversation };
}

/** As `conversationFor`, refusing a role not in `roles` with a 403 that names it. */
export async function requireRole(
	locals: App.Locals,
	id: string,
	roles: readonly AgentRole[]
): Promise<{ account: string; conversation: AgentConversationView }> {
	const found = await conversationFor(locals, id);

	if (!roles.includes(found.conversation.role)) {
		throw error(403, `a ${found.conversation.role} of this conversation cannot do that`);
	}

	return found;
}

/** Whether a tool's contents are the console's own (screens, checklist, helpers, questions), never cluster data. */
function local(name: string): boolean {
	return AGENT_LOCAL_TOOLS.includes(name) || name === AGENT_ASK_TOOL;
}

/** What of one tool call a reader may see. */
export interface ToolSight {
	input: boolean;
	output: boolean;
	/** The pictures it returned; a screenshot is of its actor's screen, so it is theirs alone */
	images: boolean;
}

/**
 * A decider for one reader of one conversation. Decisions are cached per call
 * id, since a call's later events carry neither its input nor (always) its
 * actor to judge by.
 */
export function toolVisibility(
	account: string,
	conversation: Pick<AgentConversationView, 'owner'>
): (id: string, name: string, input: unknown, actor: string | undefined) => Promise<ToolSight> {
	const decided = new Map<string, ToolSight>();

	return async (id, name, input, actor) => {
		const known = decided.get(id);

		if (known) {
			return known;
		}

		const mine = (actor ?? conversation.owner) === account;
		let sight: ToolSight;

		if (mine || local(name)) {
			sight = { input: true, output: true, images: mine || name !== AGENT_SCREENSHOT_TOOL };
		} else {
			const checks = toolChecks(name, (input ?? {}) as Record<string, unknown>);
			const allowed = checks !== null && (await refuseFor(account, checks).catch(() => ({}))) === null;

			sight = { input: allowed, output: false, images: false };
		}

		decided.set(id, sight);

		return sight;
	};
}

/** A transcript with the tool contents its reader may not see withheld. */
export async function redactEntries(
	entries: AgentEntry[],
	account: string,
	conversation: Pick<AgentConversationView, 'owner'>
): Promise<AgentEntry[]> {
	const sight = toolVisibility(account, conversation);
	const out: AgentEntry[] = [];

	for (const entry of entries) {
		if (entry.kind !== 'tool') {
			out.push(entry);

			continue;
		}

		const seen = await sight(entry.id, entry.name, entry.input, entry.actor);

		out.push({
			...entry,
			...(seen.input ? {} : { input: undefined }),
			...(seen.output ? {} : { output: REDACTED }),
			...(seen.images ? {} : { images: undefined })
		});
	}

	return out;
}

/**
 * The accounts a conversation's readers see, keyed by username: its owner, the
 * accounts it is shared with and anybody whose message is in the transcript
 * (a share taken back still leaves their words). Only what a picture needs is
 * passed on; an account since deleted is left out and drawn from its initials.
 */
export async function conversationPeople(
	conversation: AgentConversationView,
	entries: AgentEntry[]
): Promise<Record<string, AvatarSubject>> {
	const names = new Set<string>([conversation.owner]);

	for (const share of conversation.shares ?? []) {
		names.add(share.account);
	}

	for (const entry of entries) {
		if (entry.kind === 'user' && entry.author) {
			names.add(entry.author);
		}
	}

	const people: Record<string, AvatarSubject> = {};

	await Promise.all(
		[...names].map(async (name) => {
			const account = await getAccount(name).catch(() => undefined);

			if (!account) {
				return;
			}

			people[account.username] = {
				id: account.id,
				username: account.username,
				displayName: account.displayName,
				avatar: account.avatar
			};
		})
	);

	return people;
}
