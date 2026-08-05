<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	/**
	 * Range slider for a bounded numeric setting, with a live readout and; when the
	 * range is short enough to be legible; a tick per step, so a stepped setting
	 * looks stepped.
	 *
	 * The native input is kept and restyled rather than rebuilt from divs: it already
	 * has the keyboard behaviour (arrows, Home/End, PageUp/Down), the drag handling
	 * and the a11y semantics, and its `step` does the snapping for free.
	 */
	let {
		value = 0,
		min = 0,
		max = 100,
		step = 1,
		unit = '',
		disabled = false,
		label,
		width = '100%',
		onchange
	}: {
		value?: number;
		min?: number;
		max?: number;
		step?: number;
		/** appended to the readout, e.g. " chunks" */
		unit?: string;
		disabled?: boolean;
		/** accessible name when the field's own label is elsewhere */
		label?: string;
		width?: string;
		onchange?: (value: number) => void;
	} = $props();

	/** ticks stop being readable long before they stop fitting */
	const MAX_TICKS = 40;

	// px, not rem: this is measured layout geometry, compared against a minimum
	// spacing below which a tick row stops reading as ticks and becomes a hatch
	const MIN_TICK_GAP = 14;
	const THUMB = 16;

	let railWidth = $state(0);

	const steps = $derived(step > 0 ? Math.round((max - min) / step) : 0);

	/**
	 * How many intervals to tick. A slider always shows a tick scale; that is what
	 * says "this is a range between two ends, and it moves in jumps"; so a range
	 * with more steps than the field is wide enough to show gets a coarser scale
	 * rather than none. A divisor of the step count keeps those hint ticks on real
	 * step boundaries; with no usable divisor (a prime step count) an even split
	 * still reads the scale, it just doesn't land on steps.
	 */
	const ticks = $derived.by(() => {
		// nothing is drawn until the rail has been measured: a first paint at some
		// other density, corrected a frame later, is more distracting than a delay
		if (steps <= 1 || railWidth === 0) {
			return 0;
		}

		const room = Math.max(2, Math.floor((railWidth - THUMB) / MIN_TICK_GAP));

		if (steps <= room) {
			return steps;
		}

		for (let count = Math.min(room, MAX_TICKS); count >= 4; count--) {
			if (steps % count === 0) {
				return count;
			}
		}

		return Math.min(room, 10);
	});

	const fraction = $derived(max > min ? (Math.min(max, Math.max(min, value)) - min) / (max - min) : 0);
</script>

<div class="sl" class:disabled style:width style:--fill="{fraction * 100}%">
	<div class="track">
		<div class="rail" bind:clientWidth={railWidth}>
			<input
				type="range"
				{min}
				{max}
				{step}
				{value}
				{disabled}
				aria-label={label}
				oninput={(event) => onchange?.(Number(event.currentTarget.value))}
			/>
			{#if ticks}
				<!-- drawn as a repeating gradient: 30 tick elements would be 30 nodes
				     per field for something purely decorative -->
				<div class="ticks" style:background-size="calc(100% / {ticks}) 100%"></div>
			{/if}
		</div>
		<div class="ends">
			<span>{min}</span>
			<span>{max}</span>
		</div>
	</div>
	<span class="val">{value}{unit}</span>
</div>

<style lang="scss">
	.sl {
		display: flex;
		align-items: center;
		gap: 0.75rem;

		&.disabled {
			.val {
				color: var(--text-disabled);
			}
		}
	}

	.track {
		flex: 1;
		min-width: 4rem;
	}

	// holds the input and the tick row it is measured against
	.rail {
		position: relative;
		padding-bottom: 0.375rem;
	}

	.val {
		flex: none;
		min-width: 3rem;
		font-size: 0.8125rem;
		font-variant-numeric: tabular-nums;
		color: var(--text-heading);
		font-weight: 700;
	}

	// the ticks sit below the track, inset by half a thumb at each end so the scale
	// spans the thumb's own travel rather than the element's full width
	.ticks {
		position: absolute;
		left: 0.5rem;
		right: 0.5rem;
		bottom: 0;
		height: 0.25rem;
		background-image: linear-gradient(
			to right,
			var(--border) 0 var(--hairline),
			transparent var(--hairline)
		);
		background-repeat: repeat-x;
		pointer-events: none;
	}

	// the ends label the tick scale; without them the ticks say "it steps" but not
	// "between what and what"
	.ends {
		display: flex;
		justify-content: space-between;
		font-size: 0.6875rem;
		line-height: 1;
		color: var(--text-secondary);
		font-variant-numeric: tabular-nums;
	}

	.sl.disabled .ends {
		color: var(--text-disabled);
	}

	// the same 0.5rem track and 1rem knob as ProgressBar and the Toggle, so a form
	// mixing all three reads as one control set
	input[type='range'] {
		appearance: none;
		display: block;
		width: 100%;
		height: 1rem;
		margin: 0;
		background: transparent;
		cursor: pointer;

		&:disabled {
			cursor: default;
		}

		&::-webkit-slider-runnable-track {
			height: 0.5rem;
			border-radius: 0.5rem;
			background: linear-gradient(
				to right,
				var(--link) 0 var(--fill),
				var(--bg-track) var(--fill) 100%
			);
		}

		&::-moz-range-track {
			height: 0.5rem;
			border-radius: 0.5rem;
			background: linear-gradient(
				to right,
				var(--link) 0 var(--fill),
				var(--bg-track) var(--fill) 100%
			);
		}

		&::-webkit-slider-thumb {
			appearance: none;
			width: 1rem;
			height: 1rem;
			// centres the 1rem knob on the 0.5rem track
			margin-top: -0.25rem;
			border-radius: 50%;
			background: var(--link);
			border: 0.125rem solid var(--bg-panel);
		}

		&::-moz-range-thumb {
			width: 0.75rem;
			height: 0.75rem;
			border-radius: 50%;
			background: var(--link);
			border: 0.125rem solid var(--bg-panel);
		}

		&:disabled::-webkit-slider-thumb {
			background: var(--text-disabled);
		}

		&:disabled::-moz-range-thumb {
			background: var(--text-disabled);
		}

		&:focus-visible {
			outline: none;

			&::-webkit-slider-thumb {
				box-shadow: 0 0 0 0.1875rem color-mix(in srgb, var(--link) 45%, transparent);
			}

			&::-moz-range-thumb {
				box-shadow: 0 0 0 0.1875rem color-mix(in srgb, var(--link) 45%, transparent);
			}
		}
	}
</style>
