/**
 * Types for `MinecraftInventory.svelte`. They live here because a type exported
 * from a component's `<script>` block does not resolve for importers.
 */

import type { SelectorStatus } from '$shared/selector';

/** One drawn slot: which server it is and what its item looks like right now. */
export interface InventorySlot {
	/** Instance name — the identity the editor works in */
	name: string;
	/** Resolved material for the status being previewed */
	item?: string;
	glint?: boolean;
	page: number;
	accentColor?: string;
	status?: SelectorStatus;
}

/** What a drag is carrying: a chip from the palette, or an item from a slot. */
export interface SlotDragSource {
	kind: 'palette' | 'slot';
	name: string;
	fromSlot?: number;
}
