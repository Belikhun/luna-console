<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { untrack } from 'svelte';
	import { t } from '$lib/i18n.svelte';
	import { tooltip } from '$lib/tooltip.svelte';

	import {
		describeMoment,
		fmtMoment,
		fmtTick,
		fmtTimeTick,
		fmtValue,
		nearestIndex,
		seriesColors,
		timeTicks,
		timestamps,
		unitTicks,
		valueAt,
		type ChartBand,
		type ChartMarker,
		type ChartThreshold,
		type Series,
		type SeriesStyle
	} from './chart';
	import type { ChartGroup } from './chartgroup.svelte';

	/**
	 * Lines or areas over time, luna's `Sparkline` grown into the kit's main
	 * chart: several series on one axis, gaps where nothing was measured, a
	 * crosshair that reads every series at once and follows the keyboard, a
	 * synced crosshair across a `ChartGroup`, markers for deploys and kills
	 * (links when they carry an `href`), shaded bands for incidents, threshold
	 * lines, dashed reference series, and drag-to-zoom.
	 *
	 * It is drawn in the plot's measured pixels rather than a stretched viewBox,
	 * so strokes, dots and the hatching of a gap keep their size at any width.
	 * One axis only: two measures of different scale are two charts.
	 */
	let {
		series,
		label,
		styles,
		mode = 'line',
		from,
		to,
		height = 10,
		max,
		threshold,
		markers = [],
		bands = [],
		group,
		onzoom,
		onmarker,
		onlegend,
		formatValue,
		legend = true,
		fit = false,
		initialHidden = []
	}: {
		series: Series[];
		/** What the chart shows, for screen readers; the panel's title says it to everyone else */
		label: string;
		styles?: Record<string, SeriesStyle>;
		/** `stacked` piles areas on each other, for parts of one total */
		mode?: 'line' | 'area' | 'stacked';
		/** The range drawn, epoch ms; the data's own span when absent */
		from?: number;
		to?: number;
		/** Height in rem, the time axis included */
		height?: number;
		/** A fixed top of the axis (100 for a percentage of a limit) */
		max?: number;
		/** One reference line or several (a limit and its 90%) */
		threshold?: ChartThreshold | ChartThreshold[];
		markers?: ChartMarker[];
		/** Shaded spans; the crosshair's readout names the one it stands in */
		bands?: ChartBand[];
		group?: ChartGroup;
		/** Turns on drag-to-zoom; called with the selected instants */
		onzoom?: (from: number, to: number) => void;
		/** A marker without an `href` was clicked */
		onmarker?: (marker: ChartMarker) => void;
		/** The legend hid or showed a series; the keys now hidden */
		onlegend?: (hidden: string[]) => void;
		/** Overrides the unit's own formatter in the readout */
		formatValue?: (value: number) => string;
		legend?: boolean;
		/** A percentage's axis follows the data instead of running to 100 (an error rate) */
		fit?: boolean;
		/** Series the legend starts with switched off; a click shows them */
		initialHidden?: string[];
	} = $props();

	const PAD_TOP = 10;
	const PAD_RIGHT = 12;
	const AXIS_BAND = 22;

	/** px of drag before a press becomes a zoom rather than a click */
	const DRAG_MIN = 8;

	/** px per character of an 11 px tick label, to fit the axis' gutter */
	const TICK_CHAR = 6.4;

	/** Legend entries shown before the rest fold into "+n more" */
	const LEGEND_MAX = 6;

	const id = `ts-${Math.random().toString(36).slice(2, 9)}`;

	let frameWidth = $state(0);
	let frameHeight = $state(0);
	let hidden: string[] = $state(untrack(() => [...initialHidden]));
	let localHover: number | null = $state(null);
	let focused = $state(false);
	let drag: { start: number; end: number } | null = $state(null);
	let moreOpen = $state(false);

	const thresholds = $derived(
		threshold === undefined
			? []
			: Array.isArray(threshold)
				? threshold
				: [threshold]
	);

	const unit = $derived(series[0]?.unit ?? 'count');
	const colors = $derived(seriesColors(series, styles));
	const visible = $derived(series.filter((entry) => !hidden.includes(entry.key)));
	const times = $derived(timestamps(series));

	const start = $derived(from ?? times[0] ?? 0);
	const end = $derived(to ?? times.at(-1) ?? start + 1);
	const span = $derived(Math.max(1, end - start));

	function labelOf(key: string): string {
		return styles?.[key]?.label ?? key;
	}

	function format(value: number | null): string {
		if (value === null) {
			return t('web.chart.notMeasured');
		}

		return formatValue
			? formatValue(value)
			: fmtValue(value, unit);
	}

	/**
	 * Each visible series' drawn values: as measured, or piled on the ones before
	 * it when stacked. A stacked moment where any series measured nothing is a
	 * gap for the whole pile, since its total is unknown.
	 */
	const layers = $derived.by(() => {
		const below = new Map<number, number | null>();

		return visible.map((entry) => {
			// a dashed series is a reference (a max, a budget): drawn as it is, never piled
			const reference = styles?.[entry.key]?.dashed === true;

			const points = entry.points.map(([at, value]) => {
				if (mode !== 'stacked' || reference) {
					return { at, low: 0, high: value };
				}

				const base = below.has(at)
					? (below.get(at) ?? null)
					: 0;

				const high = value === null || base === null
					? null
					: base + value;

				below.set(at, high);

				return { at, low: base ?? 0, high };
			});

			return { key: entry.key, points };
		});
	});

	const largest = $derived.by(() => {
		let top = Math.max(0, ...thresholds.map((line) => line.value));

		for (const layer of layers) {
			for (const point of layer.points) {
				if (point.high !== null && point.high > top) {
					top = point.high;
				}
			}
		}

		return Math.max(max ?? 0, top);
	});

	const measured = $derived(layers.some((layer) => layer.points.some((point) => point.high !== null)));

	const axis = $derived(unitTicks(unit, largest > 0 ? largest : 1, 4, fit));
	const ceiling = $derived(max ?? axis.ticks.at(-1) ?? 1);
	const yTicks = $derived(axis.ticks.filter((tick) => tick <= ceiling));
	const tickLabels = $derived(yTicks.map((tick) => fmtTick(tick, axis.scale)));

	const padLeft = $derived(Math.max(...tickLabels.map((text) => text.length), 1) * TICK_CHAR + 12);
	const plotWidth = $derived(Math.max(1, frameWidth - padLeft - PAD_RIGHT));
	const plotHeight = $derived(Math.max(1, frameHeight - PAD_TOP - AXIS_BAND));
	const baseline = $derived(PAD_TOP + plotHeight);

	function x(at: number): number {
		return padLeft + ((at - start) / span) * plotWidth;
	}

	function y(value: number): number {
		return PAD_TOP + plotHeight - (Math.min(value, ceiling) / ceiling) * plotHeight;
	}

	function timeAt(px: number): number {
		const share = Math.min(1, Math.max(0, (px - padLeft) / plotWidth));

		return start + share * span;
	}

	/** Contiguous measured stretches of a layer; a line never bridges a gap. */
	function runs(points: Array<{ at: number; low: number; high: number | null }>) {
		const out: Array<Array<{ at: number; low: number; high: number }>> = [];
		let run: Array<{ at: number; low: number; high: number }> = [];

		for (const point of points) {
			if (point.high === null) {
				if (run.length > 0) {
					out.push(run);
					run = [];
				}

				continue;
			}

			run.push({ at: point.at, low: point.low, high: point.high });
		}

		if (run.length > 0) {
			out.push(run);
		}

		return out;
	}

	const shapes = $derived(
		layers.map((layer) => {
			const stretches = runs(layer.points);

			const paths = stretches
				.filter((run) => run.length >= 2)
				.map((run) => {
					const line = run
						.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.at).toFixed(1)},${y(point.high).toFixed(1)}`)
						.join(' ');

					const floor = [...run]
						.reverse()
						.map((point) => `L${x(point.at).toFixed(1)},${y(point.low).toFixed(1)}`)
						.join(' ');

					return { line, area: `${line} ${floor} Z` };
				});

			const lone = stretches
				.filter((run) => run.length === 1)
				.map((run) => ({ cx: x(run[0]!.at), cy: y(run[0]!.high) }));

			return { key: layer.key, paths, lone };
		})
	);

	/**
	 * Stretches where no visible series measured anything, hatched: "nobody was
	 * watching" must not read as a flat line. A band runs between the measured
	 * moments either side, or to the plot's edge.
	 */
	const gaps = $derived.by(() => {
		if (!measured) {
			return [{ left: padLeft, width: plotWidth }];
		}

		const empty = times.map((at) => layers.every((layer) => {
			const point = layer.points.find((candidate) => candidate.at === at);

			return !point || point.high === null;
		}));

		const out: Array<{ left: number; width: number }> = [];
		let index = 0;

		while (index < times.length) {
			if (!empty[index]) {
				index += 1;
				continue;
			}

			let last = index;

			while (last < times.length && empty[last]) {
				last += 1;
			}

			const left = index > 0
				? x(times[index - 1]!)
				: padLeft;

			const right = last < times.length
				? x(times[last]!)
				: padLeft + plotWidth;

			out.push({ left, width: Math.max(2, right - left) });
			index = last;
		}

		return out;
	});

	const xTicks = $derived(
		timeTicks(start, end, plotWidth).map((at) => ({ at, left: x(at), text: fmtTimeTick(at, span) }))
	);

	const shownMarkers = $derived(
		markers.filter((marker) => marker.at >= start && marker.at <= end).map((marker) => ({ ...marker, left: x(marker.at) }))
	);

	const shownBands = $derived(
		bands
			.filter((band) => band.to > start && band.from < end)
			.map((band) => {
				const left = x(Math.max(start, band.from));
				const right = x(Math.min(end, band.to));

				return { ...band, left, width: Math.max(2, right - left) };
			})
	);

	// the moment the crosshair stands on: this chart's own pointer or key first,
	// then the group's, snapped to the nearest timestamp this chart has
	const hoverAt = $derived(localHover ?? group?.hover ?? null);
	const hoverIndex = $derived(hoverAt === null ? -1 : nearestIndex(times, hoverAt));
	const hoverTime = $derived(hoverIndex < 0 ? null : (times[hoverIndex] ?? null));

	const readout = $derived(
		hoverTime === null
			? []
			: visible.map((entry) => {
				const value = valueAt(entry, hoverTime);
				const layer = layers.find((candidate) => candidate.key === entry.key);
				const drawn = layer?.points.find((point) => point.at === hoverTime)?.high ?? null;

				return {
					key: entry.key,
					label: labelOf(entry.key),
					value,
					text: format(value),
					cy: drawn === null
						? null
						: y(drawn)
				};
			})
	);

	const hoverBands = $derived(
		hoverTime === null
			? []
			: bands.filter((band) => hoverTime >= band.from && hoverTime <= band.to)
	);

	const total = $derived(
		mode === 'stacked' && readout.every((row) => row.value !== null)
			? readout
				.filter((row) => !styles?.[row.key]?.dashed)
				.reduce((sum, row) => sum + (row.value ?? 0), 0)
			: null
	);

	const showReadout = $derived(
		hoverTime !== null && (localHover !== null || focused || !group || group.source === id)
	);

	const valueText = $derived(
		hoverTime === null
			? label
			: describeMoment(hoverTime, span, readout.map((row) => ({ label: row.label, value: row.text })))
	);

	function point(at: number | null): void {
		localHover = at;

		if (!group) {
			return;
		}

		if (at === null) {
			group.release(id);
		} else {
			group.point(at, id);
		}
	}

	/** The pointer's x in the frame's coordinates; the hit area starts at the gutter. */
	function localX(event: PointerEvent): number {
		const box = (event.currentTarget as Element).getBoundingClientRect();

		return event.clientX - box.left + padLeft;
	}

	function onMove(event: PointerEvent): void {
		const px = localX(event);

		if (drag) {
			drag = { ...drag, end: Math.min(padLeft + plotWidth, Math.max(padLeft, px)) };
		}

		point(timeAt(px));
	}

	function onDown(event: PointerEvent): void {
		if (!onzoom || event.button !== 0) {
			return;
		}

		const px = Math.min(padLeft + plotWidth, Math.max(padLeft, localX(event)));

		drag = { start: px, end: px };
		(event.currentTarget as Element).setPointerCapture(event.pointerId);
	}

	function onUp(): void {
		if (!drag || !onzoom) {
			drag = null;

			return;
		}

		const left = Math.min(drag.start, drag.end);
		const right = Math.max(drag.start, drag.end);

		drag = null;

		if (right - left >= DRAG_MIN) {
			onzoom(timeAt(left), timeAt(right));
		}
	}

	function onLeave(): void {
		if (drag) {
			return;
		}

		point(null);
	}

	function onKey(event: KeyboardEvent): void {
		if (times.length === 0) {
			return;
		}

		const current = hoverIndex < 0
			? times.length - 1
			: hoverIndex;

		let next = current;

		if (event.key === 'ArrowLeft') {
			next = Math.max(0, current - 1);
		} else if (event.key === 'ArrowRight') {
			next = Math.min(times.length - 1, current + 1);
		} else if (event.key === 'PageUp') {
			next = Math.max(0, current - 10);
		} else if (event.key === 'PageDown') {
			next = Math.min(times.length - 1, current + 10);
		} else if (event.key === 'Home') {
			next = 0;
		} else if (event.key === 'End') {
			next = times.length - 1;
		} else if (event.key === 'Escape') {
			drag = null;
			point(null);

			return;
		} else {
			return;
		}

		event.preventDefault();
		point(times[next] ?? null);
	}

	function onFocus(): void {
		focused = true;

		if (localHover === null && times.length > 0) {
			point(times.at(-1) ?? null);
		}
	}

	function onBlur(): void {
		focused = false;
		point(null);
	}

	function toggle(key: string): void {
		if (hidden.includes(key)) {
			hidden = hidden.filter((entry) => entry !== key);
			onlegend?.(hidden);

			return;
		}

		// the last visible series stays: an empty plot answers nothing
		if (visible.length <= 1) {
			return;
		}

		hidden = [...hidden, key];
		onlegend?.(hidden);
	}

	const crossX = $derived(hoverTime === null ? 0 : x(hoverTime));
	const flip = $derived(crossX > padLeft + plotWidth * 0.6);
</script>

<div class="ts-chart">
	<div
		class="frame"
		style:height="{height}rem"
		bind:clientWidth={frameWidth}
		bind:clientHeight={frameHeight}
	>
		{#if frameWidth > 0}
			<svg width={frameWidth} height={frameHeight} aria-hidden="true">
				<defs>
					<pattern id="{id}-gap" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
						<rect width="6" height="12" class="gap-stripe" />
						<rect x="6" width="6" height="12" class="gap-stripe alt" />
					</pattern>
				</defs>

				{#each yTicks as tick, index (tick)}
					<line class="grid" class:base={tick === 0} x1={padLeft} x2={padLeft + plotWidth} y1={y(tick)} y2={y(tick)} />
					<text class="tick" x={padLeft - 8} y={y(tick)} dy="0.32em" text-anchor="end">{tickLabels[index]}</text>
				{/each}

				{#each xTicks as tick (tick.at)}
					<line class="grid-x" x1={tick.left} x2={tick.left} y1={baseline} y2={baseline + 4} />
					<text class="tick" x={tick.left} y={baseline + 16} text-anchor="middle">{tick.text}</text>
				{/each}

				{#each gaps as gap, index (index)}
					<rect class="gap" x={gap.left} y={PAD_TOP} width={gap.width} height={plotHeight} fill="url(#{id}-gap)" />
				{/each}

				{#each shownBands as band, index (index)}
					<rect class="band" data-tone={band.tone ?? 'critical'} x={band.left} y={PAD_TOP} width={band.width} height={plotHeight} />
				{/each}

				{#each shapes as shape (shape.key)}
					{#each shape.paths as path, index (index)}
						{#if mode !== 'line' && !styles?.[shape.key]?.dashed}
							<path
								d={path.area}
								fill={colors[shape.key]}
								class="area"
								class:stacked={mode === 'stacked'}
							/>
						{/if}
						<path d={path.line} stroke={colors[shape.key]} class="line" class:dashed={styles?.[shape.key]?.dashed} />
					{/each}

					{#each shape.lone as dot, index (index)}
						<circle class="dot" cx={dot.cx} cy={dot.cy} r="4" fill={colors[shape.key]} />
					{/each}
				{/each}

				{#each thresholds.filter((line) => line.value <= ceiling) as line, index (index)}
					<line
						class="threshold"
						data-tone={line.tone ?? 'critical'}
						x1={padLeft}
						x2={padLeft + plotWidth}
						y1={y(line.value)}
						y2={y(line.value)}
					/>
					<text class="threshold-label" x={padLeft + plotWidth - 4} y={y(line.value) - 5} text-anchor="end">
						{line.label} · {format(line.value)}
					</text>
				{/each}

				{#each shownMarkers as marker, index (index)}
					<line class="marker" data-tone={marker.tone ?? 'neutral'} x1={marker.left} x2={marker.left} y1={PAD_TOP} y2={baseline} />
				{/each}

				{#if drag}
					<rect
						class="selection"
						x={Math.min(drag.start, drag.end)}
						y={PAD_TOP}
						width={Math.abs(drag.end - drag.start)}
						height={plotHeight}
					/>
				{/if}

				{#if hoverTime !== null}
					<line class="cross" x1={crossX} x2={crossX} y1={PAD_TOP} y2={baseline} />
					{#each readout as row (row.key)}
						{#if row.cy !== null}
							<circle class="hover-dot" cx={crossX} cy={row.cy} r="4" fill={colors[row.key]} />
						{/if}
					{/each}
				{/if}
			</svg>

			<!-- the plot is a slider over its own moments: arrows walk the
			     crosshair, and the value text reads the moment out -->
			<div
				class="hit"
				class:zoomable={onzoom !== undefined}
				style:left="{padLeft}px"
				style:top="{PAD_TOP}px"
				style:width="{plotWidth}px"
				style:height="{plotHeight}px"
				role="slider"
				tabindex="0"
				aria-label={label}
				aria-valuemin={0}
				aria-valuemax={Math.max(0, times.length - 1)}
				aria-valuenow={Math.max(0, hoverIndex)}
				aria-valuetext={valueText}
				onpointermove={onMove}
				onpointerdown={onDown}
				onpointerup={onUp}
				onpointercancel={() => (drag = null)}
				onpointerleave={onLeave}
				onkeydown={onKey}
				onfocus={onFocus}
				onblur={onBlur}
			></div>

			{#each shownMarkers as marker, index (index)}
				{@const hint = `${marker.label} · ${fmtMoment(marker.at, span)}`}
				{#if marker.href}
					<a
						class="marker-flag"
						data-tone={marker.tone ?? 'neutral'}
						href={marker.href}
						aria-label={hint}
						style:left="{marker.left}px"
						style:top="{PAD_TOP}px"
						use:tooltip={{ content: hint, position: 'top' }}
					></a>
				{:else if onmarker}
					<button
						type="button"
						class="marker-flag"
						data-tone={marker.tone ?? 'neutral'}
						aria-label={hint}
						style:left="{marker.left}px"
						style:top="{PAD_TOP}px"
						use:tooltip={{ content: hint, position: 'top' }}
						onclick={() => onmarker?.(marker)}
					></button>
				{:else}
					<span
						class="marker-flag"
						data-tone={marker.tone ?? 'neutral'}
						role="img"
						aria-label={hint}
						style:left="{marker.left}px"
						style:top="{PAD_TOP}px"
						use:tooltip={{ content: hint, position: 'top' }}
					></span>
				{/if}
			{/each}

			{#if !measured}
				<div class="unmeasured" style:left="{padLeft}px" style:width="{plotWidth}px" style:top="{PAD_TOP}px" style:height="{plotHeight}px">
					<span>{t('web.chart.noneInRange')}</span>
				</div>
			{/if}

			{#if drag && Math.abs(drag.end - drag.start) >= DRAG_MIN}
				<div class="zoom-label" style:left="{(drag.start + drag.end) / 2}px" style:top="{PAD_TOP + 4}px">
					{fmtMoment(timeAt(Math.min(drag.start, drag.end)), span)} → {fmtMoment(timeAt(Math.max(drag.start, drag.end)), span)}
				</div>
			{/if}

			{#if showReadout && hoverTime !== null && !drag}
				<div class="readout" class:flip style:left="{crossX}px" style:top="{PAD_TOP}px">
					<span class="when">{fmtMoment(hoverTime, span)}</span>
					{#each readout as row (row.key)}
						<span class="row">
							<i class="key" class:dashed={styles?.[row.key]?.dashed} style:background-color={colors[row.key]}></i>
							<b class:none={row.value === null}>{row.text}</b>
							{#if readout.length > 1}
								<span class="name">{row.label}</span>
							{/if}
						</span>
					{/each}
					{#each hoverBands as band, index (index)}
						<span class="row band-row" data-tone={band.tone ?? 'critical'}>
							<i class="key block"></i>
							<span class="name">{band.label}</span>
						</span>
					{/each}
					{#if total !== null && readout.length > 1}
						<span class="row total">
							<i class="key blank"></i>
							<b>{format(total)}</b>
							<span class="name">{t('web.chart.total')}</span>
						</span>
					{/if}
				</div>
			{/if}
		{/if}
	</div>

	{#snippet entry(key: string)}
		<button
			type="button"
			class="entry"
			class:off={hidden.includes(key)}
			aria-pressed={!hidden.includes(key)}
			onclick={() => toggle(key)}
		>
			<i class="key" class:block={mode !== 'line'} class:dashed={styles?.[key]?.dashed} style:background-color={colors[key]}></i>
			<span>{labelOf(key)}</span>
		</button>
	{/snippet}

	{#if legend && series.length > 1}
		<div class="legend" role="group" aria-label={t('web.chart.legend')}>
			{#each series.slice(0, LEGEND_MAX) as item (item.key)}
				{@render entry(item.key)}
			{/each}

			{#if series.length > LEGEND_MAX}
				<div class="more">
					<button
						type="button"
						class="entry"
						aria-expanded={moreOpen}
						onclick={() => (moreOpen = !moreOpen)}
						onkeydown={(event) => {
							if (event.key === 'Escape') {
								moreOpen = false;
							}
						}}
					>
						{t('web.chart.moreSeries', { count: String(series.length - LEGEND_MAX) })}
					</button>

					{#if moreOpen}
						<div class="more-list" role="group">
							{#each series.slice(LEGEND_MAX) as item (item.key)}
								{@render entry(item.key)}
							{/each}
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style lang="scss">
	.ts-chart {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
	}

	.frame {
		position: relative;
		min-width: 0;
		user-select: none;
	}

	svg {
		position: absolute;
		inset: 0;
		overflow: visible;
	}

	.grid {
		stroke: var(--chart-grid);
		stroke-width: 1;
		shape-rendering: crispEdges;

		&.base {
			stroke: var(--chart-axis);
		}
	}

	.grid-x {
		stroke: var(--chart-axis);
		stroke-width: 1;
		shape-rendering: crispEdges;
	}

	.tick {
		font-size: 0.6875rem;
		fill: var(--chart-ink);
		font-variant-numeric: tabular-nums;
	}

	// luna's hazard tape: a stretch nobody measured, never a flat line
	.gap-stripe {
		fill: var(--chart-gap);

		&.alt {
			fill: var(--chart-gap-alt);
		}
	}

	.line {
		fill: none;
		stroke-width: 2;
		stroke-linejoin: round;
		stroke-linecap: round;

		&.dashed {
			stroke-width: 1.5;
			stroke-dasharray: 5 4;
		}
	}

	// an incident or down period: a wash of its tone behind the lines
	.band {
		fill: var(--chart-critical);
		fill-opacity: 0.12;

		&[data-tone='warning'] {
			fill: var(--chart-warning);
		}

		&[data-tone='neutral'] {
			fill: var(--chart-muted);
			fill-opacity: 0.2;
		}
	}

	// a wash under a line; a pile of parts carries more, so each band reads
	.area {
		fill-opacity: 0.1;
		stroke: none;

		&.stacked {
			fill-opacity: 0.28;
		}
	}

	.dot,
	.hover-dot {
		stroke: var(--chart-surface);
		stroke-width: 2;
	}

	.threshold {
		stroke-width: 1;
		stroke-dasharray: 6 4;
		stroke: var(--chart-critical);

		&[data-tone='warning'] {
			stroke: var(--chart-warning);
		}
	}

	.threshold-label {
		font-size: 0.6875rem;
		fill: var(--text-secondary);
		paint-order: stroke;
		stroke: var(--chart-surface);
		stroke-width: 3;
	}

	.marker {
		stroke-width: 1;
		stroke: var(--chart-muted);

		&[data-tone='good'] {
			stroke: var(--chart-good);
		}

		&[data-tone='warning'] {
			stroke: var(--chart-warning);
		}

		&[data-tone='critical'] {
			stroke: var(--chart-critical);
		}
	}

	.selection {
		fill: var(--chart-selection);
		stroke: var(--link);
		stroke-width: 1;
	}

	.cross {
		stroke: var(--border-input);
		stroke-width: 1;
		shape-rendering: crispEdges;
	}

	.hit {
		position: absolute;
		cursor: default;
		border-radius: 0.25rem;

		&.zoomable {
			cursor: crosshair;
		}

		&:focus-visible {
			@include focus-ring;
		}
	}

	// a diamond on the plot's top edge; the hover target is wider than the mark
	.marker-flag {
		@include bare-button;

		position: absolute;
		width: 0.75rem;
		height: 0.75rem;
		transform: translate(-50%, -50%);
		z-index: 1;

		&::before {
			content: '';
			position: absolute;
			inset: 0.1875rem;
			transform: rotate(45deg);
			border-radius: 0.125rem;
			background: var(--chart-muted);
			box-shadow: 0 0 0 0.125rem var(--chart-surface);
		}

		&[data-tone='good']::before {
			background: var(--chart-good);
		}

		&[data-tone='warning']::before {
			background: var(--chart-warning);
		}

		&[data-tone='critical']::before {
			background: var(--chart-critical);
		}

		&:is(a, button) {
			cursor: pointer;

			&:hover::before {
				transform: rotate(45deg) scale(1.3);
			}

			&:focus-visible {
				@include focus-ring;

				border-radius: 50%;
			}
		}
	}

	.unmeasured {
		position: absolute;
		display: flex;
		align-items: center;
		justify-content: center;
		pointer-events: none;

		span {
			padding: 0.25rem 0.625rem;
			border-radius: var(--radius-button);
			background: var(--chart-surface);
			font-size: 0.75rem;
			color: var(--text-secondary);
		}
	}

	.zoom-label {
		position: absolute;
		transform: translateX(-50%);
		padding: 0.125rem 0.5rem;
		border-radius: 0.375rem;
		background: var(--bg-dropdown);
		border: var(--hairline) solid var(--border);
		font-size: 0.6875rem;
		white-space: nowrap;
		color: var(--text);
		pointer-events: none;
	}

	// above a table's sticky header further down the page, which it may hang over
	.readout {
		position: absolute;
		z-index: var(--z-popover);
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin-left: 0.75rem;
		padding: 0.375rem 0.625rem;
		background: var(--bg-dropdown);
		border: var(--hairline) solid var(--border);
		border-radius: 0.5rem;
		box-shadow: var(--shadow-dropdown);
		font-size: 0.75rem;
		line-height: 1.2;
		white-space: nowrap;
		pointer-events: none;

		&.flip {
			transform: translateX(-100%);
			margin-left: -0.75rem;
		}

		.when {
			color: var(--text-secondary);
			font-size: 0.6875rem;
		}

		.row {
			display: flex;
			align-items: center;
			gap: 0.375rem;
		}

		b {
			color: var(--text-heading);
			font-variant-numeric: tabular-nums;

			&.none {
				font-weight: 400;
				color: var(--text-secondary);
			}
		}

		.name {
			color: var(--text-secondary);
		}

		.total {
			padding-top: 0.25rem;
			border-top: var(--hairline) solid var(--border-divider);
		}

		.band-row .key {
			background: var(--chart-critical);
			opacity: 0.6;
		}

		.band-row[data-tone='warning'] .key {
			background: var(--chart-warning);
		}

		.band-row[data-tone='neutral'] .key {
			background: var(--chart-muted);
		}
	}

	// a short stroke of the series colour: the tooltip's and the legend's key
	.key {
		display: inline-block;
		flex: none;
		width: 0.75rem;
		height: 0.125rem;
		border-radius: 0.125rem;

		&.block {
			height: 0.625rem;
			width: 0.625rem;
		}

		&.blank {
			background: none;
		}

		// a dashed series keys as a broken stroke
		&.dashed {
			background-image: linear-gradient(to right, transparent 50%, var(--chart-surface) 50%);
			background-size: 0.375rem 100%;
		}
	}

	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.75rem;
		padding-left: 0.25rem;

		.entry {
			@include bare-button;

			display: inline-flex;
			align-items: center;
			gap: 0.375rem;
			padding: 0.125rem 0.25rem;
			border-radius: 0.25rem;
			font-size: 0.75rem;
			color: var(--text-secondary);

			&:hover {
				color: var(--text-heading);
			}

			&:focus-visible {
				@include focus-ring;
			}

			&.off {
				color: var(--text-disabled);

				.key {
					opacity: 0.35;
				}
			}
		}

		.more {
			position: relative;
		}

		.more-list {
			position: absolute;
			bottom: calc(100% + 0.25rem);
			left: 0;
			z-index: var(--z-popover);
			display: flex;
			flex-direction: column;
			align-items: flex-start;
			padding: 0.375rem;
			background: var(--bg-dropdown);
			border: var(--hairline) solid var(--border);
			border-radius: 0.5rem;
			box-shadow: var(--shadow-dropdown);
		}
	}
</style>
