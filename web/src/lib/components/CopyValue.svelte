<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { copyText } from '$lib/clipboard';
	import { refreshTooltip, tooltip } from '$lib/tooltip.svelte';

	import Icon from './Icon.svelte';

	/**
	 * A value with a copy affordance, in `InfoGrid`'s idiom: the button leads,
	 * the value follows, and the glyph becomes a tick in link blue for three
	 * seconds after a copy.
	 *
	 * `InfoGrid` owns this behaviour for a grid cell. This is the same contract
	 * for a value that is not in a grid; the join address in a page header, a
	 * fact in a floating panel. The rule it exists to keep is that copying looks
	 * and behaves the same everywhere in the console.
	 */
	let {
		value,
		label,
		mono = true,
		/** Render as a pill button rather than inline text */
		chip = false,
		size = 'default'
	}: {
		value: string;
		/** Names the value for the button's accessible label */
		label?: string;
		mono?: boolean;
		chip?: boolean;
		size?: 'default' | 'large';
	} = $props();

	/** matches InfoGrid: the check state lingers for three seconds */
	const COPIED_RESET_MS = 3000;

	let copied = $state(false);
	let resetTimer: ReturnType<typeof setTimeout> | undefined;

	async function copy(): Promise<void> {
		if (!(await copyText(value))) {
			return;
		}

		copied = true;
		refreshTooltip();
		clearTimeout(resetTimer);

		resetTimer = setTimeout(() => {
			copied = false;
			refreshTooltip();
		}, COPIED_RESET_MS);
	}

	const hint = $derived(() => (copied ? t('web.common.copied') : t('web.infogrid.clickToCopy')));
</script>

{#if chip}
	<button
		class="chip"
		class:large={size === 'large'}
		class:mono
		aria-label={label ? `Copy ${label}` : `Copy ${value}`}
		use:tooltip={{ content: hint }}
		onclick={copy}
	>
		<Icon
			name={copied ? 'circleCheck' : 'copy'}
			style="solid"
			size="0.875em"
			color={copied ? 'var(--link)' : undefined}
		/>
		<span>{value}</span>
	</button>
{:else}
	<span class="inline">
		<button
			class="copy"
			aria-label={label ? `Copy ${label}` : `Copy ${value}`}
			use:tooltip={{ content: hint }}
			onclick={copy}
		>
			<Icon
				name={copied ? 'circleCheck' : 'copy'}
				style="solid"
				size="0.875em"
				color={copied ? 'var(--link)' : undefined}
			/>
		</button>
		<span class="value" class:mono>{value}</span>
	</span>
{/if}

<style lang="scss">
	.inline {
		display: inline-flex;
		align-items: baseline;
		gap: 0.5rem;
		min-width: 0;
	}

	// negative margin keeps the glyph on its baseline while the padding gives the
	// icon a hit area worth aiming at; same trick as InfoGrid's
	.copy {
		@include bare-button;

		padding: 0.25rem;
		margin: -0.25rem;
		color: var(--text-secondary);
		display: inline-flex;
		flex: none;
		align-self: center;

		&:hover {
			color: var(--text-heading);
		}
	}

	.value {
		min-width: 0;
		word-break: break-word;
	}

	.mono {
		font-family: var(--font-mono);
	}

	.chip {
		@include bare-button;

		display: inline-flex;
		align-items: center;
		gap: 0.625rem;
		height: 2rem;
		padding: 0 0.875rem;
		border: var(--border-control) solid var(--border);
		border-radius: var(--radius-button);
		color: var(--text-heading);
		font-size: 0.8125rem;
		white-space: nowrap;

		&.large {
			height: 2.5rem;
			padding: 0 1.125rem;
			font-size: 0.9375rem;
		}

		&:hover {
			background: var(--bg-hover);
		}

		&:focus-visible {
			@include focus-ring;
		}
	}
</style>
