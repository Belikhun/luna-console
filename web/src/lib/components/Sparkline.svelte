<script lang="ts">
	import { fmtTime } from '$lib/format';

	/**
	 * Metric chart: title + current value above a filled line
	 * plot. Axis labels live *inside* the plot area — y ticks down the left
	 * edge, the sampled time range along the bottom — as HTML overlays, so they
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

	const line = $derived.by(() => {
		if (valid.length < 2) {
			return '';
		}

		return valid
			.map((point, i) => {
				const command = i === 0 ? 'M' : 'L';

				return `${command}${scaleX(point.t).toFixed(1)},${scaleY(point.v).toFixed(1)}`;
			})
			.join(' ');
	});

	// close the line down to the baseline at both ends to get the filled area
	const fill = $derived.by(() => {
		if (!line) {
			return '';
		}

		const right = scaleX(valid.at(-1)!.t).toFixed(1);
		const left = scaleX(valid[0]!.t).toFixed(1);

		return `${line} L${right},${height} L${left},${height} Z`;
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

		let near = valid[0]!;

		for (const point of valid) {
			if (Math.abs(point.t - t) < Math.abs(near.t - t)) {
				near = point;
			}
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
			{#if line}
				<path d={fill} fill={color} opacity="0.12" />
				<path
					d={line}
					fill="none"
					stroke={color}
					stroke-width="2"
					vector-effect="non-scaling-stroke"
				/>
			{/if}
		</svg>

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
