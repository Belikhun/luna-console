<script lang="ts">
	import type { Snippet } from 'svelte';

	/** Content container: rounded panel with optional header row and flush body. */
	let {
		title,
		count,
		description,
		flush = false,
		fill = false,
		actions,
		children
	}: {
		title?: string;
		count?: string | number;
		description?: string;
		/** flush = no body padding (tables) */
		flush?: boolean;
		/**
		 * Fill the height the panel is given instead of hugging its content, and
		 * make the body a flex column so a child can take the remaining space -
		 * for a panel holding a scroller or an editor rather than a document.
		 * The caller owns the height; this only stops the panel shrinking to fit.
		 */
		fill?: boolean;
		actions?: Snippet;
		children: Snippet;
	} = $props();
</script>

<div class="panel" class:fill>
	{#if title || actions}
		<div class="hd">
			<div class="ht">
				{#if title}
					<h2>
						{title}
						{#if count !== undefined}<span class="counter">({count})</span>{/if}
					</h2>
				{/if}
				{#if description}<div class="desc">{description}</div>{/if}
			</div>
			{#if actions}<div class="acts">{@render actions()}</div>{/if}
		</div>
	{/if}
	<div class="bd" class:flush class:fill>{@render children()}</div>
</div>

<style lang="scss">
	.panel {
		background: var(--bg-panel);
		border: 0.1rem solid var(--border-divider);
		border-radius: var(--radius-container);
		overflow: hidden;

		&.fill {
			display: flex;
			flex-direction: column;

			// two ways a caller gives a fill panel its height, and both are covered:
			// `height` for a grid/block parent that already has one, `flex` for a
			// flex column where the panel takes what its siblings leave. flex-basis
			// resolves before `height` on the main axis, so they do not fight.
			height: 100%;
			flex: 1;

			// without this a child with its own scroller pushes the panel past its height
			min-height: 0;
		}
	}

	.hd {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;

		padding: 0.75rem 1.25rem;
		border-bottom: 0.1rem solid var(--border-divider);
	}

	.desc {
		color: var(--text-secondary);
		font-size: 0.75rem;
		margin-top: 0.125rem;
	}

	.acts {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		flex-wrap: wrap;
	}

	.bd {
		padding: 1rem 1.25rem;

		&.flush {
			padding: 0;
		}

		&.fill {
			display: flex;
			flex-direction: column;

			flex: 1;
			min-height: 0;
		}
	}
</style>
