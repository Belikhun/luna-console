<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { tooltip } from '$lib/tooltip.svelte';
	import type { SegmentOption } from './segmented';

	/**
	 * A choice between a few views of the same thing, shown as joined segments
	 * with the chosen one lit. `role` says what the choice is: `radiogroup` for
	 * a setting (a layout), `tablist` for panes it switches between (the
	 * codespace's Files/Changes, the workbench's tabs). Either way it is one tab
	 * stop; arrow keys move the choice, Home and End jump to the ends.
	 *
	 * `compact` shows icons alone (the label moves to the tooltip and stays the
	 * accessible name), for a bar that runs short of room.
	 */
	let {
		options,
		value,
		label,
		size = 'normal',
		role = 'radiogroup',
		fill = false,
		compact = false,
		onchange
	}: {
		options: SegmentOption[];
		value: string;
		/** What is being chosen, for screen readers */
		label: string;
		/** `small` sits in a pane's own bar */
		size?: 'normal' | 'small';
		role?: 'radiogroup' | 'tablist';
		/** Stretch across the container, the segments sharing it evenly */
		fill?: boolean;
		compact?: boolean;
		onchange: (id: string) => void;
	} = $props();

	const tabs = $derived(role === 'tablist');

	let group: HTMLDivElement | undefined = $state();

	function pick(id: string): void {
		if (id !== value) {
			onchange(id);
		}
	}

	function onKeydown(event: KeyboardEvent): void {
		const enabled = options.filter((option) => !option.disabled);
		const index = enabled.findIndex((option) => option.id === value);
		let next = -1;

		if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
			next = (index + 1) % enabled.length;
		} else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
			next = (index - 1 + enabled.length) % enabled.length;
		} else if (event.key === 'Home') {
			next = 0;
		} else if (event.key === 'End') {
			next = enabled.length - 1;
		}

		const target = enabled[next];

		if (next < 0 || !target) {
			return;
		}

		event.preventDefault();
		pick(target.id);

		// the lit segment takes the focus with it, as a radio group's does
		requestAnimationFrame(() => {
			group?.querySelector<HTMLButtonElement>(`[data-id="${target.id}"]`)?.focus();
		});
	}
</script>

<div
	class="seg"
	class:small={size === 'small'}
	class:fill
	class:compact
	{role}
	aria-label={label}
	tabindex="-1"
	bind:this={group}
	onkeydown={onKeydown}
>
	{#each options as option (option.id)}
		{@const on = option.id === value}
		<button
			type="button"
			role={tabs ? 'tab' : 'radio'}
			data-id={option.id}
			aria-checked={tabs ? undefined : on}
			aria-selected={tabs ? on : undefined}
			aria-label={compact ? option.label : undefined}
			tabindex={on ? 0 : -1}
			class:on
			disabled={option.disabled}
			use:tooltip={{ content: compact && option.hint ? `${option.label}: ${option.hint}` : compact ? option.label : option.hint ?? '' }}
			onclick={() => pick(option.id)}
		>
			{#if option.icon}
				<icon data-icon={option.icon}></icon>
			{/if}
			{#if !compact}
				<span class="label">{option.label}</span>
			{/if}
			{#if option.badge}
				<span class="badge">{option.badge}</span>
			{/if}
		</button>
	{/each}
</div>

<style lang="scss">
	.seg {
		display: inline-flex;
		align-items: center;
		gap: 0.125rem;
		height: var(--control-h);
		padding: 0.125rem;
		border: var(--hairline) solid var(--border-input);
		border-radius: var(--radius-input);
		background: var(--bg-input);

		&:focus {
			outline: none;
		}

		button {
			@include bare-button;

			display: inline-flex;
			align-items: center;
			gap: 0.5rem;
			height: 100%;
			padding: 0 0.75rem;
			border-radius: calc(var(--radius-input) - 0.125rem);
			color: var(--text-secondary);
			font-size: 0.875rem;
			font-weight: 700;
			white-space: nowrap;
			cursor: pointer;

			&:hover:not(:disabled) {
				background: var(--bg-hover);
				color: var(--text);
			}

			&.on {
				background: var(--bg-selected);
				color: var(--link);
			}

			&:disabled {
				opacity: 0.5;
				cursor: not-allowed;
			}

			&:focus-visible {
				@include focus-ring;
			}
		}

		&.fill {
			display: flex;
			width: 100%;

			button {
				flex: 1;
				justify-content: center;
			}
		}

		&.compact button {
			padding: 0 0.625rem;
		}

		&.small {
			height: 2rem;

			button {
				gap: 0.375rem;
				padding: 0 0.625rem;
				font-size: 0.75rem;
			}
		}
	}

	.badge {
		min-width: 1.25rem;
		padding: 0 0.375rem;
		border-radius: 0.625rem;
		background: var(--bg-hover);
		color: var(--text);
		font-size: 0.75rem;
		text-align: center;
	}
</style>
