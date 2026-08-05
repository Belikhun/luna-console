<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	/**
	 * Progress bar modelled on the dashboard's createProgressBar() (left/right
	 * caption row, warning zone, colour states, animated width) at this
	 * console's proportions. `compact` renders the caption inline with the track
	 * so it fits inside a table cell.
	 */
	let {
		value = 0,
		max = 100,
		left,
		right,
		color = 'accent',
		warningZone = 0,
		compact = false,
		transition = true,
		width
	}: {
		value?: number;
		max?: number;
		/** caption on the left of the track (or before it when compact) */
		left?: string;
		/** caption on the right; defaults to the rounded percentage */
		right?: string | null;
		color?: 'accent' | 'success' | 'warning' | 'danger' | 'auto';
		/** percentage of the track flagged as the danger region */
		warningZone?: number;
		compact?: boolean;
		transition?: boolean;
		width?: string;
	} = $props();

	const pct = $derived(Math.max(0, Math.min(100, max > 0 ? (value / max) * 100 : 0)));

	// 'auto' picks the tone from how full the bar is; the same thresholds the
	// dashboard uses for disk and heap gauges
	const tone = $derived(
		color !== 'auto'
			? color
			: pct >= 90
				? 'danger'
				: pct >= 75
					? 'warning'
					: 'accent'
	);

	const rightText = $derived(right === null ? '' : (right ?? `${Math.round(pct)}%`));
</script>

<div class="pb" class:compact class:noTransition={!transition} style:width={width}>
	{#if !compact && (left || rightText)}
		<div class="caption">
			<span class="left">{left ?? ''}</span>
			<span class="right">{rightText}</span>
		</div>
	{/if}
	{#if compact && left}<span class="inline-left">{left}</span>{/if}
	<div class="track">
		{#if warningZone > 0}<div class="zone" style:width="{warningZone}%"></div>{/if}
		<div class="bar" data-tone={tone} style:width="{pct}%"></div>
	</div>
	{#if compact && rightText}<span class="inline-right">{rightText}</span>{/if}
</div>

<style lang="scss">
	.pb {
		display: block;
		width: 100%;

		&.compact {
			display: flex;
			align-items: center;
			gap: 0.5rem;
		}
	}

	.caption {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 0.25rem;
		font-size: 0.75rem;

		.left {
			color: var(--text);
			font-weight: 700;
		}

		.right {
			color: var(--text-secondary);
		}
	}

	.inline-left,
	.inline-right {
		font-size: 0.75rem;
		color: var(--text-secondary);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		flex: none;
	}

	.inline-right {
		min-width: 2.5rem;
		text-align: right;
	}

	.track {
		position: relative;
		flex: 1;
		min-width: 2rem;
		height: 0.5rem;
		border-radius: 0.5rem;

		// the track has to read against both the panel and the table row, so it
		// sits a step lighter than the dividers
		background: var(--bg-track);
		overflow: hidden;
	}

	.zone {
		position: absolute;
		top: 0;
		right: 0;
		height: 100%;
		background: color-mix(in srgb, var(--error) 25%, transparent);
	}

	.bar {
		position: absolute;
		top: 0;
		left: 0;
		height: 100%;
		border-radius: 0.5rem;
		background: var(--link);
		transition:
			width 0.4s cubic-bezier(0.16, 1, 0.3, 1),
			background-color 0.3s ease;

		&[data-tone='success'] {
			background: var(--success);
		}

		&[data-tone='warning'] {
			background: var(--warning);
		}

		&[data-tone='danger'] {
			background: var(--error);
		}
	}

	// a bar that is re-rendered on every poll must not animate its width, or it
	// never catches up with the value
	.noTransition .bar {
		transition: background-color 0.3s ease;
	}
</style>
