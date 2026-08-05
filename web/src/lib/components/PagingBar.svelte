<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import Icon from './Icon.svelte';

	/** vloom-style paging bar: ‹ 1 … 4 5 6 … 20 › with windowing. */
	let {
		page = $bindable(1),
		max,
		show = 7,
		onchange
	}: { page: number; max: number; show?: number; onchange?: (page: number) => void } = $props();

	const mid = $derived(Math.round(show / 2));

	const items = $derived.by((): Array<number | '…'> => {
		if (max <= show) {
			return Array.from({ length: max }, (_unused, i) => i + 1);
		}

		// first and last page are always shown; the ellipses and the window around
		// the current page share whatever slots are left
		const out: Array<number | '…'> = [1];
		const dotLeft = page > mid;
		const dotRight = page < max - mid + 1;

		let inner = show - 2;

		if (dotLeft) {
			inner -= 1;
		}

		if (dotRight) {
			inner -= 1;
		}

		const half = Math.floor(inner / 2);
		const from = Math.min(Math.max(page - half, 2), max - inner);
		const to = Math.min(from + inner - 1, max - 1);

		if (dotLeft) {
			out.push('…');
		}

		for (let p = from; p <= to; p++) {
			out.push(p);
		}

		if (dotRight) {
			out.push('…');
		}

		out.push(max);

		return out;
	});

	function go(target: number): void {
		if (target < 1 || target > max || target === page) {
			return;
		}

		page = target;
		onchange?.(target);
	}
</script>

<div class="paging">
	<button class="nav" disabled={page <= 1} onclick={() => go(page - 1)} aria-label={t('web.table.previousPage')}>
		<Icon name="arrowLeft" size="0.875rem" />
	</button>
	{#each items as item, i (i)}
		{#if item === '…'}
			<span class="dot">…</span>
		{:else}
			<button class="pg" class:active={item === page} onclick={() => go(item)}>{item}</button>
		{/if}
	{/each}
	<button class="nav" disabled={page >= max} onclick={() => go(page + 1)} aria-label={t('web.table.nextPage')}>
		<Icon name="arrowRight" size="0.875rem" />
	</button>
</div>

<style lang="scss">
	.paging {
		display: flex;
		align-items: center;
		gap: 0.125rem;
		user-select: none;
	}
	.nav,
	.pg,
	.dot {
		background: none;
		border: none;
		color: var(--text);
		font-family: var(--font);
		font-size: 0.875rem;
		min-width: 1.75rem;
		height: 1.5rem;
		padding: 0 0.375rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.nav,
	.pg {
		cursor: pointer;
		border-radius: 0.375rem;
	}

	.nav {
		&:hover:not(:disabled) {
			background: var(--bg-hover);
			color: var(--text-heading);
		}

		&:disabled {
			opacity: 0.25;
			cursor: default;
		}
	}

	.pg {
		&:hover {
			background: var(--bg-hover);
			color: var(--text-heading);
		}

		&.active {
			font-weight: 700;
			color: var(--text-heading);
		}
	}

	.dot {
		color: var(--text-secondary);
	}
</style>
