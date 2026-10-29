// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/** Menu model shared by ContextMenu, Dropdown and SplitButton. */
export interface ContextMenuItem {
	/** stable key; defaults to the label */
	id?: string;
	label?: string;
	icon?: string;
	/** provider brand mark (see brands.ts); drawn instead of a glyph icon */
	brand?: string;
	/** tints the icon and label; "default" keeps the muted body colour */
	color?: 'default' | 'accent' | 'success' | 'warning' | 'danger';
	disabled?: boolean;
	/** why the item is unavailable; shown as the row's tooltip. A disabled
	 *  action must say what would make it available (DESIGN.md §5.2). */
	hint?: string;
	/** renders a divider line instead of a row */
	separator?: boolean;
	/** renders a non-interactive section title */
	header?: boolean;
	/** nested menu, opened on hover/right arrow */
	submenu?: ContextMenuItem[];
	/** async actions keep the row in a spinner state until they settle */
	action?: () => void | Promise<void>;
}

/**
 * A menu built from groups, one divider between each pair; a group left empty
 * (its verbs did not apply) takes no divider with it. The groups follow the
 * order DESIGN.md §5.4 sets: open, state, change, copy, remove.
 *
 * @param groups each group's items, empty ones allowed
 * @returns the joined menu
 */
export function menuGroups(...groups: ContextMenuItem[][]): ContextMenuItem[] {
	const out: ContextMenuItem[] = [];

	for (const group of groups) {
		if (group.length === 0) {
			continue;
		}

		if (out.length > 0) {
			out.push({ separator: true });
		}

		out.push(...group);
	}

	return out;
}

/**
 * A menu as it is drawn: no divider at either end or next to another, no
 * header left with nothing under it, no submenu without rows. Conditional
 * items are then safe to leave out anywhere without stranding a divider.
 *
 * @param items the menu as a screen declared it
 * @returns the menu with the dangling chrome dropped, submenus included
 */
export function tidyMenu(items: ContextMenuItem[]): ContextMenuItem[] {
	const rows: ContextMenuItem[] = [];

	for (const item of items) {
		if (!item.submenu) {
			rows.push(item);

			continue;
		}

		const submenu = tidyMenu(item.submenu);

		if (submenu.length > 0) {
			rows.push({ ...item, submenu });
		}
	}

	// a header whose section came out empty is followed by a divider, another
	// header, or nothing at all; dropped before the dividers are collapsed,
	// since its going can put two of them side by side
	const kept = rows.filter((item, index) => {
		if (!item.header) {
			return true;
		}

		const next = rows[index + 1];

		return !!next && !next.separator && !next.header;
	});

	const out: ContextMenuItem[] = [];

	for (const item of kept) {
		const last = out[out.length - 1];

		if (item.separator && (!last || last.separator)) {
			continue;
		}

		out.push(item);
	}

	while (out.length > 0 && out[out.length - 1]!.separator) {
		out.pop();
	}

	return out;
}

/**
 * Split a menu at its dividers.
 *
 * @param items a menu, separators included
 * @returns the groups between the dividers, empty ones dropped
 */
export function splitMenuGroups(items: ContextMenuItem[]): ContextMenuItem[][] {
	const groups: ContextMenuItem[][] = [[]];

	for (const item of items) {
		if (item.separator) {
			groups.push([]);

			continue;
		}

		groups[groups.length - 1]!.push(item);
	}

	return groups.filter((group) => group.length > 0);
}

export type MenuAnchor = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';

/** What the registry needs of a menu: a way to shut it. */
export interface ClosableMenu {
	close: () => void;
}

/**
 * The one top-level menu allowed open at a time.
 *
 * Ported from the dashboard's `app.currentContextMenu` (src/libs.js): opening a
 * menu closes whatever was open before it. Without this, every trigger owns its
 * own menu and a second click elsewhere leaves the first one hanging over the
 * page; two menus, two highlighted triggers, and a click that dismisses only
 * one of them.
 *
 * Submenus never register: they belong to their parent and close with it.
 */
let current: ClosableMenu | null = null;

/** Close the menu currently open (if any) and take its place. */
export function claimMenu(menu: ClosableMenu): void {
	if (current && current !== menu) {
		current.close();
	}

	current = menu;
}

/** Give up the slot, if this menu still holds it. */
export function releaseMenu(menu: ClosableMenu): void {
	if (current === menu) {
		current = null;
	}
}

/** Close whatever is open; used when something else takes over the screen. */
export function closeOpenMenu(): void {
	current?.close();
}

/** Viewport margin kept free when a menu is clamped back on screen (in px). */
export const MENU_EDGE_MARGIN = 16;

/**
 * Clamp a menu box to the viewport, mirroring the dashboard's setPosition():
 * the anchor decides which corner of the menu sits on (top, left).
 */
export function clampMenu(
	top: number,
	left: number,
	width: number,
	height: number,
	anchor: MenuAnchor
): { top: number; left: number } {
	const isTop = anchor === 'topLeft' || anchor === 'topRight';
	const isLeft = anchor === 'topLeft' || anchor === 'bottomLeft';
	const margin = MENU_EDGE_MARGIN;

	const x = isLeft
		? Math.max(margin, Math.min(left, window.innerWidth - width - margin))
		: Math.max(margin, left - width);

	const y = isTop
		? Math.max(margin, Math.min(top, window.innerHeight - height - margin))
		: Math.max(margin, top - height);

	return { top: y, left: x };
}
