// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * A Mèo Béo conversation's verbs, built once for every place that lists
 * conversations (the docked panel's history, the agent screen's sidebar, a
 * popped-out window), so each offers the same things the same way. Dialogs
 * the verbs open are hosted by `AgentDialogs.svelte`; the caller passes the
 * functions that open them.
 */

import { t } from '$lib/i18n.svelte';
import { Authz } from '$lib/authz.svelte';
import { Agent, type ConversationRow } from '$lib/agent.svelte';
import { exportConversation } from '$lib/agentexport';
import { Notify } from '$lib/notifications.svelte';
import { fmtDateTime } from '$lib/format';
import type { ContextMenuItem } from './contextmenu';

export interface ConversationDialogs {
	rename: (row: ConversationRow) => void;
	share: (row: ConversationRow) => void;
	remove: (row: ConversationRow) => void;
	/** Open a branch just made from the conversation */
	branched: (id: string) => void | Promise<void>;
}

/** The verbs of one conversation, from pinning to deleting, each disabled with its reason where it does not apply. */
export function conversationVerbs(row: ConversationRow, dialogs: ConversationDialogs): ContextMenuItem[] {
	const owner = row.role === 'owner';
	const writer = row.role !== 'viewer';
	const shares = Authz.can('agent:Share');

	return [
		{
			label: row.pinned ? t('web.agentMenu.unpin') : t('web.agentMenu.pin'),
			icon: row.pinned ? 'thumbtackSlash' : 'thumbtack',
			action: () => Agent.flag(row.id, { pinned: !row.pinned })
		},
		{
			label: t('web.agentMenu.rename'),
			icon: 'pen',
			disabled: !writer,
			hint: writer ? undefined : t('web.agentMenu.viewerHint'),
			action: () => dialogs.rename(row)
		},
		{
			label: t('web.agentMenu.share'),
			icon: 'userPlus',
			disabled: !owner || !shares,
			hint: !owner
				? t('web.agentMenu.ownerOnly', { owner: row.owner })
				: !shares
					? t('web.common.notAllowed', { action: 'agent:Share' })
					: undefined,
			action: () => dialogs.share(row)
		},
		{
			label: t('web.agentMenu.branch'),
			icon: 'codeBranch',
			disabled: !owner,
			hint: owner ? undefined : t('web.agentMenu.ownerOnly', { owner: row.owner }),
			action: async () => {
				try {
					const created = await Agent.branch(row.id);

					await dialogs.branched(created);
				} catch (err) {
					Notify.error(t('web.agent.branchFailed'), { detail: (err as Error).message });
				}
			}
		},
		{
			label: t('web.agentMenu.export'),
			icon: 'fileExport',
			submenu: [
				{
					label: t('web.agentMenu.exportMarkdown'),
					action: () => exportConversation(row.id, 'markdown', t('web.agent.untitled'))
				},
				{
					label: t('web.agentMenu.exportJson'),
					action: () => exportConversation(row.id, 'json', t('web.agent.untitled'))
				}
			]
		},
		{
			label: row.archived ? t('web.agentMenu.unarchive') : t('web.agentMenu.archive'),
			icon: 'boxArchive',
			action: () => Agent.flag(row.id, { archived: !row.archived })
		},
		{ separator: true },
		owner
			? { label: t('web.agent.deleteChat'), icon: 'trash', color: 'danger', action: () => dialogs.remove(row) }
			: { label: t('web.agentMenu.leave'), icon: 'close', color: 'danger', action: () => dialogs.remove(row) }
	];
}

/** Which bucket of the list a conversation falls in by when it last changed. */
export type ConversationBucket = 'pinned' | 'today' | 'yesterday' | 'week' | 'older';

export function bucketOf(row: ConversationRow, now = new Date()): ConversationBucket {
	if (row.pinned) {
		return 'pinned';
	}

	const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const day = 24 * 60 * 60 * 1000;

	if (row.updatedAt >= midnight) {
		return 'today';
	}

	if (row.updatedAt >= midnight - day) {
		return 'yesterday';
	}

	if (row.updatedAt >= midnight - 6 * day) {
		return 'week';
	}

	return 'older';
}

export const CONVERSATION_BUCKETS: ConversationBucket[] = ['pinned', 'today', 'yesterday', 'week', 'older'];

/** Longest title a history row shows; a chat titled by a whole prompt would stretch the menu across the screen. */
const HISTORY_TITLE_MAX = 56;

function shortTitle(title: string): string {
	return title.length > HISTORY_TITLE_MAX
		? `${title.slice(0, HISTORY_TITLE_MAX - 1).trimEnd()}…`
		: title;
}

/** How many conversations a history dropdown lists before the agent screen is the better place. */
const HISTORY_ROWS = 30;

/**
 * The history dropdown of the docked panel and a popped-out window: pinned
 * conversations first, then the rest by when they last changed, archived ones
 * left to the agent screen. A row opens the conversation; `more` leads there.
 */
export function historyItems(current: string | null, select: (id: string) => void, more: () => void): ContextMenuItem[] {
	const rows: ContextMenuItem[] = [{ label: t('web.agent.history'), header: true }];
	const listed = Agent.conversations
		.filter((row) => !row.archived)
		.sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.updatedAt - left.updatedAt);

	if (listed.length === 0) {
		rows.push({ label: t('web.agent.noHistory'), disabled: true });
	}

	for (const row of listed.slice(0, HISTORY_ROWS)) {
		const shared = row.role !== 'owner' || (row.shares?.length ?? 0) > 0;

		rows.push({
			id: row.id,
			label: shortTitle(row.title || t('web.agent.untitled')),
			icon: row.id === current
				? 'check'
				: row.running
					? 'paw'
					: row.pinned
						? 'thumbtack'
						: shared
							? 'userGroup'
							: undefined,
			hint: row.role === 'owner'
				? fmtDateTime(row.updatedAt)
				: `${t('web.agentScreen.sharedBy', { owner: row.owner })} · ${fmtDateTime(row.updatedAt)}`,
			action: () => select(row.id)
		});
	}

	rows.push({ separator: true });
	rows.push({ label: t('web.agentMenu.allChats'), icon: 'arrowUpRightFromSquare', action: more });

	return rows;
}
