<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import type { DistributionSegment } from './distribution';

	/**
	 * A stacked proportional bar: one slice per segment, widths in proportion to
	 * their counts, with an optional legend underneath.
	 *
	 * Segments carrying a zero count are dropped rather than rendered at zero
	 * width; a legend listing every state an addon could theoretically be in is
	 * noise next to a bar that shows the two it actually is.
	 */
	let {
		segments,
		legend = true,
		empty = 'nothing to show'
	}: {
		segments: DistributionSegment[];
		legend?: boolean;
		/** shown in place of the bar when every segment is zero */
		empty?: string;
	} = $props();

	const shown = $derived(segments.filter((segment) => segment.count > 0));
	const total = $derived(shown.reduce((sum, segment) => sum + segment.count, 0));
</script>

{#if total === 0}
	<div class="empty">{empty}</div>
{:else}
	<div class="track" role="img" aria-label={shown.map((s) => `${s.count} ${s.label ?? s.key}`).join(', ')}>
		{#each shown as segment (segment.key)}
			<div
				class="slice"
				style:width="{(segment.count / total) * 100}%"
				style:background={segment.color}
				title="{segment.count} {segment.label ?? segment.key}"
			></div>
		{/each}
	</div>

	{#if legend}
		<div class="legend">
			{#each shown as segment (segment.key)}
				<span class="item">
					<span class="dot" style:background={segment.color}></span>
					<span class="count">{segment.count}</span>
					<span class="name">{segment.label ?? segment.key}</span>
				</span>
			{/each}
		</div>
	{/if}
{/if}

<style lang="scss">
	// matches OverviewCell's own progress bar, so a cell reads the same whether
	// its value is one number or a distribution
	.track {
		display: flex;
		height: 0.5rem;
		background: var(--bg-bar);
		border-radius: 0.25rem;
		overflow: hidden;
		margin: 0.375rem 0;
	}

	.slice {
		height: 100%;
		min-width: 0.125rem;
		transition: width 0.4s ease;

		// hairline between neighbouring slices, so two similar tones still read as
		// two; drawn inside the slice to avoid widening the track
		& + .slice {
			box-shadow: inset 0.1rem 0 0 var(--bg-panel);
		}
	}

	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.75rem;
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.item {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		white-space: nowrap;
	}

	.dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		flex: none;
	}

	.count {
		color: var(--text);
		font-variant-numeric: tabular-nums;
	}

	.empty {
		font-size: 0.75rem;
		color: var(--text-secondary);
	}
</style>
