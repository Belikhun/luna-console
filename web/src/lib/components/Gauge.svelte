<script lang="ts">
	/**
	 * Radial gauge: a 270° arc with the reading in the middle and a caption
	 * under it. Tone follows the same thresholds as ProgressBar's `auto`, so a
	 * gauge and a bar never disagree about what 91% means.
	 */
	let {
		value,
		max = 100,
		label,
		display,
		unit = '%',
		footnote,
		color = 'auto',
		size = '8.5rem'
	}: {
		/** null renders the dial empty with a dash; "not measured", not zero */
		value: number | null;
		max?: number;
		label: string;
		/** overrides the number in the middle (e.g. "12.4 / 31 GB") */
		display?: string;
		unit?: string;
		footnote?: string;
		color?: 'accent' | 'success' | 'warning' | 'danger' | 'auto';
		size?: string;
	} = $props();

	/** svg user units; the viewBox is square, so these are its own scale */
	const R = 42;
	const CIRCUMFERENCE = 2 * Math.PI * R;

	/** the dial is three quarters of a circle, opening at the bottom */
	const SWEEP = 0.75;
	const ARC = CIRCUMFERENCE * SWEEP;

	const pct = $derived(value === null ? 0 : Math.max(0, Math.min(100, (value / max) * 100)));

	const tone = $derived(
		color !== 'auto' ? color : pct >= 90 ? 'danger' : pct >= 75 ? 'warning' : 'accent'
	);

	const reading = $derived(
		display ?? (value === null ? '–' : `${Math.round(value * 10) / 10}${unit}`)
	);
</script>

<div class="gauge" style:width={size}>
	<div class="dial" style:height={size}>
		<svg viewBox="0 0 100 100" aria-hidden="true">
			<circle
				class="track"
				cx="50"
				cy="50"
				r={R}
				stroke-dasharray="{ARC} {CIRCUMFERENCE}"
				transform="rotate(135 50 50)"
			/>
			<circle
				class="fill"
				data-tone={tone}
				cx="50"
				cy="50"
				r={R}
				stroke-dasharray="{(ARC * pct) / 100} {CIRCUMFERENCE}"
				transform="rotate(135 50 50)"
			/>
		</svg>
		<div class="read" data-tone={tone}>{reading}</div>
	</div>
	<div class="cap">{label}</div>
	{#if footnote}<div class="foot">{footnote}</div>{/if}
</div>

<style lang="scss">
	.gauge {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.25rem;
	}

	.dial {
		position: relative;
		width: 100%;
	}

	svg {
		@include fill;

		width: 100%;
		height: 100%;
	}

	circle {
		fill: none;
		stroke-width: 8;
		stroke-linecap: round;
	}

	.track {
		stroke: var(--bg-track);
	}

	.fill {
		stroke: var(--link);
		transition:
			stroke-dasharray 0.4s cubic-bezier(0.16, 1, 0.3, 1),
			stroke 0.3s ease;

		&[data-tone='success'] {
			stroke: var(--success);
		}

		&[data-tone='warning'] {
			stroke: var(--warning);
		}

		&[data-tone='danger'] {
			stroke: var(--error);
		}
	}

	// the reading sits in the dial's hole, which the 270° arc leaves open
	.read {
		@include fill;

		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 1.25rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		color: var(--text-heading);

		&[data-tone='warning'] {
			color: var(--warning);
		}

		&[data-tone='danger'] {
			color: var(--error);
		}
	}

	.cap {
		font-size: 0.8125rem;
		font-weight: 700;
		color: var(--text-heading);
		text-align: center;
	}

	.foot {
		font-size: 0.75rem;
		color: var(--text-secondary);
		text-align: center;
		font-variant-numeric: tabular-nums;
	}
</style>
