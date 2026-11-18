<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * A table cell in two lines: the value, then one dim line of context in a
	 * smaller size, so every cell of a list stacks the same way. Without `sub`
	 * the value stays alone and vertically centred; no empty line is reserved.
	 */
	let {
		main,
		sub,
		align = 'left'
	}: {
		main: Snippet;
		sub?: Snippet;
		align?: 'left' | 'right';
	} = $props();
</script>

<span class="stack" class:right={align === 'right'}>
	<span class="main">{@render main()}</span>
	{#if sub}
		<span class="sub">{@render sub()}</span>
	{/if}
</span>

<style lang="scss">
	.stack {
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 0.125rem;
		min-width: 0;
		max-width: 100%;

		&.right {
			align-items: flex-end;
			text-align: right;
		}
	}

	.main {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		min-width: 0;
		max-width: 100%;
	}

	.right .main {
		justify-content: flex-end;
	}

	.sub {
		display: block;
		max-width: 100%;
		color: var(--text-secondary);
		font-size: 0.75rem;
		font-weight: 400;
		line-height: 1rem;
		@include ellipsis;
	}
</style>
