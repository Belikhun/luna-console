<script lang="ts">
	/**
	 * Checkbox: a 1rem square with a 0.125rem outline, filled with
	 * the accent colour when checked. The native input stays in the DOM (opacity
	 * 0, stretched over the box) so keyboard focus, labels and a11y behave
	 * natively, and the glyph is drawn as SVG so it stays crisp at any zoom.
	 *
	 * `shape="radio"` draws the same control as a circle with a dot and switches
	 * the native input to a radio. The shape is a promise about how many things
	 * can be picked, so a one-at-a-time chooser must not wear a square.
	 */
	let {
		checked = false,
		indeterminate = false,
		disabled = false,
		shape = 'check',
		label,
		onchange
	}: {
		checked?: boolean;
		indeterminate?: boolean;
		disabled?: boolean;
		/** square + tick for "any number of these", circle + dot for "exactly one" */
		shape?: 'check' | 'radio';
		/** accessible name; required when the checkbox has no visible text */
		label?: string;
		onchange?: (checked: boolean, event: Event) => void;
	} = $props();

	// the checkbox is often inside a clickable table row, which must not also fire
	function handle(event: Event): void {
		event.stopPropagation();
		onchange?.((event.currentTarget as HTMLInputElement).checked, event);
	}
</script>

<span
	class="cb"
	class:checked={checked || indeterminate}
	class:disabled
	class:radio={shape === 'radio'}
>
	<input
		type={shape === 'radio' ? 'radio' : 'checkbox'}
		{checked}
		{disabled}
		indeterminate={shape === 'check' && indeterminate}
		aria-label={label}
		onclick={(event) => event.stopPropagation()}
		onchange={handle}
	/>
	<svg viewBox="0 0 16 16" aria-hidden="true">
		{#if shape === 'radio'}
			<circle class="box" cx="8" cy="8" r="7" />
			{#if checked}
				<circle class="dot" cx="8" cy="8" r="3" />
			{/if}
		{:else}
			<rect class="box" x="1" y="1" width="14" height="14" rx="2" />
			{#if indeterminate}
				<path class="glyph" d="M4.5 8h7" />
			{:else if checked}
				<path class="glyph" d="M4 8.4l2.6 2.7L12 5.6" />
			{/if}
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

	.dot {
		fill: var(--link);
		stroke: none;
	}

	// A radio's ring stays hollow and the dot inside carries the state, where a
	// checkbox fills its square and cuts the tick out of it. Overrides the shared
	// `.checked`/`.disabled` fills above, so it has to come after them.
	.cb.radio {
		&.checked .box {
			fill: transparent;
			stroke: var(--link);
		}

		input:focus-visible ~ svg {
			border-radius: 50%;
		}

		&.disabled {
			.dot {
				fill: var(--text-disabled);
			}

			&.checked .box {
				fill: transparent;
				stroke: var(--text-disabled);
			}
		}
	}
</style>
