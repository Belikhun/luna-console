<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	/**
	 * A run of days as a grid of small cells - one column per week, one row per
	 * weekday - each shaded by how much of the metric landed on that day, with a
	 * hover card carrying the day's own figures. Ported from the dashboard's
	 * `CalendarGraph` in src/charts.js, drawn with `NodeOverview`'s ramp and hover
	 * card so the two read as one family.
	 *
	 * It answers what a table of records cannot: whether the activity is a habit,
	 * a burst, or a thing that stopped. Every day inside the range gets a cell,
	 * the empty ones included, because the gaps are half of that answer.
	 *
	 * The range is snapped outward to whole monday → sunday weeks so every column
	 * is a full week and the weekday rows stay aligned; the days that snapping
	 * adds keep their grid slot but are not drawn.
	 */

	import { onMount } from 'svelte';

	import { t } from '$lib/i18n.svelte';
	import type { OverviewDetail } from './nodeoverview';
	import type { CalendarDay, CalendarPoint } from './calendargraph';

	let {
		points,
		levels = 4,
		cell = '0.75rem',
		gap = '0.25rem',
		ramp = ['var(--bg-hover)', 'var(--link)'],
		from = null,
		to = null,
		legend = true,
		valueFormat = (value: number) => String(value),
		dayDetails,
		empty
	}: {
		points: CalendarPoint[];
		/**
		 * Shading of a non-empty day: quantized into N steps, or `smooth` for the
		 * continuous ramp. Steps make two busy days comparable at a glance; smooth
		 * keeps a long tail of small days from all looking alike.
		 */
		levels?: number | 'smooth';
		/** Cell edge; keep it on the spacing scale */
		cell?: string;
		gap?: string;
		/**
		 * Ramp stops, empty day to busiest day. Two or more; design tokens are
		 * fine, and are resolved at paint time rather than baked in here.
		 */
		ramp?: string[];
		/** Range bounds as epoch millis; derived from the data when null */
		from?: number | null;
		to?: number | null;
		legend?: boolean;
		/** Renders a day's total, in the card and in the cell's own label */
		valueFormat?: (value: number) => string;
		/** Extra rows for the hover card, for what the total alone does not say */
		dayDetails?: (day: CalendarDay) => OverviewDetail[];
		/** Shown in place of the grid when there is nothing to draw */
		empty?: string;
	} = $props();

	/** How far the hover card is kept from the edge of the window. */
	const MARGIN = 12;
	/** Space between the hovered cell and its card. */
	const OFFSET = 10;

	const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

	const MONTH_KEYS = [
		'jan',
		'feb',
		'mar',
		'apr',
		'may',
		'jun',
		'jul',
		'aug',
		'sep',
		'oct',
		'nov',
		'dec'
	];

	/** One grid slot: a day, or a padding slot from snapping to whole weeks. */
	interface Slot {
		row: number;
		day: CalendarDay | null;
	}

	let hovered: number | null = $state(null);
	let cardEl: HTMLElement | undefined = $state();
	let cellsEl: HTMLElement | undefined = $state();
	let scrollerEl: HTMLElement | undefined = $state();

	let card = $state({ left: 0, top: 0, ready: false });
	let bump = $state(0);

	const weekdays = $derived(WEEKDAY_KEYS.map((key) => t(`web.calendar.weekday.${key}`)));
	const months = $derived(MONTH_KEYS.map((key) => t(`web.calendar.month.${key}`)));

	/** Local midnight of the day an instant falls in. */
	function dayStartOf(at: number): number {
		const date = new Date(at);

		return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
	}

	const grid = $derived.by(() => {
		const days = new Map<number, CalendarDay>();

		for (const point of points) {
			const start = dayStartOf(point.at);
			const existing = days.get(start);

			if (existing) {
				existing.value += point.value;
				existing.count += 1;
				continue;
			}

			days.set(start, { start, value: point.value, count: 1 });
		}

		const keys = [...days.keys()];

		const first = from !== null ? dayStartOf(from) : keys.length > 0 ? Math.min(...keys) : null;
		const last = to !== null ? dayStartOf(to) : keys.length > 0 ? Math.max(...keys) : null;

		if (first === null || last === null || last < first) {
			return { slots: [] as Slot[], labels: [] as Array<{ column: number; month: number }>, max: 1 };
		}

		let max = 0;

		for (const day of days.values()) {
			if (day.value > max) {
				max = day.value;
			}
		}

		// a range where everything is zero still has to divide by something
		if (max <= 0) {
			max = 1;
		}

		const start = new Date(first);
		start.setDate(start.getDate() - ((start.getDay() + 6) % 7));

		const end = new Date(last);
		end.setDate(end.getDate() + ((7 - end.getDay()) % 7));

		const slots: Slot[] = [];
		const labels: Array<{ column: number; month: number }> = [];
		const cursor = new Date(start);

		let column = 0;
		let lastMonth: number | null = null;

		while (cursor.getTime() <= end.getTime()) {
			const row = (cursor.getDay() + 6) % 7;

			if (row === 0) {
				if (cursor.getTime() > start.getTime()) {
					column += 1;
				}

				const month = cursor.getMonth();

				if (lastMonth === null || month !== lastMonth) {
					labels.push({ column, month });
				}

				lastMonth = month;
			}

			const key = cursor.getTime();
			const inRange = key >= first && key <= last;

			slots.push({
				row,
				day: inRange ? (days.get(key) ?? { start: key, value: 0, count: 0 }) : null
			});

			cursor.setDate(cursor.getDate() + 1);
		}

		// the range's first month label usually sits in a cramped partial month;
		// drop it when the next one starts too close to fit the word
		if (labels.length > 1 && labels[1]!.column - labels[0]!.column < 3) {
			labels.shift();
		}

		return { slots, labels, max };
	});

	const day = $derived(hovered === null ? null : (grid.slots[hovered]?.day ?? null));
	const hoveredRow = $derived(hovered === null ? 0 : (grid.slots[hovered]?.row ?? 0));

	const details = $derived(day && dayDetails ? dayDetails(day) : []);

	/**
	 * How far up the ramp a day's total sits, in the [0, 1] range.
	 *
	 * A day with nothing on it reads as the ramp's low stop, and the lowest
	 * non-empty day still lifts clear of it: a cell that had *something* must not
	 * look like a cell that had nothing.
	 */
	function intensity(value: number): number {
		if (value <= 0) {
			return 0;
		}

		const share = value / grid.max;

		if (levels === 'smooth') {
			return 0.15 + 0.85 * share;
		}

		return Math.min(Math.ceil(share * levels), levels) / levels;
	}

	/**
	 * The paint colour for a position on the ramp.
	 *
	 * The position lands between two stops and is expressed as a mix of that
	 * pair, so an N-stop ramp costs no more than one `color-mix` per cell and the
	 * stops stay live tokens.
	 */
	function rampColor(position: number): string {
		if (ramp.length === 0) {
			return 'var(--bg-hover)';
		}

		if (ramp.length === 1) {
			return ramp[0]!;
		}

		const scaled = Math.max(0, Math.min(1, position)) * (ramp.length - 1);
		const index = Math.min(Math.floor(scaled), ramp.length - 2);
		const share = Math.round((scaled - index) * 1000) / 10;

		return `color-mix(in srgb, ${ramp[index + 1]} ${share}%, ${ramp[index]})`;
	}

	function colorOf(value: number): string {
		return rampColor(intensity(value));
	}

	/** The day's own name, as the hover card and the cell's label both say it. */
	function dateLabel(start: number): string {
		const date = new Date(start);

		return t('web.calendar.date', {
			day: date.getDate(),
			month: months[date.getMonth()] ?? '',
			year: date.getFullYear()
		});
	}

	const legendSteps = $derived.by(() => {
		if (levels === 'smooth') {
			return [] as number[];
		}

		return Array.from({ length: levels + 1 }, (_, index) => index / levels);
	});

	/**
	 * Hang the card off the hovered cell, then pull it back inside the window.
	 *
	 * Placed against the viewport rather than the grid, for the same reason
	 * `NodeOverview` does it: the grid scrolls sideways inside a panel that clips,
	 * and a card wider than a week column would be cut off exactly when it has
	 * the most to say.
	 */
	$effect(() => {
		const element = cardEl;
		const index = hovered;

		void bump;
		void day;

		if (!element || index === null || !cellsEl) {
			return;
		}

		const target = cellsEl.children[index] as HTMLElement | undefined;

		if (!target) {
			return;
		}

		const anchor = target.getBoundingClientRect();
		const size = element.getBoundingClientRect();

		// above the cell by default, below it when there is no room up there
		let top = anchor.top - size.height - OFFSET;

		if (top < MARGIN) {
			top = anchor.bottom + OFFSET;
		}

		const left = anchor.left + anchor.width / 2 - size.width / 2;

		card = {
			left: Math.max(MARGIN, Math.min(left, window.innerWidth - MARGIN - size.width)),
			top: Math.max(MARGIN, Math.min(top, window.innerHeight - MARGIN - size.height)),
			ready: true
		};
	});

	// the newest week is the one worth seeing first, and it is the rightmost
	$effect(() => {
		void grid;

		if (scrollerEl) {
			scrollerEl.scrollLeft = scrollerEl.scrollWidth;
		}
	});

	// the card is placed against the viewport, so anything moving the grid inside
	// it has to re-place the card; the console scrolls panels, not the window
	onMount(() => {
		const reposition = (): void => {
			bump += 1;
		};

		window.addEventListener('resize', reposition);
		window.addEventListener('scroll', reposition, true);

		return () => {
			window.removeEventListener('resize', reposition);
			window.removeEventListener('scroll', reposition, true);
		};
	});

	function enter(index: number): void {
		hovered = index;
		card = { ...card, ready: false };
	}

	function leave(index: number): void {
		if (hovered === index) {
			hovered = null;
		}
	}
</script>

<div class="cal" style:--cal-cell={cell} style:--cal-gap={gap}>
	{#if grid.slots.length === 0}
		<div class="empty dim">{empty ?? ''}</div>
	{:else}
		<div class="graph">
			<div class="weekdays">
				{#each weekdays as name, row (row)}
					<!-- every other row is labelled; the blank spans hold the alignment -->
					<span>{row % 2 === 0 ? name : ''}</span>
				{/each}
			</div>

			<div class="scroller" bind:this={scrollerEl}>
				<div class="months">
					{#each grid.labels as label (label.column)}
						<span style:grid-column-start={label.column + 1}>{months[label.month]}</span>
					{/each}
				</div>

				<div class="cells" bind:this={cellsEl}>
					{#each grid.slots as slot, index (index)}
						{#if slot.day}
							<!-- A swatch, not a control: a year of days turned into tab stops
							     would bury every real control on the page, so the grid stays
							     presentational and the table below carries the keyboard path. -->
							<div
								class="cell"
								class:active={hovered === index}
								style:background-color={colorOf(slot.day.value)}
								role="img"
								aria-label="{dateLabel(slot.day.start)}: {valueFormat(slot.day.value)}"
								onmouseenter={() => enter(index)}
								onmouseleave={() => leave(index)}
							></div>
						{:else}
							<div class="cell outbound"></div>
						{/if}
					{/each}
				</div>
			</div>
		</div>

		{#if legend}
			<div class="legend">
				<span class="tick">{t('web.calendar.less')}</span>
				{#if levels === 'smooth'}
					<div class="gradient" style:background="linear-gradient(to right, {ramp.join(', ')})"></div>
				{:else}
					{#each legendSteps as step (step)}
						<span class="swatch" style:background-color={rampColor(step)}></span>
					{/each}
				{/if}
				<span class="tick">{t('web.calendar.more')}</span>
				<span class="tick busiest">
					{t('web.calendar.busiest', { value: valueFormat(grid.max) })}
				</span>
			</div>
		{/if}
	{/if}
</div>

{#if day}
	<div
		class="calcard"
		bind:this={cardEl}
		style:left="{card.left}px"
		style:top="{card.top}px"
		style:visibility={card.ready ? 'visible' : 'hidden'}
	>
		<div class="head">
			<span class="name">{weekdays[hoveredRow]} {dateLabel(day.start)}</span>
		</div>

		<div class="readout">
			<span class="swatch" style:background-color={colorOf(day.value)}></span>
			<span class="big">{valueFormat(day.value)}</span>
		</div>

		{#if details.length > 0}
			<div class="details">
				{#each details as detail (detail.key)}
					<div class="detail">
						<span class="key">{detail.key}</span>
						<span class="val" class:mono={detail.mono}>{detail.value}</span>
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/if}

<style lang="scss">
	.cal {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.graph {
		display: flex;
		flex-direction: row;
		gap: var(--cal-gap);
	}

	.weekdays {
		display: grid;
		grid-auto-rows: var(--cal-cell);
		row-gap: var(--cal-gap);

		// clears the month strip, so the first row lines up with monday's cells
		margin-top: 1rem;

		> span {
			padding-right: 0.25rem;
			font-size: 0.625rem;
			line-height: var(--cal-cell);
			color: var(--text-secondary);
		}
	}

	.scroller {
		overflow-x: auto;
		padding-bottom: 0.25rem;
	}

	.months {
		display: grid;
		grid-auto-flow: column;
		grid-auto-columns: var(--cal-cell);
		column-gap: var(--cal-gap);
		height: 1rem;

		> span {
			font-size: 0.625rem;
			color: var(--text-secondary);
			white-space: nowrap;
		}
	}

	.cells {
		display: grid;
		grid-auto-flow: column;
		grid-template-rows: repeat(7, var(--cal-cell));
		grid-auto-columns: var(--cal-cell);
		gap: var(--cal-gap);
		width: fit-content;

		// the hover outline sits outside the cell; without the room it is clipped
		// by the scroller on the first and last column
		padding: 0.25rem;
	}

	.cell {
		border-radius: 0.125rem;
		transition: transform 0.1s ease;

		&.outbound {
			visibility: hidden;
		}

		// the outline sits outside the cell so the grid does not reflow on hover
		&.active {
			outline: 0.1rem solid var(--text);
			outline-offset: 0.1rem;
			transform: scale(1.15);
		}
	}

	.empty {
		font-size: 0.8125rem;
	}

	.legend {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: var(--cal-gap);

		.tick {
			margin: 0 0.25rem;
			font-size: 0.6875rem;
			color: var(--text-secondary);
			font-variant-numeric: tabular-nums;
		}

		.busiest {
			margin-left: 0.5rem;
		}

		.gradient {
			width: calc((var(--cal-cell) * 5) + (var(--cal-gap) * 4));
			height: var(--cal-cell);
			border-radius: 0.125rem;
		}

		.swatch {
			width: var(--cal-cell);
			height: var(--cal-cell);
			border-radius: 0.125rem;
		}
	}

	.calcard {
		position: fixed;
		z-index: 60;
		pointer-events: none;
		min-width: 12rem;
		max-width: 22rem;
		padding: 0.625rem 0.75rem;
		border: 0.1rem solid var(--border);
		border-radius: 0.5rem;
		background: color-mix(in srgb, var(--bg-dropdown) 96%, transparent);
		box-shadow: 0 0.5rem 1.5rem rgb(0 0 0 / 35%);
	}

	.head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.5rem;

		.name {
			font-size: 0.8125rem;
			font-weight: 700;
			color: var(--text);
		}
	}

	.readout {
		display: flex;
		align-items: center;
		gap: 0.375rem;

		.swatch {
			width: 0.625rem;
			height: 0.625rem;
			border-radius: 0.125rem;
		}

		.big {
			font-size: 0.875rem;
			font-weight: 700;
			color: var(--text);
			font-variant-numeric: tabular-nums;
		}
	}

	.details {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin-top: 0.5rem;

		.detail {
			display: flex;
			justify-content: space-between;
			gap: 1rem;
			font-size: 0.75rem;
		}

		.key {
			color: var(--text-secondary);
		}

		.val {
			color: var(--text);
			font-variant-numeric: tabular-nums;
			text-align: right;

			&.mono {
				font-family: var(--font-mono);
			}
		}
	}
</style>
