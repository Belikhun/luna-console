<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	/** Toggle switch; used for column visibility in table preferences. */
	let {
		checked = false,
		disabled = false,
		label,
		onchange
	}: {
		checked?: boolean;
		disabled?: boolean;
		/** accessible name when there is no visible text beside the switch */
		label?: string;
		onchange?: (checked: boolean) => void;
	} = $props();
</script>

<span class="tg" class:on={checked} class:disabled>
	<input
		type="checkbox"
		{checked}
		{disabled}
		aria-label={label}
		onchange={(event) => onchange?.((event.currentTarget as HTMLInputElement).checked)}
	/>
	<span class="track"><span class="knob"></span></span>
</span>

<style lang="scss">
	.tg {
		position: relative;
		display: inline-flex;
		align-items: center;
		flex: none;

		&.on {
			.track {
				background: var(--link);
			}

			.knob {
				transform: translateX(1rem);
			}
		}

		&.disabled {
			input {
				cursor: default;
			}

			.track {
				background: var(--border-divider);
			}

			.knob {
				background: var(--text-disabled);
			}
		}
	}

	// the real checkbox covers the switch and stays invisible, so it keeps the
	// native click target, keyboard handling and focus ring
	input {
		position: absolute;
		inset: 0;
		margin: 0;
		opacity: 0;
		cursor: pointer;
		z-index: 1;

		&:focus-visible ~ .track {
			outline: 0.125rem solid var(--link);
			outline-offset: 0.125rem;
		}
	}

	.track {
		display: inline-flex;
		align-items: center;
		width: 2.25rem;
		height: 1.25rem;
		padding: 0.125rem;
		border-radius: 1rem;
		background: var(--border-input);
		transition: background-color 0.15s ease-out;
	}

	.knob {
		width: 1rem;
		height: 1rem;
		border-radius: 50%;
		background: var(--bg-nav);
		transition: transform 0.15s cubic-bezier(0.16, 1, 0.3, 1);
	}
</style>
