<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import type { Snippet } from 'svelte';

	import { t } from '$lib/i18n.svelte';

	import { fmtValue, type Series, type SeriesUnit } from './chart';
	import Icon from './Icon.svelte';
	import InfoPopover from './InfoPopover.svelte';
	import MiniSpark from './MiniSpark.svelte';
	import { statDelta, type StatDeltaInput } from './stattile';
	import type { PopoverDetail } from './statusbadge';

	/**
	 * One figure: the value in its unit, the change against the previous
	 * window, and a small trend, a limit bar or a quieter second line.
	 *
	 * `card` is a cell of a `StatGrid` (a flush panel of tiles divided by
	 * hairlines), with its own label. `inline` sits inside an `OverviewCell`,
	 * which already carries the label, so it draws only the figure and what
	 * follows it.
	 *
	 * The change's colour says whether its direction is good for this figure and
	 * an arrow says the direction, so colour never carries it alone. A figure
	 * nobody measured is a dash with no change.
	 */
	let {
		label,
		value,
		unit = 'count',
		delta,
		compareLabel,
		spark,
		tone = 'default',
		secondary,
		progress,
		href,
		info,
		loading = false,
		variant = 'card',
		formatValue,
		strip
	}: {
		label: string;
		value: number | null;
		unit?: SeriesUnit;
		/** The change against the previous window; `deltaBetween` builds it */
		delta?: StatDeltaInput | null;
		/** What the change is against: "against the 24 hours before" */
		compareLabel?: string;
		spark?: Series;
		/** A figure that is itself a state (an error rate past 5%) */
		tone?: 'default' | 'warning' | 'critical';
		/** A quieter line under the figure: "of 512 MB" */
		secondary?: string;
		/** 0 to 1, a bar under the figure (memory of its limit); wins over the spark */
		progress?: number;
		href?: string;
		/** An explanation behind the label's dashed underline; a linked card has none, since a button cannot sit inside a link */
		info?: PopoverDetail;
		loading?: boolean;
		variant?: 'card' | 'inline';
		formatValue?: (value: number) => string;
		/** A drawing of its own in the chart's place (a run of uptime days); wins over the spark */
		strip?: Snippet;
	} = $props();

	const shown = $derived(
		value === null
			? '–'
			: formatValue
				? formatValue(value)
				: fmtValue(value, unit)
	);

	const change = $derived(value === null || !delta ? null : statDelta(delta));

	const progressTone = $derived(
		progress === undefined
			? 'default'
			: progress >= 0.9
				? 'critical'
				: progress >= 0.75
					? 'warning'
					: 'default'
	);
</script>

{#snippet body()}
	{#if variant === 'card'}
		<span class="label">
			{#if info && !href}
				<InfoPopover detail={info}>{label}</InfoPopover>
			{:else}
				{label}
			{/if}
		</span>
	{/if}

	<span class="figure">
		{#if loading && value === null}
			<span class="value none" aria-busy="true">{t('web.chart.loading')}</span>
		{:else}
			<span class="value" class:none={value === null} data-tone={tone}>
				{#if tone !== 'default' && value !== null}
					<Icon name="triangleExclamation" />
				{/if}
				{shown}
			</span>
		{/if}

		{#if change}
			<span class="delta" data-tone={change.tone}>
				{#if change.direction !== 'flat'}
					<Icon name={change.direction === 'up' ? 'arrowUp' : 'arrowDown'} />
				{/if}
				{change.points
					? t('web.chart.points', { value: change.text })
					: change.text}
			</span>
		{/if}
	</span>

	{#if strip}
		<span class="strip">{@render strip()}</span>
	{:else if progress !== undefined}
		<span class="progress" data-tone={progressTone}>
			<i style:width="{Math.min(100, Math.max(0, progress * 100))}%"></i>
		</span>
	{:else if spark}
		<MiniSpark series={spark} {label} width={variant === 'card' ? 7 : 6} height={variant === 'card' ? 1.5 : 1.25} tone={tone === 'default' ? undefined : tone} {formatValue} />
	{/if}

	{#if secondary || (change && compareLabel) || (value === null && !loading)}
		<span class="foot">
			{#if value === null && !loading}
				{t('web.chart.notMeasured')}
			{:else if secondary}
				{secondary}
			{:else}
				{compareLabel}
			{/if}
		</span>
	{/if}
{/snippet}

{#if href}
	<a class="stat-tile link {variant}" {href} aria-label={variant === 'inline' ? label : undefined}>
		{@render body()}
	</a>
{:else}
	<div class="stat-tile {variant}" role={variant === 'inline' ? 'group' : undefined} aria-label={variant === 'inline' ? label : undefined}>
		{@render body()}
	</div>
{/if}

<style lang="scss">
	.stat-tile {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		min-width: 0;
		color: var(--text);
		text-decoration: none;

		&.card {
			padding: 0.875rem 1.25rem;
			background: var(--bg-panel);
		}

		&.link {
			&:hover {
				color: var(--text);

				.value {
					text-decoration: underline;
					text-decoration-thickness: auto;
					text-underline-offset: 0.25rem;
				}
			}

			&:focus-visible {
				@include focus-ring;
			}
		}

		&.card.link:hover {
			background: var(--bg-panel-raised);
		}
	}

	.label {
		@include ellipsis;

		font-size: 0.875rem;
		font-weight: 700;
		color: var(--text-heading);
	}

	.figure {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.25rem 0.5rem;
	}

	// proportional figures: a big number in tabular digits looks loose
	.value {
		display: inline-flex;
		align-items: baseline;
		gap: 0.375rem;
		font-size: 1.5rem;
		font-weight: 700;
		line-height: 1.2;
		color: var(--text-heading);

		.inline & {
			font-size: 1.125rem;
		}

		:global(icon) {
			font-size: 0.875rem;
		}

		&[data-tone='warning'] :global(icon) {
			color: var(--warning);
		}

		&[data-tone='critical'] {
			color: var(--error);
		}

		&[data-tone='critical'] :global(icon) {
			color: var(--error);
		}

		&.none {
			color: var(--text-disabled);
			font-weight: 400;
		}
	}

	.delta {
		display: inline-flex;
		align-items: baseline;
		gap: 0.25rem;
		font-size: 0.8125rem;
		font-weight: 700;
		color: var(--text-secondary);
		white-space: nowrap;

		:global(icon) {
			font-size: 0.625rem;
		}

		&[data-tone='good'] {
			color: var(--success);
		}

		&[data-tone='bad'] {
			color: var(--error);
		}
	}

	// a drawing the screen hands in, as wide as the tile
	.strip {
		display: block;
		width: 100%;
		max-width: 9rem;
	}

	.progress {
		display: block;
		height: 0.375rem;
		border-radius: 0.25rem;
		background: var(--bg-bar);
		overflow: hidden;

		i {
			display: block;
			height: 100%;
			border-radius: 0.25rem;
			background: var(--success);
		}

		&[data-tone='warning'] i {
			background: var(--warning);
		}

		&[data-tone='critical'] i {
			background: var(--error);
		}
	}

	.foot {
		@include ellipsis;

		font-size: 0.75rem;
		color: var(--text-secondary);
	}
</style>
