<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { tooltip } from '$lib/tooltip.svelte';

	import { fmtValue, type Series } from './chart';

	/**
	 * A bare trend for a table cell or a stat tile: one quiet line, broken where
	 * nothing was measured, and a dot in the accent on the newest reading. No
	 * axes and no crosshair; hovering it gives the lowest, highest and newest
	 * values. Luna's `Sparkline` stays the chart for a panel of its own.
	 */
	let {
		series,
		label,
		width = 5,
		height = 1.25,
		tone,
		formatValue,
		ceiling,
		hint: given,
		tip = true
	}: {
		series: Series;
		/** What the line is the trend of, for screen readers and the hint */
		label: string;
		/** rem */
		width?: number;
		/** rem */
		height?: number;
		/** The newest dot's colour, when the figure is itself a state */
		tone?: 'warning' | 'critical';
		formatValue?: (value: number) => string;
		/** The top of the scale (a memory limit), so a line near the top means full; the series' highest value when absent */
		ceiling?: number;
		/** The sentence read out and shown on hover, in place of the built-in one */
		hint?: string;
		/** Whether the line shows its sentence as its own tooltip; off when the cell around it carries it */
		tip?: boolean;
	} = $props();

	const W = 100;
	const H = 20;

	const measured = $derived(
		series.points.filter((point) => point[1] !== null) as Array<[number, number]>
	);

	function format(value: number): string {
		return formatValue
			? formatValue(value)
			: fmtValue(value, series.unit);
	}

	const shape = $derived.by(() => {
		if (measured.length === 0) {
			return null;
		}

		const first = series.points[0]![0];
		const last = series.points.at(-1)![0];
		const span = Math.max(1, last - first);
		const values = measured.map((point) => point[1]);
		const low = Math.min(0, ...values);
		const high = Math.max(ceiling ?? 0, ...values);
		const range = Math.max(high - low, 1e-9);

		const px = (at: number): number => ((at - first) / span) * W;
		const py = (value: number): number => H - 1.5 - ((value - low) / range) * (H - 3);

		let path = '';
		let pen = false;

		for (const [at, value] of series.points) {
			if (value === null) {
				pen = false;
				continue;
			}

			path += `${pen ? 'L' : 'M'}${px(at).toFixed(1)},${py(value).toFixed(1)} `;
			pen = true;
		}

		// a reading with a gap on both sides draws no line, so it gets a point of its own
		const lone = series.points
			.filter(([, value], index) => value !== null
				&& (series.points[index - 1]?.[1] ?? null) === null
				&& (series.points[index + 1]?.[1] ?? null) === null)
			.map(([at, value]) => ({ left: (px(at) / W) * 100, top: (py(value!) / H) * 100 }));

		const end = measured.at(-1)!;

		// the dot claims a reading now, so a line that stopped before the end has none
		const current = series.points.at(-1)![1] !== null;

		return {
			path,
			lone,
			current,
			endLeft: (px(end[0]) / W) * 100,
			endTop: (py(end[1]) / H) * 100,
			low: Math.min(...values),
			high: Math.max(...values),
			last: end[1]
		};
	});

	const hint = $derived(
		given ?? (shape
			? t('web.chart.sparkHint', {
				label,
				low: format(shape.low),
				high: format(shape.high),
				last: format(shape.last)
			})
			: `${label}: ${t('web.chart.notMeasured')}`)
	);
</script>

{#snippet body()}
	{#if shape}
		<svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" aria-hidden="true">
			<path d={shape.path} />
		</svg>
		{#each shape.lone as point, index (index)}
			<b class="lone" style:left="{point.left}%" style:top="{point.top}%"></b>
		{/each}
		{#if shape.current}
			<i data-tone={tone} style:left="{shape.endLeft}%" style:top="{shape.endTop}%"></i>
		{/if}
	{:else}
		<span class="none" aria-hidden="true">–</span>
	{/if}
{/snippet}

{#if tip}
	<span
		class="mini-spark"
		style:width="{width}rem"
		style:height="{height}rem"
		role="img"
		aria-label={hint}
		use:tooltip={{ content: hint }}
	>
		{@render body()}
	</span>
{:else}
	<span class="mini-spark" style:width="{width}rem" style:height="{height}rem" role="img" aria-label={hint}>
		{@render body()}
	</span>
{/if}

<style lang="scss">
	.mini-spark {
		position: relative;
		display: inline-block;
		flex: none;
		vertical-align: middle;

		svg {
			display: block;
			width: 100%;
			height: 100%;
			overflow: visible;
		}

		path {
			fill: none;
			stroke: var(--chart-muted);
			stroke-width: 1.5;
			stroke-linejoin: round;
			stroke-linecap: round;
			vector-effect: non-scaling-stroke;
		}

		// the newest reading, in the accent: where the figure beside it stands now
		i {
			position: absolute;
			width: 0.375rem;
			height: 0.375rem;
			border-radius: 50%;
			background: var(--chart-1);
			box-shadow: 0 0 0 0.125rem var(--chart-surface);
			transform: translate(-50%, -50%);

			&[data-tone='warning'] {
				background: var(--chart-warning);
			}

			&[data-tone='critical'] {
				background: var(--chart-critical);
			}
		}

		.lone {
			position: absolute;
			width: 0.25rem;
			height: 0.25rem;
			border-radius: 50%;
			background: var(--chart-muted);
			transform: translate(-50%, -50%);
		}

		.none {
			color: var(--text-disabled);
		}
	}
</style>
