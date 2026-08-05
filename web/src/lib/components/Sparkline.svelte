<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { fmtTime } from '$lib/format';

	/**
	 * Metric chart: title + current value above a filled line
	 * plot. Axis labels live *inside* the plot area; y ticks down the left
	 * edge, the sampled time range along the bottom; as HTML overlays, so they
	 * stay upright and legible while the svg stretches to the container. The
	 * plot's height is fixed by the wrapper; the svg is absolutely positioned
	 * inside it, since a percentage-height svg in an auto-sized box falls back
	 * to its intrinsic aspect and overflows the card.
	 */
	let {
		points,
		label,
		unit = '',
		color = 'var(--link)',
		height = 140,
		maxY
	}: {
		points: Array<{ t: number; v: number | undefined }>;
		label: string;
		unit?: string;
		color?: string;
		height?: number;
		maxY?: number;
	} = $props();

	const W = 560;
	/** vertical breathing room so a value at the top isn't clipped by the stroke */
	const PAD_Y = 3;
	const GRID = [0.25, 0.5, 0.75];

	/** headroom over the highest sample, so the peak never touches the top edge */
	const HEADROOM = 1.15;

	const valid = $derived(
		points.filter((point) => point.v !== undefined) as Array<{ t: number; v: number }>
	);

	const max = $derived(maxY ?? Math.max(1, ...valid.map((point) => point.v)) * HEADROOM);
	const last = $derived(valid.at(-1)?.v);

	const t0 = $derived(points[0]?.t ?? 0);
	const t1 = $derived(points.at(-1)?.t ?? t0 + 1);

	const scaleX = (t: number): number => ((t - t0) / Math.max(1, t1 - t0)) * W;
	const scaleY = (v: number): number => height - PAD_Y - (v / max) * (height - PAD_Y * 2);
	const gridY = (fraction: number): number =>
		height - PAD_Y - fraction * (height - PAD_Y * 2);

	// contiguous stretches of present samples: the line is drawn per run so it
	// never bridges a gap, which would read as a real (flat) measurement
	const runs = $derived.by(() => {
		const out: Array<Array<{ t: number; v: number }>> = [];
		let run: Array<{ t: number; v: number }> = [];

		for (const point of points) {
			if (point.v === undefined) {
				if (run.length) {
					out.push(run);
					run = [];
				}

				continue;
			}

			run.push({ t: point.t, v: point.v });
		}

		if (run.length) {
			out.push(run);
		}

		return out;
	});

	// each run gets a line plus the same line closed down to the baseline for the fill
	const paths = $derived.by(() =>
		runs
			.filter((run) => run.length >= 2)
			.map((run) => {
				const line = run
					.map((point, i) => {
						const command = i === 0 ? 'M' : 'L';

						return `${command}${scaleX(point.t).toFixed(1)},${scaleY(point.v).toFixed(1)}`;
					})
					.join(' ');

				const left = scaleX(run[0]!.t).toFixed(1);
				const right = scaleX(run.at(-1)!.t).toFixed(1);

				return {
					line,
					fill: `${line} L${right},${height} L${left},${height} Z`
				};
			})
	);

	/**
	 * Samples with no present neighbour to draw a line to, positioned as a % of
	 * the plot area: an isolated reading walled in by hazard bands still has to
	 * be visible, and an svg circle would be sheared into an ellipse.
	 */
	const lone = $derived(
		runs
			.filter((run) => run.length === 1)
			.map((run) => ({
				left: (scaleX(run[0]!.t) / W) * 100,
				top: (scaleY(run[0]!.v) / height) * 100
			}))
	);

	/**
	 * Missing stretches, as a % of the plot area, for the hazard bands. A band
	 * spans the two samples the line would otherwise have been bridged between,
	 * and reaches the plot edge where the series starts or ends missing.
	 */
	const gaps = $derived.by(() => {
		if (!valid.length) {
			return [{ left: 0, width: 100 }];
		}

		const out: Array<{ left: number; width: number }> = [];
		const span = Math.max(1, t1 - t0);
		let i = 0;

		while (i < points.length) {
			if (points[i]!.v !== undefined) {
				i += 1;

				continue;
			}

			const before = points[i - 1];
			let end = i;

			while (end < points.length && points[end]!.v === undefined) {
				end += 1;
			}

			const after = points[end];
			const from = before?.t ?? t0;
			const to = after?.t ?? t1;

			out.push({
				left: ((from - t0) / span) * 100,
				width: ((to - from) / span) * 100
			});

			i = end;
		}

		return out;
	});

	const fmtTick = (v: number): string =>
		`${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10}${unit}`;

	/** y ticks anchored to their gridlines, as a % of the plot height */
	const yTicks = $derived(
		[1, 0.5].map((fraction) => ({
			label: fmtTick(max * fraction),
			top: (gridY(fraction) / height) * 100
		}))
	);

	const xTicks = $derived(
		valid.length >= 2 ? [fmtTime(t0), fmtTime(t0 + (t1 - t0) / 2), fmtTime(t1)] : []
	);

	/** crosshair readout: nearest sample to the pointer, in % of the plot area */
	let hover: { left: number; top: number; value: number; t: number } | null = $state(null);

	function onMove(event: PointerEvent): void {
		if (valid.length === 0) {
			return;
		}

		const area = (event.currentTarget as HTMLElement).getBoundingClientRect();
		const fraction = Math.min(1, Math.max(0, (event.clientX - area.left) / area.width));
		const t = t0 + fraction * Math.max(1, t1 - t0);

		let near = points[0]!;

		for (const point of points) {
			if (Math.abs(point.t - t) < Math.abs(near.t - t)) {
				near = point;
			}
		}

		// nearest sample is inside a gap; read out nothing rather than a value
		// from the far side of the hazard band
		if (near.v === undefined) {
			hover = null;

			return;
		}

		hover = {
			left: (scaleX(near.t) / W) * 100,
			top: (scaleY(near.v) / height) * 100,
			value: near.v,
			t: near.t
		};
	}
</script>

<div class="chart">
	<div class="hd2">
		<span class="ttl">{label}</span>
		<span class="cur" style="color: {color}">{last !== undefined ? `${last}${unit}` : '–'}</span>
	</div>

	<div
		class="plot"
		style:height="{height / 16}rem"
		role="presentation"
		onpointermove={onMove}
		onpointerleave={() => (hover = null)}
	>
		<svg viewBox="0 0 {W} {height}" preserveAspectRatio="none" aria-hidden="true">
			{#each GRID as fraction}
				<line
					x1="0"
					x2={W}
					y1={gridY(fraction)}
					y2={gridY(fraction)}
					stroke="var(--border-divider)"
					stroke-width="1"
					stroke-dasharray="3 4"
					vector-effect="non-scaling-stroke"
				/>
			{/each}
			{#each paths as path}
				<path d={path.fill} fill={color} opacity="0.12" />
				<path
					d={path.line}
					fill="none"
					stroke={color}
					stroke-width="2"
					vector-effect="non-scaling-stroke"
				/>
			{/each}
		</svg>

		{#each gaps as gap}
			<span class="gap" style:left="{gap.left}%" style:width="{gap.width}%"></span>
		{/each}

		{#each lone as point}
			<span
				class="spot"
				style:left="{point.left}%"
				style:top="{point.top}%"
				style:background={color}
			></span>
		{/each}

		{#each yTicks as tick}
			<span class="yl" style:top={`calc(${tick.top}% + 0.25rem)`}>{tick.label}</span>
		{/each}

		<div class="xl">
			{#if xTicks.length}
				{#each xTicks as tick}<span>{tick}</span>{/each}
			{:else}
				<span class="none">no data yet</span>
			{/if}
		</div>

		{#if hover}
			<span class="cross" style:left="{hover.left}%"></span>
			<span
				class="dot"
				style:left="{hover.left}%"
				style:top="{hover.top}%"
				style:background={color}
			></span>
			<div class="tip" class:flip={hover.left > 60} style:left="{hover.left}%">
				<b style="color: {color}">{hover.value}{unit}</b>
				<span>{fmtTime(hover.t)}</span>
			</div>
		{/if}
	</div>
</div>

<style lang="scss">
	.chart {
		padding: 0.75rem 1rem 1rem;
		background: var(--bg-panel);
		border: 0.1rem solid var(--border-divider);
		border-radius: var(--radius-container);
	}
	.hd2 {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
	}

	.ttl {
		font-weight: 700;
		color: var(--text-heading);
		font-size: 0.875rem;
	}

	.cur {
		font-weight: 700;
		font-size: 1rem;
	}

	.plot {
		position: relative;
	}

	svg {
		@include fill;

		width: 100%;
		height: 100%;
	}

	// stretches with no samples, hazard-taped so a gap reads as "nothing was
	// recorded here" instead of as a measurement. The stripes are a CSS gradient
	// rather than an svg pattern because the svg is stretched to the container
	// (preserveAspectRatio="none"), which would shear them and make their pitch
	// depend on the card's width.
	.gap {
		position: absolute;
		top: 0;
		bottom: 0;
		background-image: repeating-linear-gradient(
			45deg,
			color-mix(in srgb, var(--warning) 30%, transparent) 0 0.375rem,
			color-mix(in srgb, var(--bg-nav) 55%, transparent) 0.375rem 0.75rem
		);
		pointer-events: none;

		// a single missing sample in an hour of history is a sub-pixel band; widen
		// it just enough to be seen, since the alternative is to draw nothing
		min-width: 0.125rem;
	}

	// an isolated sample, with a gap on both sides and so no line to sit on
	.spot {
		position: absolute;
		width: 0.375rem;
		height: 0.375rem;
		border-radius: 50%;
		transform: translate(-50%, -50%);
		pointer-events: none;
	}

	// in-plot axis labels: readable over the 12% fill without a solid box
	.yl {
		position: absolute;
		left: 0.25rem;
		font-size: 0.6875rem;
		line-height: 1;
		color: var(--text-secondary);
		text-shadow: 0 0 0.25rem var(--bg-panel);
		pointer-events: none;
	}
	.xl {
		position: absolute;
		left: 0.25rem;
		right: 0.25rem;
		bottom: 0.125rem;
		display: flex;
		justify-content: space-between;
		font-size: 0.6875rem;
		line-height: 1;
		color: var(--text-secondary);
		text-shadow: 0 0 0.25rem var(--bg-panel);
		pointer-events: none;

		.none {
			margin: 0 auto;
		}
	}

	// crosshair readout on the nearest sample
	.cross {
		position: absolute;
		top: 0;
		bottom: 0;
		width: var(--hairline);
		background: var(--border);
		transform: translateX(-50%);
		pointer-events: none;
	}
	.dot {
		position: absolute;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		border: 0.125rem solid var(--bg-panel);
		transform: translate(-50%, -50%);
		pointer-events: none;
	}
	.tip {
		position: absolute;
		top: 0.25rem;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		margin-left: 0.5rem;
		padding: 0.25rem 0.5rem;
		background: var(--bg-dropdown);
		border: 0.1rem solid var(--border);
		border-radius: 0.375rem;
		box-shadow: var(--shadow-dropdown);
		font-size: 0.6875rem;
		line-height: 1;
		white-space: nowrap;
		color: var(--text-secondary);
		pointer-events: none;

		b {
			font-size: 0.8125rem;
		}

		// near the right edge the card flips to the other side of the crosshair
		&.flip {
			transform: translateX(-100%);
			margin-left: -0.5rem;
		}
	}
</style>
