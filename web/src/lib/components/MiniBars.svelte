<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { tooltip } from '$lib/tooltip.svelte';

	/**
	 * Counts per step as quiet columns for a table cell, `MiniSpark`'s sibling:
	 * each column in the muted tone, its `alerts` share (the 5xx answers of an
	 * hour) drawn from the baseline up in the critical colour, so red shows only
	 * where something failed. A step nothing measured is a full-height column in
	 * the gap tone; a step with zero is the baseline alone. Each chart scales to
	 * its own highest column.
	 */
	let {
		values,
		alerts,
		label,
		hint,
		width = 3,
		height = 1.5,
		tip = true
	}: {
		/** One count per step, oldest first; null where nothing was measured */
		values: (number | null)[];
		/** The part of each step to mark, same length */
		alerts?: (number | null)[];
		/** What the columns count, for screen readers when there is no hint */
		label: string;
		/** The sentence read out and shown on hover */
		hint?: string;
		/** rem */
		width?: number;
		/** rem */
		height?: number;
		/** Whether the chart shows its sentence as its own tooltip; off when the cell around it carries it */
		tip?: boolean;
	} = $props();

	// columns 3 units wide with a 1 unit gap; the height is in the same units
	const BAR = 3;
	const GAP = 1;
	const H = 20;

	const W = $derived(Math.max(1, values.length * (BAR + GAP) - GAP));

	/** The shortest visible column, in viewBox units: 0.125rem of the chart's height. */
	const minimum = $derived((0.125 / height) * H);

	const bars = $derived.by(() => {
		const measured = values.filter((value): value is number => value !== null);
		const top = Math.max(1, ...measured);

		return values.map((value, index) => {
			const x = index * (BAR + GAP);

			if (value === null) {
				return { x, gap: true, total: H, alert: 0 };
			}

			const total = value > 0
				? Math.max(minimum, (value / top) * H)
				: 0;
			const share = alerts?.[index] ?? 0;
			const alert = share > 0
				? Math.min(total, Math.max(minimum, (share / top) * H))
				: 0;

			return { x, gap: false, total, alert };
		});
	});

	const sentence = $derived(hint ?? label);
</script>

{#snippet chart()}
	<svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" aria-hidden="true">
		{#each bars as bar, index (index)}
			{#if bar.gap}
				<rect class="gap" x={bar.x} y={0} width={BAR} height={H} />
			{:else if bar.total > 0}
				<rect class="all" x={bar.x} y={H - bar.total} width={BAR} height={bar.total} />
				{#if bar.alert > 0}
					<rect class="alert" x={bar.x} y={H - bar.alert} width={BAR} height={bar.alert} />
				{/if}
			{/if}
		{/each}
	</svg>
{/snippet}

{#if tip}
	<span
		class="mini-bars"
		style:width="{width}rem"
		style:height="{height}rem"
		role="img"
		aria-label={sentence}
		use:tooltip={{ content: sentence }}
	>
		{@render chart()}
	</span>
{:else}
	<span class="mini-bars" style:width="{width}rem" style:height="{height}rem" role="img" aria-label={sentence}>
		{@render chart()}
	</span>
{/if}

<style lang="scss">
	.mini-bars {
		display: inline-block;
		flex: none;
		vertical-align: middle;
		box-sizing: border-box;
		border-bottom: 0.1rem solid var(--chart-grid);

		svg {
			display: block;
			width: 100%;
			height: 100%;
		}
	}

	.all {
		fill: var(--chart-muted);
	}

	.alert {
		fill: var(--chart-critical);
	}

	.gap {
		fill: var(--chart-gap);
	}
</style>
