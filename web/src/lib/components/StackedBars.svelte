<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { currentLanguage, t } from '$lib/i18n.svelte';
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
		type Series,
		type SeriesStyle
	} from './chart';
	import type { ChartGroup } from './chartgroup.svelte';

	/**
	 * Counts per time bucket, piled by part: requests by status class, as
	 * Netlify's observability chart and Render's request chart draw them. Each
	 * bucket is one column; the column is the hover target and reads out every
	 * part with the total. Thin bars (24 px at most) with a 2 px gap between
	 * parts, the top rounded and the baseline square. A bucket nobody measured is
	 * hatched, not drawn as an empty column.
	 *
	 * Shares the crosshair group, the zoom drag, markers and bands with
	 * `TimeSeriesChart`, and hands a clicked segment to `onbar` for drilling into
	 * its requests. `compact` drops the axis labels and the legend, for a strip
	 * over a table.
	 */
	let {
		series,
		label,
		styles,
		from,
		to,
		height,
		group,
		onzoom,
		onbar,
		barHint,
		markers = [],
		bands = [],
		compact = false,
		formatValue,
		legend = true
	}: {
		/** One series per part, bucketed on the same timestamps (bucket starts) */
		series: Series[];
		label: string;
		styles?: Record<string, SeriesStyle>;
		from?: number;
		to?: number;
		/** Height in rem, the time axis included; 10, or 5 when compact */
		height?: number;
		group?: ChartGroup;
		onzoom?: (from: number, to: number) => void;
		/**
		 * A bar was clicked: the bucket's instants and the part under the
		 * pointer, or null for the whole bucket (Enter on the keyboard)
		 */
		onbar?: (from: number, to: number, key: string | null) => void;
		/** What clicking a bar shows, in the hover readout; the requests by default */
		barHint?: string;
		markers?: ChartMarker[];
		bands?: ChartBand[];
		/** No axis labels, no legend */
		compact?: boolean;
		formatValue?: (value: number) => string;
		legend?: boolean;
	} = $props();

	const PAD_TOP = 10;
	const PAD_RIGHT = 12;
	const AXIS_BAND = 22;
	const DRAG_MIN = 8;
	const TICK_CHAR = 6.4;
	const BAR_MAX = 24;
	const GAP = 2;
	const RADIUS = 4;
	/** The least a part that counted anything is drawn, so one failure beside a hundred successes still shows */
	const MIN_SEGMENT = 3;

	const id = `sb-${Math.random().toString(36).slice(2, 9)}`;

	let frameWidth = $state(0);
	let pointerY = $state(0);
	let frameHeight = $state(0);
	let hidden: string[] = $state([]);
	let localHover: number | null = $state(null);
	let focused = $state(false);
	let drag: { start: number; end: number; moved: boolean } | null = $state(null);

	const unit = $derived(series[0]?.unit ?? 'count');
	const colors = $derived(seriesColors(series, styles));
	const visible = $derived(series.filter((entry) => !hidden.includes(entry.key)));
	const times = $derived(timestamps(series));

	/** The bucket length: the smallest spacing between buckets */
	const step = $derived.by(() => {
		let smallest = Infinity;

		for (let index = 1; index < times.length; index++) {
			smallest = Math.min(smallest, times[index]! - times[index - 1]!);
		}

		return Number.isFinite(smallest)
			? smallest
			: 60_000;
	});

	const start = $derived(from ?? times[0] ?? 0);
	const end = $derived(to ?? (times.length > 0 ? times.at(-1)! + step : start + 1));
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

	/** Each bucket's parts, bottom up, and its total; null when nothing was measured. */
	const buckets = $derived(
		times.map((at) => {
			const parts = visible.map((entry) => ({ key: entry.key, value: valueAt(entry, at) }));
			const measured = parts.some((part) => part.value !== null);
			const total = parts.reduce((sum, part) => sum + (part.value ?? 0), 0);

			return { at, parts, total: measured ? total : null };
		})
	);

	const largest = $derived(Math.max(0, ...buckets.map((bucket) => bucket.total ?? 0)));
	const axis = $derived(unitTicks(unit, largest > 0 ? largest : 1));
	const ceiling = $derived(axis.ticks.at(-1) ?? 1);
	const tickLabels = $derived(axis.ticks.map((tick) => fmtTick(tick, axis.scale)));

	const padLeft = $derived(
		compact
			? 0
			: Math.max(...tickLabels.map((text) => text.length), 1) * TICK_CHAR + 12
	);
	const frameRem = $derived(height ?? (compact ? 5 : 10));
	const plotWidth = $derived(Math.max(1, frameWidth - padLeft - PAD_RIGHT));
	const plotHeight = $derived(Math.max(1, frameHeight - PAD_TOP - AXIS_BAND));
	const baseline = $derived(PAD_TOP + plotHeight);

	const slot = $derived((step / span) * plotWidth);
	const barWidth = $derived(Math.max(1, Math.min(BAR_MAX, slot - GAP)));

	function x(at: number): number {
		return padLeft + ((at - start) / span) * plotWidth;
	}

	function y(value: number): number {
		return PAD_TOP + plotHeight - (value / ceiling) * plotHeight;
	}

	function timeAt(px: number): number {
		const share = Math.min(1, Math.max(0, (px - padLeft) / plotWidth));

		return start + share * span;
	}

	/** A bar segment with its top corners rounded and its foot square. */
	function roundedTop(left: number, top: number, width: number, tall: number): string {
		const radius = Math.min(RADIUS, width / 2, tall);
		const right = left + width;
		const bottom = top + tall;

		return [
			`M${left},${bottom}`,
			`L${left},${top + radius}`,
			`Q${left},${top} ${left + radius},${top}`,
			`L${right - radius},${top}`,
			`Q${right},${top} ${right},${top + radius}`,
			`L${right},${bottom}`,
			'Z'
		].join(' ');
	}

	/**
	 * Segments to draw: each part's slice of its column, the 2 px gap taken out
	 * of the slice above it so neighbours read apart without a stroke.
	 */
	const bars = $derived(
		buckets.map((bucket) => {
			// a bucket that began before the range (steps align to the clock, not to
			// the range) would draw over the axis labels; it stays inside the plot
			const center = Math.min(
				Math.max(x(bucket.at + step / 2), padLeft + barWidth / 2),
				padLeft + plotWidth - barWidth / 2
			);
			const left = center - barWidth / 2;
			const drawn = bucket.parts.filter((part) => (part.value ?? 0) > 0);

			let floor = 0;
			// the foot of the next part; a part grown to its least height pushes the ones above it up
			let cursor = baseline;

			const segments = drawn.map((part, index) => {
				const value = part.value ?? 0;
				const bottom = cursor;
				const gapBelow = index === 0
					? 0
					: GAP;

				floor += value;

				const top = Math.min(y(floor), bottom - gapBelow - MIN_SEGMENT);
				const tall = bottom - top - gapBelow;
				const isTop = index === drawn.length - 1;

				cursor = top;

				return {
					key: part.key,
					top,
					bottom,
					path: isTop
						? roundedTop(left, top, barWidth, tall)
						: `M${left},${top}h${barWidth}v${tall}h${-barWidth}Z`
				};
			});

			return { at: bucket.at, left, center, segments, measured: bucket.total !== null };
		})
	);

	const gaps = $derived(
		bars.filter((bar) => !bar.measured).map((bar) => ({ left: x(bar.at), width: Math.max(2, slot) }))
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

	const xTicks = $derived(
		timeTicks(start, end, plotWidth).map((at) => ({ at, left: x(at), text: fmtTimeTick(at, span) }))
	);

	// a bucket covers [at, at + step), so the pointer's moment is matched
	// against bucket middles
	const hoverAt = $derived(localHover ?? group?.hover ?? null);
	const middles = $derived(times.map((at) => at + step / 2));
	const hoverIndex = $derived(hoverAt === null ? -1 : nearestIndex(middles, hoverAt));
	const hoverBucket = $derived(hoverIndex < 0 ? null : (buckets[hoverIndex] ?? null));
	const hoverBar = $derived(hoverIndex < 0 ? null : (bars[hoverIndex] ?? null));

	const hoverBands = $derived(
		hoverBucket === null
			? []
			: bands.filter((band) => band.from < hoverBucket.at + step && band.to > hoverBucket.at)
	);

	const showReadout = $derived(
		hoverBucket !== null && (localHover !== null || focused || !group || group.source === id)
	);

	const valueText = $derived(
		hoverBucket === null
			? label
			: describeMoment(
				hoverBucket.at,
				span,
				hoverBucket.parts.map((part) => ({ label: labelOf(part.key), value: format(part.value) }))
			)
	);

	const flip = $derived(hoverBar !== null && hoverBar.center > padLeft + plotWidth * 0.6);

	/** "13 Nov, 23:00 to 23:24": the bucket's span, its date said once. */
	function bucketLabel(at: number): string {
		const end = new Date(at + step);
		const sameDay = new Date(at).toDateString() === end.toDateString();

		const to = sameDay
			? end.toLocaleTimeString(currentLanguage() === 'vi' ? 'vi-VN' : 'en-GB', { hour: '2-digit', minute: '2-digit' })
			: fmtMoment(at + step, span);

		return t('web.chart.between', { from: fmtMoment(at, span), to });
	}

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

	function localX(event: PointerEvent): number {
		const box = (event.currentTarget as Element).getBoundingClientRect();

		return event.clientX - box.left + padLeft;
	}

	function clampX(px: number): number {
		return Math.min(padLeft + plotWidth, Math.max(padLeft, px));
	}

	function onMove(event: PointerEvent): void {
		const px = localX(event);
		const box = (event.currentTarget as Element).getBoundingClientRect();

		pointerY = event.clientY - box.top + PAD_TOP;

		if (drag) {
			const moved = drag.moved || Math.abs(px - drag.start) >= DRAG_MIN;

			drag = { ...drag, end: clampX(px), moved };
		}

		point(timeAt(px));
	}

	function onDown(event: PointerEvent): void {
		if (event.button !== 0) {
			return;
		}

		const px = clampX(localX(event));

		drag = { start: px, end: px, moved: false };
		(event.currentTarget as Element).setPointerCapture(event.pointerId);
	}

	function onUp(): void {
		const done = drag;

		drag = null;

		if (!done) {
			return;
		}

		if (done.moved && onzoom) {
			onzoom(timeAt(Math.min(done.start, done.end)), timeAt(Math.max(done.start, done.end)));

			return;
		}

		if (!done.moved && onbar && hoverBucket && hoverBucket.total !== null) {
			const segment = hoverBar?.segments.find((candidate) => pointerY >= candidate.top - GAP && pointerY <= candidate.bottom);

			onbar(hoverBucket.at, hoverBucket.at + step, segment?.key ?? null);
		}
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
		} else if (event.key === 'Home') {
			next = 0;
		} else if (event.key === 'End') {
			next = times.length - 1;
		} else if (event.key === 'Enter' && onbar && hoverBucket && hoverBucket.total !== null) {
			event.preventDefault();
			onbar(hoverBucket.at, hoverBucket.at + step, null);

			return;
		} else if (event.key === 'Escape') {
			drag = null;
			point(null);

			return;
		} else {
			return;
		}

		event.preventDefault();
		point(middles[next] ?? null);
	}

	function onFocus(): void {
		focused = true;

		if (localHover === null && middles.length > 0) {
			point(middles.at(-1) ?? null);
		}
	}

	function onBlur(): void {
		focused = false;
		point(null);
	}

	function toggle(key: string): void {
		if (hidden.includes(key)) {
			hidden = hidden.filter((entry) => entry !== key);

			return;
		}

		if (visible.length <= 1) {
			return;
		}

		hidden = [...hidden, key];
	}
</script>

<div class="stacked-bars">
	<div
		class="frame"
		style:height="{frameRem}rem"
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

				{#each axis.ticks as tick, index (tick)}
					<line class="grid" class:base={tick === 0} x1={padLeft} x2={padLeft + plotWidth} y1={y(tick)} y2={y(tick)} />
					{#if !compact}
						<text class="tick" x={padLeft - 8} y={y(tick)} dy="0.32em" text-anchor="end">{tickLabels[index]}</text>
					{/if}
				{/each}

				{#each xTicks as tick (tick.at)}
					<line class="grid-x" x1={tick.left} x2={tick.left} y1={baseline} y2={baseline + 4} />
					<text class="tick" x={tick.left} y={baseline + 16} text-anchor="middle">{tick.text}</text>
				{/each}

				{#each shownBands as band, index (index)}
					<rect class="band" data-tone={band.tone ?? 'critical'} x={band.left} y={PAD_TOP} width={band.width} height={plotHeight} />
				{/each}

				{#if hoverBar}
					<rect class="column" x={hoverBar.center - Math.max(slot, barWidth + 4) / 2} y={PAD_TOP} width={Math.max(slot, barWidth + 4)} height={plotHeight} />
				{/if}

				{#each gaps as gap, index (index)}
					<rect x={gap.left} y={PAD_TOP} width={gap.width} height={plotHeight} fill="url(#{id}-gap)" />
				{/each}

				{#each bars as bar (bar.at)}
					{#each bar.segments as segment (segment.key)}
						<path d={segment.path} fill={colors[segment.key]} class="segment" class:dim={hoverBar !== null && hoverBar.at !== bar.at} />
					{/each}
				{/each}

				{#each shownMarkers as marker, index (index)}
					<line class="marker" data-tone={marker.tone ?? 'neutral'} x1={marker.left} x2={marker.left} y1={PAD_TOP} y2={baseline} />
				{/each}

				{#if drag && drag.moved}
					<rect class="selection" x={Math.min(drag.start, drag.end)} y={PAD_TOP} width={Math.abs(drag.end - drag.start)} height={plotHeight} />
				{/if}
			</svg>

			<div
				class="hit"
				class:pickable={onbar !== undefined}
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
				onpointerleave={() => {
					if (!drag) {
						point(null);
					}
				}}
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

			{#if largest === 0 && !buckets.some((bucket) => bucket.total !== null)}
				<div class="unmeasured" style:left="{padLeft}px" style:width="{plotWidth}px" style:top="{PAD_TOP}px" style:height="{plotHeight}px">
					<span>{t('web.chart.noneInRange')}</span>
				</div>
			{/if}

			{#if drag && drag.moved}
				<div class="zoom-label" style:left="{(drag.start + drag.end) / 2}px" style:top="{PAD_TOP + 4}px">
					{fmtMoment(timeAt(Math.min(drag.start, drag.end)), span)} → {fmtMoment(timeAt(Math.max(drag.start, drag.end)), span)}
				</div>
			{/if}

			{#if showReadout && hoverBucket && hoverBar && !drag?.moved}
				<div class="readout" class:flip style:left="{hoverBar.center}px" style:top="{PAD_TOP}px">
					<span class="when">{bucketLabel(hoverBucket.at)}</span>
					{#each [...hoverBucket.parts].reverse() as part (part.key)}
						<span class="row">
							<i class="key" style:background={colors[part.key]}></i>
							<b class:none={part.value === null}>{format(part.value)}</b>
							<span class="name">{labelOf(part.key)}</span>
						</span>
					{/each}
					{#if hoverBucket.parts.length > 1}
						<span class="row total">
							<i class="key blank"></i>
							<b class:none={hoverBucket.total === null}>{format(hoverBucket.total)}</b>
							<span class="name">{t('web.chart.total')}</span>
						</span>
					{/if}
					{#each hoverBands as band, index (index)}
						<span class="row">
							<i class="key block band-key" data-tone={band.tone ?? 'critical'}></i>
							<span class="name">{band.label}</span>
						</span>
					{/each}
					{#if onbar && hoverBucket.total !== null}
						<span class="hint">{barHint ?? t('web.chart.openBucket')}</span>
					{/if}
				</div>
			{/if}
		{/if}
	</div>

	{#if legend && !compact && series.length > 1}
		<div class="legend" role="group" aria-label={t('web.chart.legend')}>
			{#each series as entry (entry.key)}
				<button
					type="button"
					class="entry"
					class:off={hidden.includes(entry.key)}
					aria-pressed={!hidden.includes(entry.key)}
					onclick={() => toggle(entry.key)}
				>
					<i class="key block" style:background={colors[entry.key]}></i>
					<span>{labelOf(entry.key)}</span>
				</button>
			{/each}
		</div>
	{/if}
</div>

<style lang="scss">
	.stacked-bars {
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

	// the hovered bucket's column, a ghost wash behind the bar
	.column {
		fill: var(--bg-hover);
		opacity: 0.6;
	}

	.segment {
		transition: opacity 0.1s ease;

		&.dim {
			opacity: 0.55;
		}
	}

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

	// a diamond on the plot's top edge; the hover target is wider than the mark
	.marker-flag {
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

		&:is(a) {
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

	.band-key {
		background: var(--chart-critical);
		opacity: 0.6;

		&[data-tone='warning'] {
			background: var(--chart-warning);
		}

		&[data-tone='neutral'] {
			background: var(--chart-muted);
		}
	}

	.selection {
		fill: var(--chart-selection);
		stroke: var(--link);
		stroke-width: 1;
	}

	.hit {
		position: absolute;
		cursor: crosshair;
		border-radius: 0.25rem;

		&.pickable {
			cursor: pointer;
		}

		&:focus-visible {
			@include focus-ring;
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
		margin-left: 1rem;
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
			margin-left: -1rem;
		}

		.when,
		.hint {
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
	}

	.key {
		display: inline-block;
		flex: none;
		width: 0.75rem;
		height: 0.125rem;
		border-radius: 0.125rem;

		&.block {
			width: 0.625rem;
			height: 0.625rem;
		}

		&.blank {
			background: none;
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
	}
</style>
