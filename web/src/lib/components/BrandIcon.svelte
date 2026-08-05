<script lang="ts">
	import { BRAND_MARKS, type BrandMark, type BrandPath } from './brands';

	/**
	 * A provider's own logo, drawn from the inlined marks in `brands.ts` and
	 * tinted with `currentColor` so it behaves like the Font Awesome glyphs it
	 * sits beside; including when a row is disabled or greyed.
	 *
	 * An unknown name renders nothing rather than a broken box: the providers
	 * list is data, and a new one may arrive before its mark does.
	 */
	let {
		name,
		mark: given,
		size = '1em'
	}: {
		/** a key of `BRAND_MARKS`; how a source names its mark */
		name?: string;
		/** a mark that is not in the registry, e.g. a variant of one that is */
		mark?: BrandMark;
		size?: string;
	} = $props();

	const mark = $derived(given ?? BRAND_MARKS[name ?? '']);

	// a mark may give a shape as bare path data or as data plus its own placing
	const shapes: BrandPath[] = $derived(
		(mark?.paths ?? []).map((path) => (typeof path === 'string' ? { d: path } : path))
	);
</script>

{#if mark}
	<svg
		class="brand"
		viewBox={mark.viewBox}
		width={size}
		height={size}
		fill="currentColor"
		aria-hidden="true"
		focusable="false"
	>
		<g transform={mark.transform}>
			{#each shapes as shape, index (index)}
				<path d={shape.d} transform={shape.transform} />
			{/each}
		</g>
	</svg>
{/if}

<style lang="scss">
	// same optical alignment the icon element gets in app.scss, so a brand mark
	// and a glyph sit on one line
	.brand {
		display: inline-block;
		vertical-align: -0.125em;
		flex: none;
	}
</style>
