<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import BrandIcon from './BrandIcon.svelte';
	import { LUNA_PLATE_MARK } from './brands';

	/**
	 * Luna's logo: the crescent-and-stars mark on its brand gradient plate; the
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
		glyph,
		round = true
	}: {
		/** the plate */
		size?: string;
		/** the mark inside it; defaults to the ⅔ the artwork draws it at */
		glyph?: string;
		/** a circle, as the favicon; false gives the rounded square of the app icon */
		round?: boolean;
	} = $props();

	// derived from the plate rather than defaulting to a fixed length: `size` is a
	// CSS length in whatever unit the caller had, so the proportion is arithmetic
	// the browser does. A constant default is how a 3rem plate ends up carrying a
	// 1rem glyph swimming in the middle of it.
	const inner = $derived(glyph ?? `calc(${size} * 0.667)`);
</script>

<span class="lunamark" class:round style:width={size} style:height={size}>
	<BrandIcon mark={LUNA_PLATE_MARK} size={inner} />
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
