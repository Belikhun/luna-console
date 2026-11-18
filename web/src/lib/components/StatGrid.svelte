<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import type { Snippet } from 'svelte';

	import Panel from './Panel.svelte';

	/**
	 * A row of `StatTile`s in their `card` variant: one flush `Panel`, the tiles
	 * divided by hairlines rather than each wearing a card of its own. The grid
	 * wraps as the panel narrows and a wrapped row keeps its dividers.
	 */
	let {
		title,
		min = 12,
		actions,
		children
	}: {
		title?: string;
		/** The narrowest a tile gets before the row wraps, in rem */
		min?: number;
		actions?: Snippet;
		children: Snippet;
	} = $props();
</script>

<Panel {title} {actions} flush>
	<div class="stat-grid" style:--stat-min="{min}rem">
		{@render children()}
	</div>
</Panel>

<style lang="scss">
	// each tile draws its right and bottom rule; the grid reaches a hairline past
	// the panel on those two sides, so the outermost rules fall outside the
	// panel's clip and a short last row leaves no stray fill
	.stat-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(var(--stat-min), 1fr));
		margin: 0 calc(var(--hairline) * -1) calc(var(--hairline) * -1) 0;

		> :global(*) {
			border-right: var(--hairline) solid var(--border-divider);
			border-bottom: var(--hairline) solid var(--border-divider);
		}
	}
</style>
