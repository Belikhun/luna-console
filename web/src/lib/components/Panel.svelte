<script lang="ts">
	import type { Snippet } from 'svelte';

	/** Content container: rounded panel with optional header row and flush body. */
	let {
		title,
		count,
		description,
		flush = false,
		actions,
		children
	}: {
		title?: string;
		count?: string | number;
		description?: string;
		/** flush = no body padding (tables) */
		flush?: boolean;
		actions?: Snippet;
		children: Snippet;
	} = $props();
</script>

<div class="panel">
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
	<div class="bd" class:flush>{@render children()}</div>
</div>

<style lang="scss">
	.panel {
		background: var(--bg-panel);
		border: 0.1rem solid var(--border-divider);
		border-radius: var(--radius-container);
		overflow: hidden;
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
	}
</style>
