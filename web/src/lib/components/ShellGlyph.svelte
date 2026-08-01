<script lang="ts">
	/**
	 * The terminal's mark: a rounded square holding a prompt chevron and cursor
	 * rule. Drawn inline because the Font Awesome integration has no
	 * square-terminal glyph.
	 */
	let { size = '1rem' }: { size?: string } = $props();
</script>

<svg class="sg" viewBox="0 0 16 16" style:width={size} style:height={size} aria-hidden="true">
	<rect x="1" y="2" width="14" height="12" rx="2" />
	<path d="M4.5 6.25L6.5 8l-2 1.75" />
	<path d="M8.25 10.25H11.5" />
</svg>

<style lang="scss">
	.sg {
		display: block;
		flex: none;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.4;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
</style>
