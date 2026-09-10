<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

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
		flex-wrap: wrap;
		gap: 1rem;
		margin-bottom: 1rem;
	}

	// the title column is the one that gives: a long description wraps rather
	// than squeezing the action bar until its buttons drop onto a second line.
	// The basis is its floor: once the action bar would push it narrower than
	// that, the bar wraps under the title instead of leaving a one-word-per-line
	// description beside it
	.left {
		flex: 1 1 20rem;
		min-width: 0;
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
		justify-content: flex-end;
		gap: 0.5rem;
		flex: none;
		// keeps the bar on the right when it has wrapped onto its own row, and
		// bounds it there so its own wrapping below can engage instead of the
		// last buttons running off the edge
		margin-left: auto;
		max-width: 100%;

		// only a genuinely narrow viewport may stack them
		@include below($bp-medium) {
			flex-wrap: wrap;
		}
	}
</style>
