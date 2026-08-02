<script lang="ts">
	import Icon from './Icon.svelte';
	import ContextMenu from './ContextMenu.svelte';
	import { toMenuItems, type Item } from './menu';
	import type { ContextMenuItem } from './contextmenu';

	/** Button dropdown — the trigger is a pill button, the panel is the shared
	 *  ContextMenu so button menus and right-click menus match. */
	let {
		label,
		items = [],
		menu: menuItems,
		primary = false,
		disabled = false
	}: {
		label: string;
		items?: Item[];
		/** full ContextMenu model, for callers that need submenus or headers —
		 *  takes precedence over the flat `items` list */
		menu?: ContextMenuItem[];
		primary?: boolean;
		disabled?: boolean;
	} = $props();

	const resolved = $derived(menuItems ?? toMenuItems(items));

	let open = $state(false);
	let trigger: HTMLButtonElement | undefined = $state();
	let menu: ContextMenu | undefined = $state();

	async function toggle(event: MouseEvent): Promise<void> {
		event.stopPropagation();

		if (open || menu?.isOpen()) {
			menu?.close();
			open = false;

			return;
		}

		open = true;

		await menu?.openAtElement(trigger!, 'bottom', 4);
	}
</script>

<div class="dd">
	<button
		bind:this={trigger}
		class="trigger"
		class:primary
		class:open
		{disabled}
		onpointerdown={(event) => event.stopPropagation()}
		onclick={toggle}
	>
		{label}
		<span class="caret" class:flip={open}><Icon name="caretDown" size="0.75rem" /></span>
	</button>
	<ContextMenu bind:this={menu} items={resolved} onclose={() => (open = false)} />
</div>

<style lang="scss">
	.dd {
		position: relative;
		display: inline-block;
	}

	.trigger {
		display: inline-flex;
		align-items: center;
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

		&:hover,
		&.open {
			background: color-mix(in srgb, var(--link) 12%, transparent);
		}

		&:disabled {
			border-color: var(--text-disabled);
			color: var(--text-disabled);
			cursor: not-allowed;
			background: transparent;
		}

		&.primary {
			background: var(--primary);
			border-color: var(--primary);
			color: var(--primary-text);

			&:hover {
				background: var(--primary-hover);
				border-color: var(--primary-hover);
			}
		}
	}

	.caret {
		display: inline-flex;
		transition: transform 0.12s;

		&.flip {
			transform: rotate(180deg);
		}
	}
</style>
