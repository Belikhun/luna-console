<script lang="ts">
	import BrandIcon from './BrandIcon.svelte';
	import { LUNA_PLATE_MARK } from './brands';

	/**
	 * Luna's logo: the crescent-and-stars mark on its brand gradient plate — the
	 * favicon composition, so the browser tab, the top bar and (later) the login
	 * panel are recognisably one thing.
	 *
	 * The plate is what carries the brand violet. The mark alone is a white glyph
	 * and would read as a generic moon icon, and the violet cannot be the glyph's
	 * own colour on these dark panels without being lifted past the brand value.
	 *
	 * It draws the *ringless* variant on purpose: the plate is that circle, so the
	 * artwork's ring would be a second one a hairline inside its edge. The ringed
	 * mark is what a source cell shows, where there is no plate to stand in for it.
	 */
	let {
		size = '1.5rem',
		glyph = '1rem',
		round = true
	}: {
		/** the plate */
		size?: string;
		/** the mark inside it — roughly ⅔ of the plate, as in the artwork */
		glyph?: string;
		/** a circle, as the favicon; false gives the rounded square of the app icon */
		round?: boolean;
	} = $props();
</script>

<span class="lunamark" class:round style:width={size} style:height={size}>
	<BrandIcon mark={LUNA_PLATE_MARK} size={glyph} />
</span>

<style lang="scss">
	.lunamark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
		color: #fff;
		background: var(--luna-gradient);
		border-radius: var(--radius-input);

		&.round {
			border-radius: 50%;
		}
	}
</style>
