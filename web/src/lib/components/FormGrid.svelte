<script lang="ts">
	import type { Snippet } from 'svelte';

	/** Responsive grid for form fields (info display uses InfoGrid instead). */
	let { children, cols }: { children: Snippet; cols?: number } = $props();
</script>

<div class="form-grid" style:grid-template-columns={cols ? `repeat(${cols}, 1fr)` : undefined}>
	{@render children()}
</div>

<style lang="scss">
	.form-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
		gap: 1rem 2rem;
	}
</style>
