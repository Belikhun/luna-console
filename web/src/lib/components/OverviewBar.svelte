<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import type { Snippet } from 'svelte';

	/** Overview hero: horizontal cells separated by dividers.
	 *  Fill it with <OverviewCell> children. */
	let { title, children }: { title?: string; children: Snippet } = $props();
</script>

<div class="ov">
	{#if title}<div class="t">{title}</div>{/if}
	<div class="cells">{@render children()}</div>
</div>

<style lang="scss">
	.ov {
		background: var(--bg-panel);
		border: 0.1rem solid var(--border-divider);
		border-radius: var(--radius-container);
		padding: 0.875rem 1.25rem;
		margin-bottom: 1rem;
	}
	.t {
		font-weight: 700;
		color: var(--text-heading);
		font-size: 1rem;
		margin-bottom: 0.625rem;
	}

	.cells {
		display: flex;
		flex-wrap: wrap;

		// the cells are OverviewCell instances, so their class is out of scope here
		> :global(.ovc) {
			flex: 1 1 11.25rem;
			min-width: 10rem;
			padding: 0.125rem 1.5rem;
			border-left: 0.1rem solid var(--border-divider);
		}

		> :global(.ovc:first-child) {
			padding-left: 0;
			border-left: none;
		}
	}
</style>
