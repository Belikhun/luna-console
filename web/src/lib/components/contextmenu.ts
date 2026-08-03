/** Menu model shared by ContextMenu, Dropdown and SplitButton. */
export interface ContextMenuItem {
	/** stable key — defaults to the label */
	id?: string;
	label?: string;
	icon?: string;
	/** provider brand mark (see brands.ts) — drawn instead of a glyph icon */
	brand?: string;
	/** tints the icon and label; "default" keeps the muted body colour */
	color?: 'default' | 'accent' | 'success' | 'warning' | 'danger';
	disabled?: boolean;
	/** why the item is unavailable — shown as the row's tooltip. A disabled
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
