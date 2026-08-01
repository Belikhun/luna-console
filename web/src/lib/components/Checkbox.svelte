<script lang="ts">
	/**
	 * Checkbox: a 1rem square with a 0.125rem outline, filled with
	 * the accent colour when checked. The native input stays in the DOM (opacity
	 * 0, stretched over the box) so keyboard focus, labels and a11y behave
	 * natively, and the glyph is drawn as SVG so it stays crisp at any zoom.
	 */
	let {
		checked = false,
		indeterminate = false,
		disabled = false,
		label,
		onchange
	}: {
		checked?: boolean;
		indeterminate?: boolean;
		disabled?: boolean;
		/** accessible name — required when the checkbox has no visible text */
		label?: string;
		onchange?: (checked: boolean, event: Event) => void;
	} = $props();

	// the checkbox is often inside a clickable table row, which must not also fire
	function handle(event: Event): void {
		event.stopPropagation();
		onchange?.((event.currentTarget as HTMLInputElement).checked, event);
	}
</script>

<span class="cb" class:checked={checked || indeterminate} class:disabled>
	<input
		type="checkbox"
		{checked}
		{disabled}
		indeterminate={indeterminate}
		aria-label={label}
		onclick={(event) => event.stopPropagation()}
		onchange={handle}
	/>
	<svg viewBox="0 0 16 16" aria-hidden="true">
		<rect class="box" x="1" y="1" width="14" height="14" rx="2" />
		{#if indeterminate}
			<path class="glyph" d="M4.5 8h7" />
		{:else if checked}
			<path class="glyph" d="M4 8.4l2.6 2.7L12 5.6" />
		{/if}
	</svg>
</span>

<style lang="scss">
	.cb {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1rem;
		height: 1rem;
		flex: none;
		vertical-align: middle;

		// the input overhangs the box by 0.25rem on every side, so the hit area is
		// comfortable without the drawn square growing
		input {
			position: absolute;
			inset: -0.25rem;
			width: auto;
			height: auto;
			margin: 0;
			opacity: 0;
			cursor: pointer;
			z-index: 1;

			&:focus-visible ~ svg {
				outline: 0.125rem solid var(--link);
				outline-offset: 0.125rem;
				border-radius: 0.25rem;

				.box {
					stroke: var(--link);
				}
			}
		}

		&.checked .box {
			fill: var(--link);
			stroke: var(--link);
		}

		&:hover:not(.disabled) .box {
			stroke: var(--link);
		}

		&.disabled {
			input {
				cursor: default;
			}

			.box {
				stroke: var(--text-disabled);
			}

			&.checked .box {
				fill: var(--text-disabled);
				stroke: var(--text-disabled);
			}
		}
	}

	svg {
		width: 1rem;
		height: 1rem;
		display: block;
	}

	.box {
		fill: transparent;
		stroke: var(--border-input);
		stroke-width: 2;
		transition:
			fill 0.1s ease-out,
			stroke 0.1s ease-out;
	}

	.glyph {
		fill: none;
		stroke: var(--bg-nav);
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
</style>
