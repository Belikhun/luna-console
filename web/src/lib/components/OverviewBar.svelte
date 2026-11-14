<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { onMount, type Snippet } from 'svelte';

	/** Overview hero: horizontal cells separated by dividers.
	 *  Fill it with <OverviewCell> children. */
	let { title, children }: { title?: string; children: Snippet } = $props();

	let cells: HTMLDivElement | undefined = $state();

	/**
	 * A cell that wraps onto a new row starts that row, so it loses the divider
	 * and the indent the first cell never had. CSS cannot tell which cell begins
	 * a wrapped row, so the rows are read off the cells' offsets on every resize.
	 */
	function markRows(): void {
		if (!cells) {
			return;
		}

		let top: number | null = null;

		for (const cell of Array.from(cells.children) as HTMLElement[]) {
			const starts = top === null || cell.offsetTop > top + 1;

			cell.classList.toggle('row-start', starts);
			top = cell.offsetTop;
		}
	}

	onMount(() => {
		const observer = new ResizeObserver(() => markRows());

		if (cells) {
			observer.observe(cells);

			for (const cell of Array.from(cells.children)) {
				observer.observe(cell);
			}
		}

		markRows();

		return () => observer.disconnect();
	});
</script>

<div class="ov">
	{#if title}<div class="t">{title}</div>{/if}
	<div class="cells" bind:this={cells}>{@render children()}</div>
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
		row-gap: 0.75rem;

		// the cells are OverviewCell instances, so their class is out of scope here
		> :global(.ovc) {
			flex: 1 1 11.25rem;
			min-width: 10rem;
			padding: 0.125rem 1.5rem;
			border-left: 0.1rem solid var(--border-divider);
		}

		// a cell holding a name people read whole, such as an address
		> :global(.ovc.wide) {
			flex: 2 1 16rem;
		}

		// the first cell, and the first of every wrapped row
		> :global(.ovc:first-child),
		> :global(.ovc.row-start) {
			padding-left: 0;
			border-left: none;
		}
	}
</style>
