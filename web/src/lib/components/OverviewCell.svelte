<script lang="ts">
	import type { Snippet } from 'svelte';

	import DistributionBar from './DistributionBar.svelte';
	import type { DistributionSegment } from './distribution';

	/**
	 * One cell in an OverviewBar: bold label, value line, and optionally a bar
	 * above it; either a single `progress` fill or a `segments` distribution.
	 * Passing `segments` wins; a cell has room for one bar.
	 */
	let {
		label,
		progress,
		progressColor = 'var(--success)',
		segments,
		segmentsEmpty = 'none',
		children
	}: {
		label: string;
		/** 0..1 */
		progress?: number;
		progressColor?: string;
		/** stacked breakdown, drawn in place of `progress`; brings its own legend,
		 *  which stands in for the value line when there are no children */
		segments?: DistributionSegment[];
		segmentsEmpty?: string;
		children?: Snippet;
	} = $props();
</script>

<div class="ovc">
	<div class="l">{label}</div>
	{#if segments}
		<DistributionBar {segments} empty={segmentsEmpty} />
	{:else if progress !== undefined}
		<div class="bar">
			<div
				class="fill"
				style:width="{Math.round(progress * 100)}%"
				style:background={progressColor}
			></div>
		</div>
	{/if}
	{#if children}
		<div class="v">{@render children()}</div>
	{/if}
</div>

<style lang="scss">
	.l {
		font-weight: 700;
		color: var(--text-heading);
		font-size: 0.875rem;
		margin-bottom: 0.25rem;
	}

	.v {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.bar {
		height: 0.5rem;
		background: var(--bg-bar);
		border-radius: 0.25rem;
		overflow: hidden;
		margin: 0.375rem 0;
	}

	.fill {
		height: 100%;
		border-radius: 0.25rem;
		transition: width 0.4s ease;
	}
</style>
