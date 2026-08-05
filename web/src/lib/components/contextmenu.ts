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
