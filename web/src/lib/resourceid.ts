// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Resource ids on screen: the `luna:<type>/<name>` a policy names a resource
 * by, shown and copied the same way on every table and summary, as AWS shows
 * an ARN, so an operator writing a policy never has to guess one.
 */

import { t } from '$lib/i18n.svelte';
import { copyText } from '$lib/clipboard';
import { Notify } from '$lib/notifications.svelte';
import { menuGroups, splitMenuGroups, type ContextMenuItem } from '$lib/components/contextmenu';

/**
 * The resource id (or ids) a table row stands for. A row may stand for several
 * resources (a plugin row groups one lock entry per family), and a row that is
 * not a resource at all answers null.
 */
export type ResourceIdOf<T> = (row: T) => string | string[] | null;

/** The id column a table gains when it is given `resourceId`. */
export const RESOURCE_ID_COLUMN = 'resourceId';

/** One or several ids as a list, empty for none. */
export function resourceIdList(value: string | string[] | null | undefined): string[] {
	if (!value) {
		return [];
	}

	return typeof value === 'string'
		? [value]
		: value;
}

/** Copy ids to the clipboard, one per line, and say so in a toast. */
export async function copyResourceIds(ids: string[]): Promise<void> {
	if (ids.length === 0) {
		return;
	}

	if (!(await copyText(ids.join('\n')))) {
		Notify.error(t('web.resourceId.copyFailed'));

		return;
	}

	const message = ids.length === 1
		? t('web.resourceId.copiedOne', { id: ids[0] ?? '' })
		: t('web.resourceId.copiedMany', { count: ids.length });

	Notify.success(message);
}

/**
 * The "Copy resource id" menu entry for some ids, disabled with its reason when
 * there are none, so an Actions dropdown keeps it while nothing is selected.
 */
export function copyResourceIdItem(ids: string[]): ContextMenuItem {
	return {
		id: 'copy-resource-id',
		label: ids.length > 1
			? t('web.resourceId.copyMany', { count: ids.length })
			: t('web.resourceId.copy'),
		icon: 'copy',
		disabled: ids.length === 0,
		hint: ids.length === 0
			? t('web.resourceId.pickFirst')
			: undefined,
		action: () => copyResourceIds(ids)
	};
}

/**
 * A menu with the copy entry added to its copy group (DESIGN.md §5.4): last
 * among the menu's own `copy-*` items when the group before the removals holds
 * only those, else a group of its own there. Removals stay the menu's last
 * rows, so the entry never sits under a delete.
 */
export function withCopyResourceId(items: ContextMenuItem[], ids: string[]): ContextMenuItem[] {
	const groups = splitMenuGroups(items);
	const entry = copyResourceIdItem(ids);

	const isRemoval = (group: ContextMenuItem[]): boolean =>
		group.every((item) => item.color === 'danger');

	const isCopy = (group: ContextMenuItem[]): boolean =>
		group.every((item) => item.id?.startsWith('copy-'));

	const removalAt = groups.length > 0 && isRemoval(groups[groups.length - 1]!)
		? groups.length - 1
		: groups.length;

	const before = groups[removalAt - 1];

	if (before && isCopy(before)) {
		before.push(entry);
	} else {
		groups.splice(removalAt, 0, [entry]);
	}

	return menuGroups(...groups);
}

/** The ids of the selected rows of a table, in row order, each once. */
export function selectedResourceIds<T>(rows: T[], resourceId: ResourceIdOf<T>): string[] {
	const out = new Set<string>();

	for (const row of rows) {
		for (const id of resourceIdList(resourceId(row))) {
			out.add(id);
		}
	}

	return [...out];
}
