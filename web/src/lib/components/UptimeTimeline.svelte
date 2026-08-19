<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { tooltip } from '$lib/tooltip.svelte';

	import { slotFor, type UptimeDayPoint } from './uptime';

	/**
	 * Uptime history: one slot per day, oldest on the left.
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
		compact = false
	}: {
		days: UptimeDayPoint[];
		/** Uptime across the window, percent; null when nothing was observed */
		pct?: number | null;
		/** Show only the most recent N days; absent shows them all */
		count?: number;
		height?: string;
		/** Drop the footer row, for a timeline sitting inside a dense card */
		compact?: boolean;
	} = $props();

	const window = $derived(count === undefined ? days : days.slice(-count));
	const slots = $derived(window.map((day) => slotFor(day)));

	// ninety slots in the width a panel gives them leaves the gaps wider than the
	// bars, so the gap gives way once the run is long
	const gap = $derived(slots.length > 45 ? '0.125rem' : '0.1875rem');

	const spanLabel = $derived(t('web.uptime.days', { count: String(slots.length) }));

	function label(slot: (typeof slots)[number]): string {
		if (slot.pct === null) {
			return `${slot.d} · ${t('web.uptime.notMeasured')}`;
		}

		const reading = `${slot.d} · ${slot.pct.toFixed(2)}%`;

		return slot.lostMinutes
			? `${reading} · ${t('web.uptime.minutesDown', { count: String(slot.lostMinutes) })}`
			: reading;
	}
</script>

<div class="uptime-timeline">
	<div class="track-row" style:height style:gap>
		{#each slots as slot (slot.d)}
			<div
				class="slot"
				class:empty={slot.tone === 'none'}
				use:tooltip={{ content: label(slot) }}
			>
				{#if slot.height > 0}
					<i data-tone={slot.tone} style:height="{slot.height}%"></i>
				{/if}
			</div>
		{/each}
	</div>

	{#if !compact}
		<div class="legend">
			<span>{spanLabel}</span>
			<span class="today">{t('web.uptime.today')}</span>
			<span class="pct">{pct === null ? '–' : `${pct}%`}</span>
		</div>
	{/if}
</div>

<style lang="scss">
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

	.pct {
		color: var(--text-heading);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
</style>
