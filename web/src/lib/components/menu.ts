import type { ContextMenuItem } from './contextmenu';

/** Menu item shared by Dropdown and SplitButton. */
export interface Item {
	label: string;
	icon?: string;
	disabled?: boolean;
	/** why the item is unavailable; a disabled action states its reason rather
	 *  than leaving the user to guess (DESIGN.md §5.2) */
	hint?: string;
	danger?: boolean;
	divider?: boolean;
	action?: () => void | Promise<void>;
}

/** Adapt the flat Dropdown/SplitButton model onto the ContextMenu model. */
export function toMenuItems(items: Item[]): ContextMenuItem[] {
	return items.map((item, index) => ({
		id: item.divider ? `div${index}` : item.label,
		label: item.label,
		icon: item.icon,
		color: item.danger ? 'danger' : 'default',
		disabled: item.disabled,
		hint: item.hint,
		separator: item.divider,
		action: item.action
	}));
}
