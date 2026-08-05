<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import Icon from './Icon.svelte';
	import ContextMenu from './ContextMenu.svelte';
	import type { ContextMenuItem } from './contextmenu';

	/**
	 * Split button: one pill whose left half runs the default action and whose
	 * right half opens a menu of the alternatives. Use it where one verb is the
	 * obvious one and the others are variants of it (install → upload a file,
	 * or fetch it from a provider); a plain Dropdown would hide the common
	 * case behind a click.
	 */
	let {
		label,
		icon,
		menu,
		primary = false,
		disabled = false,
		loading = false,
		title,
		onclick
	}: {
		label: string;
		icon?: string;
		/** the alternatives, shown under the caret */
		menu: ContextMenuItem[];
		primary?: boolean;
		disabled?: boolean;
		loading?: boolean;
		title?: string;
		/** the default action; the left half */
		onclick: () => void;
	} = $props();

	let open = $state(false);
	let caret: HTMLButtonElement | undefined = $state();
	let panel: ContextMenu | undefined = $state();

	async function toggle(event: MouseEvent): Promise<void> {
		event.stopPropagation();

		if (open || panel?.isOpen()) {
			panel?.close();
			open = false;

			return;
		}

		open = true;

		await panel?.openAtElement(caret!, 'bottom', 4);
	}
</script>

<div class="split" class:primary class:disabled>
	<button class="main" {disabled} {title} onclick={onclick}>
		{#if loading}
			<Icon name="rotate" spin />
		{:else if icon}
			<Icon name={icon} />
		{/if}
		<span>{label}</span>
	</button>
	<span class="rule"></span>
	<button
		bind:this={caret}
		class="more"
		class:open
		{disabled}
		aria-label={t('web.splitBtn.moreOptions', { label })}
		onpointerdown={(event) => event.stopPropagation()}
		onclick={toggle}
	>
		<span class="chev" class:flip={open}><Icon name="caretDown" size="0.75rem" /></span>
	</button>
	<ContextMenu bind:this={panel} items={menu} onclose={() => (open = false)} />
</div>

<style lang="scss">
	// the two halves share one border and one radius, so the control reads as a
	// single button with a seam rather than two buttons side by side
	.split {
		position: relative;
		display: inline-flex;
		align-items: stretch;
		height: var(--control-h);
		border: var(--border-control) solid var(--link);
		border-radius: var(--radius-button);
		background: transparent;
		color: var(--link);
		overflow: hidden;
	}

	button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		border: none;
		background: transparent;
		color: inherit;
		font-family: var(--font);
		font-size: 0.875rem;
		font-weight: 700;
		line-height: 1.25rem;
		cursor: pointer;
		white-space: nowrap;

		&:disabled {
			cursor: not-allowed;
		}

		&:focus-visible {
			@include focus-ring;

			// the ring would be clipped by the wrapper's overflow, so it is drawn
			// inside the seam instead
			outline-offset: -0.125rem;
		}
	}

	.main {
		padding: 0 0.875rem;
	}

	.more {
		padding: 0 0.5rem;
	}

	.chev {
		display: inline-flex;
		transition: transform 0.12s;

		&.flip {
			transform: rotate(180deg);
		}
	}

	// the seam: a hairline in the border's own colour
	.rule {
		width: var(--hairline);
		background: var(--link);
		flex: none;
	}

	.split:not(.disabled) button:hover,
	.split:not(.disabled) .more.open {
		background: color-mix(in srgb, var(--link) 12%, transparent);
	}

	.split.primary {
		background: var(--primary);
		border-color: var(--primary);
		color: var(--primary-text);

		.rule {
			background: color-mix(in srgb, var(--primary-text) 25%, transparent);
		}

		&:not(.disabled) button:hover,
		&:not(.disabled) .more.open {
			background: var(--primary-hover);
		}
	}

	.split.disabled {
		border-color: var(--text-disabled);
		color: var(--text-disabled);

		.rule {
			background: var(--text-disabled);
		}

		&.primary {
			background: var(--border-divider);
			border-color: var(--border-divider);
		}
	}
</style>
