<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { t } from '$lib/i18n.svelte';
	import Icon from './Icon.svelte';

	let {
		title,
		open = $bindable(),
		wide = false,
		dismissable = true,
		children,
		footer
	}: {
		title: string;
		open: boolean;
		wide?: boolean;
		/**
		 * Whether Escape, the backdrop and the close button dismiss the dialog.
		 *
		 * False while the dialog owns work a stray click must not abandon - an
		 * upload in flight, a step whose answer the caller is about to act on.
		 * The caller then provides its own way out.
		 */
		dismissable?: boolean;
		children: Snippet;
		footer?: Snippet;
	} = $props();

	function onKeydown(event: KeyboardEvent): void {
		// a child control (an open Select list) may have claimed this Escape
		if (event.key === 'Escape' && !event.defaultPrevented && dismissable) {
			open = false;
		}
	}

	/** Only a click on the backdrop itself dismisses; not one inside the dialog. */
	function onOverlayClick(event: MouseEvent): void {
		if (event.target === event.currentTarget && dismissable) {
			open = false;
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
	<div class="overlay" onclick={onOverlayClick} role="presentation">
		<div class="modal" class:wide role="dialog" aria-label={title}>
			<div class="hd">
				<h2>{title}</h2>
				{#if dismissable}
					<button class="x" onclick={() => (open = false)} aria-label={t('web.common.close')}>
						<Icon name="close" size="0.875rem" />
					</button>
				{/if}
			</div>
			<div class="bd">{@render children()}</div>
			{#if footer}
				<div class="ft">{@render footer()}</div>
			{/if}
		</div>
	</div>
{/if}

<style lang="scss">
	.overlay {
		position: fixed;
		inset: 0;
		background: rgba(4, 9, 16, 0.7);
		z-index: var(--z-modal);
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding-top: 10vh;
	}
	.modal {
		background: var(--bg-panel);
		border: 0.1rem solid var(--border-divider);
		border-radius: var(--radius-container);
		width: min(36.25rem, 92vw);
		max-height: 76vh;
		display: flex;
		flex-direction: column;
		box-shadow: var(--shadow-dropdown);
		animation: fadein 0.12s ease-out;
	}
	.modal.wide {
		width: min(53.75rem, 94vw);
	}

	.hd {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.875rem 1.25rem;
		border-bottom: 0.1rem solid var(--border-divider);
	}

	.bd {
		padding: 1rem 1.25rem;
		overflow-y: auto;

		// Flash is built for the page-top flashbar, so it carries a trailing
		// margin and no leading one. Mid-body that reads as the warning being
		// glued to the line above it and floating away from the line below;
		// the direct-child selector leaves a Flash nested in some other
		// component's own layout alone
		> :global(.flash) {
			margin-top: 0.75rem;
		}

		// the body's padding is the whole gap at either edge: a child's own
		// margin must not add to it. These come after the rule above on
		// purpose; equal specificity, so source order is what lets a leading
		// Flash still sit flush against the header
		> :global(:first-child) {
			margin-top: 0;
		}

		> :global(:last-child) {
			margin-bottom: 0;
		}
	}

	.ft {
		padding: 0.75rem 1.25rem;
		border-top: 0.1rem solid var(--border-divider);
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}

	.x {
		@include bare-button;

		color: var(--text-secondary);
		padding: 0.25rem;

		&:hover {
			color: var(--text-heading);
		}
	}
</style>
