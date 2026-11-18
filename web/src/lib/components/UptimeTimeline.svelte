<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { tooltip } from '$lib/tooltip.svelte';

	import { slotFor, type UptimeDayPoint, type UptimeRow, type UptimeSlot } from './uptime';

	/**
	 * Uptime history: one slot per day, oldest on the left, with an accessible
	 * name per day and for the row, and an optional `onselect` that opens a day.
	 *
	 * Each slot is a full-height track with the day's fill inside it, anchored to
	 * the floor, so the row reads as a fixed run of days and a short bar reads as
	 * a shortfall against a visible ceiling. Two channels carry the day: the
	 * fill's height and its colour, banded in `uptime.ts`.
	 *
	 * A day nobody observed leaves its track empty rather than drawing a zero.
	 * The daemon not watching and the server being down are different claims, and
	 * a timeline that paints them the same way is lying about one of them.
	 */
	let {
		days,
		pct = null,
		count,
		height = '1.75rem',
		compact = false,
		label,
		rows,
		onselect
	}: {
		/** One row's days; ignored when `rows` is given */
		days?: UptimeDayPoint[];
		/** Uptime across the window, percent; null when nothing was observed */
		pct?: number | null;
		/** Show only the most recent N days; absent shows them all */
		count?: number;
		height?: string;
		/** Drop the footer row, for a timeline sitting inside a dense card */
		compact?: boolean;
		/** What the row is the uptime of, for screen readers */
		label?: string;
		/**
		 * Several timelines on one day axis (a row per service), each with its
		 * name on the left and its percentage on the right
		 */
		rows?: UptimeRow[];
		/** A day was chosen; days become buttons */
		onselect?: (day: string) => void;
	} = $props();

	// one precision for uptime everywhere: two decimals, trailing zeros dropped (100%, 99.87%)
	function fmtPct(value: number): string {
		return `${Number(value.toFixed(2))}%`;
	}

	function lastDays(list: UptimeDayPoint[]): UptimeSlot[] {
		const shown = count === undefined
			? list
			: list.slice(-count);

		return shown.map((day) => slotFor(day));
	}

	const lines = $derived(
		rows
			? rows.map((row) => ({ label: row.label, pct: row.pct, slots: lastDays(row.days) }))
			: [{ label: label ?? '', pct, slots: lastDays(days ?? []) }]
	);

	const dayCount = $derived(lines[0]?.slots.length ?? 0);

	// ninety slots in the width a panel gives them leaves the gaps wider than the
	// bars, so the gap gives way once the run is long
	const gap = $derived(dayCount > 45 ? '0.125rem' : '0.1875rem');

	const spanLabel = $derived(t('web.uptime.days', { count: String(dayCount) }));

	/** The day's hint: its date, uptime, how long it was watched and how often it stopped. */
	function describe(slot: UptimeSlot, row: string): string {
		const head = row
			? `${row} · ${slot.d}`
			: slot.d;

		if (slot.pct === null) {
			return `${head} · ${t('web.uptime.notMeasured')}`;
		}

		const parts = [head, fmtPct(slot.pct)];

		if (slot.watchedHours < 24) {
			parts.push(t('web.uptime.watched', { hours: String(slot.watchedHours) }));
		}

		if (slot.lostMinutes) {
			parts.push(t('web.uptime.minutesDown', { count: String(slot.lostMinutes) }));
		}

		if (slot.stops) {
			parts.push(t('web.uptime.stops', { count: String(slot.stops) }));
		}

		return parts.join(' · ');
	}
</script>

{#snippet track(slots: UptimeSlot[], row: string)}
	<div class="track-row" style:height style:gap role="group" aria-label={row || undefined}>
		{#each slots as slot (slot.d)}
			{#if onselect}
				<button
					type="button"
					class="slot"
					class:empty={slot.tone === 'none'}
					aria-label={describe(slot, row)}
					use:tooltip={{ content: describe(slot, row) }}
					onclick={() => onselect?.(slot.d)}
				>
					{#if slot.height > 0}
						<i data-tone={slot.tone} style:height="{slot.height}%"></i>
					{/if}
				</button>
			{:else}
				<div
					class="slot"
					class:empty={slot.tone === 'none'}
					role="img"
					aria-label={describe(slot, row)}
					use:tooltip={{ content: describe(slot, row) }}
				>
					{#if slot.height > 0}
						<i data-tone={slot.tone} style:height="{slot.height}%"></i>
					{/if}
				</div>
			{/if}
		{/each}
	</div>
{/snippet}

<div class="uptime-timeline" role={rows ? 'group' : undefined} aria-label={rows ? label : undefined}>
	{#if rows}
		<div class="rows">
			{#each lines as line (line.label)}
				<span class="row-name">{line.label}</span>
				{@render track(line.slots, line.label)}
				<span class="row-pct">{line.pct === null ? '–' : fmtPct(line.pct)}</span>
			{/each}
		</div>
	{:else}
		{@render track(lines[0]?.slots ?? [], label ?? '')}
	{/if}

	{#if !compact}
		<div class="legend">
			<!-- the aggregate belongs beside the window it is measured over; sitting
			     next to "today" it read as today's own figure, which it is not -->
			<span>
				{spanLabel}{#if pct !== null && !rows}{' · '}{t('web.uptime.upOfWatched', { pct: fmtPct(pct).replace('%', '') })}{/if}
			</span>
			<span class="today">{t('web.uptime.today')}</span>
		</div>
	{/if}
</div>

<style lang="scss">
	// one day axis for every row: the names and percentages take their own
	// columns so the tracks start and end together
	.rows {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr) max-content;
		align-items: center;
		gap: 0.5rem 0.75rem;
	}

	.row-name {
		@include ellipsis;

		max-width: 10rem;
		font-size: 0.8125rem;
		color: var(--text);
	}

	.row-pct {
		font-size: 0.8125rem;
		font-weight: 700;
		color: var(--text-heading);
		font-variant-numeric: tabular-nums;
		text-align: right;
	}

	.track-row {
		display: flex;
		align-items: stretch;
	}

	// the day's slot: always drawn, so the row is a fixed run of days rather than
	// a ragged skyline
	.slot {
		flex: 1 1 0;
		min-width: 0.1875rem;
		border-radius: 0.25rem;
		background: color-mix(in srgb, var(--bg-track) 42%, transparent);
		display: flex;
		align-items: flex-end;
		overflow: hidden;

		&.empty {
			background: color-mix(in srgb, var(--bg-track) 22%, transparent);
		}

		&:hover i {
			filter: brightness(1.4);
		}
	}

	button.slot {
		@include bare-button;

		background: color-mix(in srgb, var(--bg-track) 42%, transparent);

		&.empty {
			background: color-mix(in srgb, var(--bg-track) 22%, transparent);
		}

		&:focus-visible {
			@include focus-ring;
		}
	}

	i {
		display: block;
		width: 100%;
		border-radius: 0.25rem;
		background: var(--success);

		&[data-tone='warn'] {
			background: var(--warning);
		}

		&[data-tone='bad'] {
			background: var(--primary);
		}

		&[data-tone='down'] {
			background: var(--error);
		}
	}

	.legend {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		margin-top: 0.375rem;
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.today {
		margin-left: auto;
	}
</style>
