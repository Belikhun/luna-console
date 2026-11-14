<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import type { Snippet } from 'svelte';

	/** Responsive grid for form fields (info display uses InfoGrid instead). */
	let {
		children,
		cols,
		aligned = false
	}: {
		children: Snippet;
		cols?: number;
		/**
		 * Line up the label, hint, control and error of every field in a row,
		 * however many lines each hint wraps to. Each field must hold its parts
		 * in that order, the hint always present.
		 */
		aligned?: boolean;
	} = $props();
</script>

<div
	class="form-grid"
	class:aligned
	style:grid-template-columns={cols ? `repeat(${cols}, 1fr)` : undefined}
>
	{@render children()}
</div>

<style lang="scss">
	.form-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
		gap: 1rem 2rem;

		// every field spans four rows of the grid and takes them as its own, so
		// a hint that wraps to two lines pushes the whole row's controls down
		&.aligned > :global(.field) {
			display: grid;
			grid-row: span 4;
			grid-template-rows: subgrid;
			row-gap: 0.25rem;
			align-content: start;
			margin-bottom: 0;

			> :global(*) {
				margin: 0;
			}
		}
	}
</style>
