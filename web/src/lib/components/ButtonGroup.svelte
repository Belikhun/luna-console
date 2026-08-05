<script lang="ts">
	import type { Snippet } from 'svelte';

	/** vloom ScreenUtils.buttonGroup(): joins child buttons into one pill -
	 *  inner corners squared, thin separators between segments. */
	let { children }: { children: Snippet } = $props();
</script>

<span class="btn-group">{@render children()}</span>

<style lang="scss">
	.btn-group {
		display: inline-flex;
		flex-direction: row;
		align-items: stretch;
		gap: 0;
		isolation: isolate;

		// Squared inner corners, outer pill shape kept. The segments are Btn/SplitButton
		// instances, so every selector has to reach through :global; and a segment is
		// either the child itself or a .btn inside it.
		> :global(*:not(:first-child)),
		> :global(*:not(:first-child) .btn),
		> :global(.btn:not(:first-child)) {
			border-top-left-radius: 0;
			border-bottom-left-radius: 0;
		}

		> :global(*:not(:last-child)),
		> :global(*:not(:last-child) .btn),
		> :global(.btn:not(:last-child)) {
			border-top-right-radius: 0;
			border-bottom-right-radius: 0;
		}

		// collapse doubled borders between segments
		> :global(*:not(:first-child)) {
			margin-left: -0.125rem;
		}
	}
</style>
