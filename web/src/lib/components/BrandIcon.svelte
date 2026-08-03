<script lang="ts">
	import { BRAND_MARKS } from './brands';

	/**
	 * A provider's own logo, drawn from the inlined marks in `brands.ts` and
	 * tinted with `currentColor` so it behaves like the Font Awesome glyphs it
	 * sits beside — including when a row is disabled or greyed.
	 *
	 * An unknown name renders nothing rather than a broken box: the providers
	 * list is data, and a new one may arrive before its mark does.
	 */
	let { name, size = '1em' }: { name: string; size?: string } = $props();

	const mark = $derived(BRAND_MARKS[name]);
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
			{#each mark.paths as path, index (index)}
				<path d={path} />
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
