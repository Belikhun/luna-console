<script lang="ts">
	/**
	 * Material-style indeterminate spinner: the whole ring rotates linearly
	 * while the arc sweeps between short and long with an eased dash animation —
	 * the two frequencies beat against each other, so the head and tail chase
	 * around the circle instead of the ring just spinning in place.
	 */
	let {
		size = '1rem',
		width = 2.5,
		color = 'currentColor'
	}: { size?: string; width?: number; color?: string } = $props();
</script>

<svg
	class="sp"
	viewBox="0 0 24 24"
	style:width={size}
	style:height={size}
	style:color
	aria-hidden="true"
>
	<circle class="arc" cx="12" cy="12" r="9.5" stroke-width={width} />
</svg>

<style lang="scss">
	.sp {
		display: block;
		flex: none;
		animation: sp-rotate 1.6s linear infinite;
	}

	.arc {
		fill: none;
		stroke: currentColor;
		stroke-linecap: round;

		// r=9.5 → circumference ≈ 59.7, which is what the dash lengths below assume
		animation: sp-dash 1.4s ease-in-out infinite;
	}

	@keyframes sp-rotate {
		to {
			transform: rotate(360deg);
		}
	}

	@keyframes sp-dash {
		0% {
			stroke-dasharray: 1, 59;
			stroke-dashoffset: 0;
		}
		50% {
			stroke-dasharray: 42, 59;
			stroke-dashoffset: -16;
		}
		100% {
			stroke-dasharray: 42, 59;
			stroke-dashoffset: -58;
		}
	}
</style>
