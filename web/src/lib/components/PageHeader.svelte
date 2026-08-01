<script lang="ts">
	import type { Snippet } from 'svelte';

	/** Page header: `Title (count) Info` + right-aligned action bar. */
	let {
		title,
		count,
		info,
		description,
		extra,
		actions
	}: {
		title: string;
		count?: string | number;
		info?: boolean;
		description?: string;
		extra?: Snippet;
		actions?: Snippet;
	} = $props();
</script>

<div class="ph">
	<div class="left">
		<h1>
			{title}
			{#if count !== undefined}<span class="counter">({count})</span>{/if}
			{#if info}<a class="info" href="#info" onclick={(event) => event.preventDefault()}>Info</a>{/if}
			{#if extra}{@render extra()}{/if}
		</h1>
		{#if description}<p class="desc">{description}</p>{/if}
	</div>
	{#if actions}
		<div class="actions">{@render actions()}</div>
	{/if}
</div>

<style lang="scss">
	.ph {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1rem;
		flex-wrap: wrap;
	}
	h1 {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		flex-wrap: wrap;
	}

	// chrome link, so it opts out of the global in-content underline
	.info {
		font-size: 0.75rem;
		font-weight: 700;
		text-decoration: none;
	}

	.desc {
		margin: 0.25rem 0 0;
		color: var(--text-secondary);
		font-size: 0.875rem;
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
</style>
