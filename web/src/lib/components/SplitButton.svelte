<script lang="ts">
	import Icon from './Icon.svelte';
	import ContextMenu from './ContextMenu.svelte';
	import { toMenuItems, type Item } from './menu';

	/** Split button: primary action + attached caret segment with a menu
	 *  (as in "Launch instance ▾"). */
	let {
		label,
		primary = true,
		disabled = false,
		loading = false,
		onclick,
		items
	}: {
		label: string;
		primary?: boolean;
		disabled?: boolean;
		loading?: boolean;
		onclick: () => void;
		items: Item[];
	} = $props();

	let open = $state(false);
	let caretEl: HTMLButtonElement | undefined = $state();
	let menu: ContextMenu | undefined = $state();

	/**
	 * The caret swallows its own pointerdown so the menu's outside-click handler
	 * never sees it; without that the menu would close on press and reopen on
	 * click, which reads as a flicker and desynchronises `open`.
	 */
	async function toggle(event: MouseEvent): Promise<void> {
		event.stopPropagation();

		if (open || menu?.isOpen()) {
			menu?.close();
			open = false;

			return;
		}

		open = true;

		await menu?.openAtElement(caretEl!, 'bottom', 4);
	}
</script>

<div class="split" class:primary>
	<button class="main" disabled={disabled || loading} {onclick}>
		{#if loading}<Icon name="rotate" spin />{/if}
		{label}
	</button>
	<span class="sep"></span>
	<button
		bind:this={caretEl}
		class="caret"
		class:open
		disabled={disabled || loading}
		aria-label="More options"
		onpointerdown={(event) => event.stopPropagation()}
		onclick={toggle}
	>
		<Icon name="caretDown" size="0.75rem" />
	</button>
	<ContextMenu bind:this={menu} items={toMenuItems(items)} onclose={() => (open = false)} />
</div>

<style lang="scss">
	.split {
		position: relative;
		display: inline-flex;
		align-items: stretch;
		height: var(--control-h);
	}
	.main,
	.caret {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-family: var(--font);
		font-size: 0.875rem;
		font-weight: 700;
		line-height: 1.25rem;
		border: var(--border-control) solid var(--link);
		background: transparent;
		color: var(--link);
		cursor: pointer;
		white-space: nowrap;
	}

	// the two halves share one pill outline: outer corners rounded, inner edge
	// borderless, and the .sep rule below draws the divider between them
	.main {
		padding: 0.125rem 0.875rem 0.125rem 1rem;
		border-radius: var(--radius-button) 0 0 var(--radius-button);
		border-right: none;
	}

	.caret {
		padding: 0.125rem 0.625rem;
		border-radius: 0 var(--radius-button) var(--radius-button) 0;
		border-left: none;
	}

	.main:hover:not(:disabled),
	.caret:hover:not(:disabled),
	.caret.open {
		background: color-mix(in srgb, var(--link) 12%, transparent);
	}

	.main:disabled,
	.caret:disabled {
		border-color: var(--text-disabled);
		color: var(--text-disabled);
		cursor: not-allowed;
	}

	.sep {
		width: 0.1rem;
		background: var(--link);
		z-index: 1;
	}

	.split:has(.main:disabled) .sep {
		background: var(--text-disabled);
	}

	.split.primary {
		.main,
		.caret {
			background: var(--primary);
			border-color: var(--primary);
			color: var(--primary-text);
		}

		.main:hover:not(:disabled),
		.caret:hover:not(:disabled),
		.caret.open {
			background: var(--primary-hover);
			border-color: var(--primary-hover);
		}

		.sep {
			background: rgba(15, 20, 26, 0.4);
		}

		.main:disabled,
		.caret:disabled {
			background: var(--border-divider);
			border-color: var(--border-divider);
			color: var(--text-disabled);
		}
	}
</style>
