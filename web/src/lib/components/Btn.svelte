<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';

	/**
	 * The console's button. Variants: `normal` (blue outline pill), `primary`
	 * (orange pill), `danger` (red outline), `link` (inline), `icon` (borderless)
	 * and `tool` (bordered icon-only pill, as on the refresh control).
	 *
	 * With `href` set it renders as an anchor, so navigation stays a real link.
	 */
	let {
		variant = 'normal',
		icon,
		caret = false,
		disabled = false,
		loading = false,
		href,
		title,
		type = 'button',
		onclick,
		children
	}: {
		variant?: 'normal' | 'primary' | 'danger' | 'link' | 'icon' | 'tool';
		icon?: string;
		caret?: boolean;
		disabled?: boolean;
		loading?: boolean;
		href?: string;
		title?: string;
		type?: 'button' | 'submit';
		onclick?: (event: MouseEvent) => void;
		children?: Snippet;
	} = $props();
</script>

{#if href && !disabled}
	<a class="btn {variant}" {href} {title}>
		{#if loading}<Icon name="rotate" spin />{:else if icon}<Icon name={icon} />{/if}
		{#if children}<span>{@render children()}</span>{/if}
		{#if caret}<Icon name="caretDown" size="0.75rem" />{/if}
	</a>
{:else}
	<button class="btn {variant}" disabled={disabled || loading} {title} {type} {onclick}>
		{#if loading}<Icon name="rotate" spin />{:else if icon}<Icon name={icon} />{/if}
		{#if children}<span>{@render children()}</span>{/if}
		{#if caret}<Icon name="caretDown" size="0.75rem" />{/if}
	</button>
{/if}

<style lang="scss">
	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		height: var(--control-h);
		font-family: var(--font);
		font-size: 0.875rem;
		font-weight: 700;
		line-height: 1.25rem;
		padding: 0.125rem 1rem;
		border-radius: var(--radius-button);
		border: var(--border-control) solid var(--link);
		background: transparent;
		color: var(--link);
		cursor: pointer;
		white-space: nowrap;
		user-select: none;
		text-decoration: none;
	}
	.btn:hover {
		background: color-mix(in srgb, var(--link) 12%, transparent);
		border-color: var(--link);
		color: var(--link);
		text-decoration: none;
	}

	.btn:focus-visible {
		@include focus-ring;
	}

	.btn:disabled {
		border-color: var(--text-disabled);
		color: var(--text-disabled);
		cursor: not-allowed;
		background: transparent;
	}

	.btn.primary {
		background: var(--primary);
		border-color: var(--primary);
		color: var(--primary-text);

		&:hover {
			background: var(--primary-hover);
			border-color: var(--primary-hover);
		}

		&:disabled {
			background: var(--border-divider);
			border-color: var(--border-divider);
			color: var(--text-disabled);
		}
	}

	.btn.danger {
		border-color: var(--error);
		color: var(--error);

		&:hover {
			background: color-mix(in srgb, var(--error) 12%, transparent);
			border-color: var(--error);
			color: var(--error);
		}

		// this rule follows .btn:disabled in source order, so without a nested
		// override a *disabled* danger button would still paint active red
		&:disabled {
			border-color: var(--text-disabled);
			color: var(--text-disabled);
			background: transparent;
		}
	}

	.btn.link {
		border-color: transparent;
		padding: 0.125rem 0.5rem;

		&:hover {
			background: color-mix(in srgb, var(--link) 12%, transparent);
		}
	}

	.btn.icon {
		border-color: transparent;
		color: var(--text);
		padding: 0.125rem 0.375rem;
		border-radius: 0.5rem;

		&:hover {
			color: var(--link);
			background: transparent;
		}
	}

	// bordered icon-only pill (the refresh button)
	.btn.tool {
		width: var(--control-h);
		padding: 0;
		border-radius: 50%;
	}
</style>
