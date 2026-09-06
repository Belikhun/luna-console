<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import ProgressBar from './ProgressBar.svelte';
	import { xpToNextLevel } from '$core/playerdata';

	/**
	 * A player's vital signs as the game's own bars: health in hearts, hunger in
	 * drumsticks, experience as the level and its bar. One component draws all
	 * three so the online table's cells and the detail screen agree on colour,
	 * scale and wording; `kind` picks which bar, `compact` fits it in a table cell.
	 *
	 * Health and food are segmented at one block per heart / drumstick, which is
	 * how the HUD reads them: twenty points is ten hearts. Absorption is added on
	 * top of the health caption, not the bar, since the HUD draws it as extra
	 * hearts rather than by filling the same ones.
	 */
	let {
		kind,
		value,
		max = 20,
		extra = 0,
		level = 0,
		compact = false,
		width
	}: {
		kind: 'health' | 'food' | 'xp';
		/** Health points, food points, or xp progress into the level (0-1) */
		value: number;
		/** Health or food maximum; ignored for xp */
		max?: number;
		/** Absorption hearts, health only */
		extra?: number;
		/** The experience level, xp only */
		level?: number;
		compact?: boolean;
		width?: string;
	} = $props();

	const color = $derived(kind === 'health' ? 'danger' : kind === 'food' ? 'warning' : 'success');

	const caption = $derived.by(() => {
		if (kind === 'xp') {
			const needed = xpToNextLevel(level);

			return t('web.vitals.xpCaption', {
				level,
				have: Math.round(value * needed),
				needed
			});
		}

		const shown = Math.round(value * 10) / 10;
		const base = `${shown} / ${max}`;

		if (kind === 'health' && extra > 0) {
			return t('web.vitals.healthWithAbsorption', { base, extra: Math.round(extra * 10) / 10 });
		}

		return base;
	});

	const label = $derived(
		kind === 'health'
			? t('web.vitals.health')
			: kind === 'food'
				? t('web.vitals.food')
				: t('web.vitals.level', { level })
	);

	const barValue = $derived(kind === 'xp' ? value : Math.max(0, Math.min(max, value)));
	const barMax = $derived(kind === 'xp' ? 1 : max);
</script>

{#if compact}
	<span class="vital compact" title="{label}: {caption}">
		<span class="num">{kind === 'xp' ? level : Math.round(value * 10) / 10}</span>
		<ProgressBar
			value={barValue}
			max={barMax}
			{color}
			compact
			right={null}
			segmented={kind !== 'xp'}
			transition={false}
			width={width ?? '5rem'}
		/>
	</span>
{:else}
	<div class="vital">
		<ProgressBar
			value={barValue}
			max={barMax}
			{color}
			left={label}
			right={caption}
			segmented={kind !== 'xp'}
			height="0.625rem"
			{width}
		/>
	</div>
{/if}

<style lang="scss">
	.vital {
		display: block;
		min-width: 0;

		&.compact {
			display: inline-flex;
			align-items: center;
			gap: 0.5rem;
			white-space: nowrap;
		}
	}

	.num {
		font-variant-numeric: tabular-nums;
		min-width: 2rem;
		text-align: right;
	}
</style>
