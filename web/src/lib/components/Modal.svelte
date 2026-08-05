<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';

	let {
		title,
		open = $bindable(),
		wide = false,
		children,
		footer
	}: {
		title: string;
		open: boolean;
		wide?: boolean;
		children: Snippet;
		footer?: Snippet;
	} = $props();

	function onKeydown(event: KeyboardEvent): void {
		// a child control (an open Select list) may have claimed this Escape
		if (event.key === 'Escape' && !event.defaultPrevented) {
			open = false;
		}
	}

	/** Only a click on the backdrop itself dismisses; not one inside the dialog. */
	function onOverlayClick(event: MouseEvent): void {
		if (event.target === event.currentTarget) {
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
				<button class="x" onclick={() => (open = false)} aria-label="Close">
					<Icon name="close" size="0.875rem" />
				</button>
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
