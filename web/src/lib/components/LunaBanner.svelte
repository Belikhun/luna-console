<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * The brand banner plate from `docs/console.svg`: the violet gradient, the
	 * inset second gradient, the oversized crescent and the three stars scattered
	 * across it, and the two accent squares at opposite corners.
	 *
	 * The shapes are the artwork's own path data under the artwork's own group
	 * transforms, exactly as `brands.ts` keeps the small mark: the crescent is
	 * rotated ~10°, so flattening it by hand is how the moon ends up subtly wrong.
	 * What differs from the source file is the tint. The original stacks
	 * `color-dodge` on `overlay` on a grey fill, which resolves differently in
	 * every engine; white at a low opacity is the same picture and is predictable.
	 *
	 * `viewBox` crops the plate. The artwork is 3.07:1 and a panel rarely is, so a
	 * caller frames the part of the composition it has room for rather than letting
	 * the whole thing squash.
	 */
	let {
		viewBox = '0 0 3186 1039',
		radius = 'var(--radius-container)',
		marks = true,
		children
	}: {
		viewBox?: string;
		radius?: string;
		/** the two accent squares; the artwork's signature, but noise at small sizes */
		marks?: boolean;
		/** content laid over the plate */
		children?: Snippet;
	} = $props();

	/** The big crescent, lower-left; the same glyph the mark draws, at plate scale. */
	const CRESCENT =
		'M844.012,0C377.827,0,0,377.827,0,844.011s377.827,844.012,844.012,844.012c226.828,0,432.886-89.676,584.544-235.4a79.017,79.017,0,0,0-60.993-135.833c-16.155,1.318-32.31,1.978-48.794,1.978-334.967,0-606.634-271.666-606.634-606.633,0-237.708,136.822-443.765,336.616-543.332a79.186,79.186,0,0,0-17.8-148.032A854.863,854.863,0,0,0,844.012,0Z';

	/**
	 * The three stars, largest first. Each carries the group offset the artwork
	 * places it at; the inner `translate(-17.744 278.019)` is shared, because all
	 * three are the same drawing at different scales.
	 */
	const STARS: Array<{ d: string; at: string }> = [
		{
			at: 'translate(1354.036 -204.781)',
			d: 'M474.857-267.753c-9.083,8.341-21.687,38.183-68.4,161.817-31.7,83.411-58.944,153.105-60.612,154.773s-71.363,29.1-154.959,60.8C14.244,176.733,9.054,180.255,22.215,220.292c6.673,19.833,12.6,22.614,171.27,81.742,80.816,30.214,148.656,55.978,150.7,57.276S374.023,430.672,405.9,515.2c61.909,164.041,62.28,164.968,84.337,170.9,38.554,10.38,43.559,2.41,108.99-174.421,29.843-80.631,56.163-148.286,58.573-150.7,2.224-2.224,71.733-29.472,154.217-60.427,169.046-63.207,170.529-64.133,170.529-95.644-.185-32.438,10.751-26.506-176.46-97.5C724.719,76.455,657.619,50.69,656.878,49.949c-.742-.556-27.433-70.807-59.314-156.07-54.495-145.32-58.758-155.515-70.621-163.485C509.148-281.469,488.944-280.728,474.857-267.753Z'
		},
		{
			at: 'translate(2479.479 307.948)',
			d: 'M264.847-272.47c-4.91,4.509-11.723,20.641-36.973,87.473-17.134,45.09-31.863,82.765-32.765,83.667S156.532-85.6,111.342-68.465c-95.49,36.272-98.3,38.176-91.181,59.819,3.607,10.722,6.814,12.225,92.584,44.188C156.432,51.874,193.1,65.8,194.207,66.5s16.132,38.577,33.366,84.268c33.467,88.676,33.667,89.177,45.591,92.384,20.841,5.611,23.547,1.3,58.917-94.287,16.132-43.586,30.36-80.159,31.663-81.462,1.2-1.2,38.777-15.931,83.366-32.665C538.491.573,539.292.072,539.292-16.962c-.1-17.535,5.812-14.328-95.39-52.705-43.987-16.733-80.259-30.661-80.66-31.062-.4-.3-14.83-38.276-32.064-84.368C301.72-263.652,299.416-269.163,293-273.471,283.384-279.884,272.462-279.483,264.847-272.47Z'
		},
		{
			at: 'translate(2141.053 882.953)',
			d: 'M165.524-274.7c-2.936,2.7-7.011,12.345-22.112,52.313-10.247,26.966-19.056,49.5-19.6,50.038s-23.071,9.407-50.1,19.655C16.613-131,14.935-129.864,19.189-116.92c2.157,6.412,4.075,7.311,55.37,26.426,26.127,9.768,48.059,18.1,48.718,18.517s9.648,23.071,19.955,50.4c20.015,53.033,20.134,53.332,27.265,55.25,12.464,3.356,14.082.779,35.235-56.389,9.648-26.067,18.157-47.939,18.936-48.718.719-.719,23.191-9.528,49.857-19.535,54.651-20.434,55.13-20.734,55.13-30.921-.06-10.487,3.476-8.569-57.048-31.52-26.307-10.008-48-18.337-48.239-18.577-.24-.18-8.869-22.891-19.176-50.456-17.618-46.981-19-50.276-22.831-52.853C176.61-279.134,170.078-278.9,165.524-274.7Z'
		}
	];
</script>

<div class="banner" style:border-radius={radius}>
	<svg class="plate" {viewBox} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
		<defs>
			<linearGradient id="lunaBannerA" x1="0.5" x2="0.5" y2="1" gradientUnits="objectBoundingBox">
				<stop offset="0" stop-color="var(--luna-primary)" />
				<stop offset="1" stop-color="var(--luna-deep)" />
			</linearGradient>
			<!-- the same two stops on the artwork's diagonal; written out rather than
			     xlink:href-ed, which SvelteKit's SSR output would have to escape -->
			<linearGradient
				id="lunaBannerB"
				x1="0.02"
				y1="0.072"
				x2="0.974"
				y2="0.918"
				gradientUnits="objectBoundingBox"
			>
				<stop offset="0" stop-color="var(--luna-primary)" />
				<stop offset="1" stop-color="var(--luna-deep)" />
			</linearGradient>
		</defs>

		<rect x="0" y="0" width="3186" height="1039" fill="url(#lunaBannerA)" />
		<rect x="64" y="64" width="3058" height="911" fill="url(#lunaBannerB)" />

		<g class="shapes" transform="translate(-85.332 -50)">
			<path d={CRESCENT} transform="matrix(0.985, -0.174, 0.174, 0.985, -20.4, 88.859)" />
			{#each STARS as star, index (index)}
				<g transform={star.at}>
					<path d={star.d} transform="translate(-17.744 278.019)" />
				</g>
			{/each}
		</g>
	</svg>

	{#if marks}
		<span class="mark bl"></span>
		<span class="mark tr"></span>
	{/if}

	{#if children}
		<div class="over">{@render children()}</div>
	{/if}
</div>

<style lang="scss">
	// the plate fills whatever box the caller gives it: the svg inside is absolute,
	// so without this the banner would collapse to no height at all
	.banner {
		position: relative;
		width: 100%;
		height: 100%;
		overflow: hidden;
		background: var(--luna-deep);
		isolation: isolate;
	}

	.plate {
		@include fill;

		width: 100%;
		height: 100%;
		display: block;
	}

	// the artwork overlays its shapes on the gradient rather than painting them
	// opaquely; white at this weight is that effect without nesting two blend modes
	.shapes {
		fill: #fff;
		opacity: 0.14;
		mix-blend-mode: overlay;
	}

	// the two accent squares the artwork sets at opposite corners
	.mark {
		position: absolute;
		width: 2rem;
		height: 2rem;

		&.bl {
			left: 0;
			bottom: 0;
			background: #ccacff;
		}

		&.tr {
			right: 0;
			top: 0;
			background: #ffb1fc;
		}
	}

	.over {
		position: relative;
		height: 100%;
	}
</style>
