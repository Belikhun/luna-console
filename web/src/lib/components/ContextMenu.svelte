<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import Icon from './Icon.svelte';
	import BrandIcon from './BrandIcon.svelte';
	import Spinner from './Spinner.svelte';
	import {
		claimMenu,
		clampMenu,
		releaseMenu,
		type ContextMenuItem,
		type MenuAnchor
	} from './contextmenu';

	/**
	 * Context menu, behaviour and motion ported from the vloom dashboard
	 * (ContextMenu in src/libs.js) in the console's colours: it fades in with a
	 * slight vertical scale, clamps itself into the viewport, supports headers,
	 * separators, nested submenus, and keeps a row spinning while an async
	 * action runs. Open it with openAt()/openAtElement() through bind:this.
	 */
	let {
		items,
		header,
		minWidth = '12rem',
		onclose
	}: {
		items: ContextMenuItem[];
		/** small title strip pinned to the top of the menu */
		header?: string;
		minWidth?: string;
		onclose?: () => void;
	} = $props();

	let mounted = $state(false);
	let shown = $state(false);
	let top = $state(0);
	let left = $state(0);
	let anchor: MenuAnchor = $state('topLeft');
	let view: HTMLDivElement | undefined = $state();
	let busy: string | null = $state(null);
	let openSub: string | null = $state(null);
	let subShown = $state(false);
	let subTop = $state(0);
	let subLeft = $state(0);
	let subView: HTMLDivElement | undefined = $state();
	let subCloseTimer: ReturnType<typeof setTimeout> | undefined;
	let closeTimer: ReturnType<typeof setTimeout> | undefined;

	const SUBMENU_CLOSE_DELAY_MS = 260;
	const CLOSE_ANIM_MS = 150;

	/** px; how far a submenu overlaps its parent row, vertically and horizontally */
	const SUB_OFFSET_Y = 8;
	const SUB_OFFSET_X = 4;

	const keyOf = (item: ContextMenuItem, index: number): string =>
		item.id ?? item.label ?? `i${index}`;

	// the handle the single-open-menu registry holds; stable for this instance's
	// lifetime, so claiming and releasing always refer to the same menu
	const handle = { close: (): void => close() };

	// a page that navigates away with a menu open must not leave the registry
	// pointing at a component that no longer exists
	onDestroy(() => releaseMenu(handle));

	export function isOpen(): boolean {
		return mounted;
	}

	/** Open at viewport coordinates (used for right-click). */
	export async function openAt(x: number, y: number, corner: MenuAnchor = 'topLeft'): Promise<void> {
		anchor = corner;
		top = y;
		left = x;

		await show();
	}

	/** Open anchored to a trigger element (used for dropdown buttons). */
	export async function openAtElement(
		target: HTMLElement,
		position: 'bottom' | 'top' | 'left' | 'right' = 'bottom',
		spacing = 4
	): Promise<void> {
		const box = target.getBoundingClientRect();

		// the anchor names which corner of the menu lands on the point below
		switch (position) {
			case 'top':
				top = box.y - spacing;
				left = box.x;
				anchor = 'bottomLeft';
				break;

			case 'left':
				top = box.y;
				left = box.x - spacing;
				anchor = 'topRight';
				break;

			case 'right':
				top = box.y;
				left = box.x + box.width + spacing;
				anchor = 'topLeft';
				break;

			default:
				top = box.y + box.height + spacing;
				left = box.x;
				anchor = 'topLeft';
		}

		await show();
	}

	async function show(): Promise<void> {
		// only one menu is open at a time; this closes whatever held the slot,
		// and its onclose resets that trigger, so no button is left looking open
		claimMenu(handle);

		// A reopen that lands inside the close animation must cancel the pending
		// unmount, or the menu is torn down again a frame after it appears and the
		// trigger is left stuck in its open state.
		clearTimeout(closeTimer);
		closeTimer = undefined;
		openSub = null;
		subShown = false;
		mounted = true;

		// measure once mounted, so clamping knows the menu's real size
		await tick();

		if (view) {
			const placed = clampMenu(top, left, view.offsetWidth, view.offsetHeight, anchor);

			top = placed.top;
			left = placed.left;
		}

		requestAnimationFrame(() => (shown = true));
	}

	export function close(): void {
		if (!mounted || closeTimer !== undefined) {
			return;
		}

		releaseMenu(handle);
		cancelSubClose();
		shown = false;
		openSub = null;
		subShown = false;

		closeTimer = setTimeout(() => {
			mounted = false;
			closeTimer = undefined;
		}, CLOSE_ANIM_MS);

		onclose?.();
	}

	async function run(
		item: ContextMenuItem,
		key: string,
		index: number,
		event: MouseEvent
	): Promise<void> {
		if (item.disabled || item.header || item.separator) {
			return;
		}

		if (item.submenu) {
			void enter(item, index, event);

			return;
		}

		const result = item.action?.();

		// an async action keeps its row spinning until it settles
		if (result instanceof Promise) {
			busy = key;

			try {
				await result;
			} finally {
				busy = null;
			}
		}

		close();
	}

	/**
	 * Opening/closing submenus on a bare mouseenter makes them impossible to
	 * reach: moving the pointer diagonally towards the submenu crosses the rows
	 * below the parent item and tears it down mid-travel. Closing is therefore
	 * deferred, and entering the submenu (or the parent item again) cancels it.
	 */
	function cancelSubClose(): void {
		if (subCloseTimer === undefined) {
			return;
		}

		clearTimeout(subCloseTimer);
		subCloseTimer = undefined;
	}

	function scheduleSubClose(): void {
		if (openSub === null || subCloseTimer !== undefined) {
			return;
		}

		subCloseTimer = setTimeout(() => {
			subCloseTimer = undefined;
			openSub = null;
			subShown = false;
		}, SUBMENU_CLOSE_DELAY_MS);
	}

	async function enter(item: ContextMenuItem, index: number, event: MouseEvent): Promise<void> {
		cancelSubClose();

		if (!item.submenu || item.disabled) {
			scheduleSubClose();

			return;
		}

		const key = keyOf(item, index);

		if (openSub === key) {
			return;
		}

		const row = (event.currentTarget as HTMLElement).getBoundingClientRect();

		openSub = key;

		// mount unshown so the submenu plays the same fade/scale as the root menu
		subShown = false;
		subTop = row.y - SUB_OFFSET_Y;
		subLeft = row.right - SUB_OFFSET_X;

		await tick();

		if (subView) {
			const placed = clampMenu(
				subTop,
				subLeft,
				subView.offsetWidth,
				subView.offsetHeight,
				'topLeft'
			);

			subTop = placed.top;
			subLeft = placed.left;
		}

		requestAnimationFrame(() => (subShown = true));
	}

	function onWindowDown(event: PointerEvent): void {
		if (!mounted) {
			return;
		}

		const target = event.target as Node;

		if (view?.contains(target) || subView?.contains(target)) {
			return;
		}

		close();
	}

	function onWindowKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			close();
		}
	}
</script>

<svelte:window
	onpointerdown={onWindowDown}
	onkeydown={onWindowKeydown}
	onresize={() => close()}
/>

{#snippet row(item: ContextMenuItem, index: number, key: string, inSub = false)}
	{#if item.separator}
		<div class="separator"></div>
	{:else if item.header}
		<div class="section">{item.label}</div>
	{:else}
		<button
			type="button"
			class="item"
			class:has-submenu={!!item.submenu}
			class:processing={busy === key}
			data-color={item.color ?? 'default'}
			disabled={item.disabled || busy !== null}
			title={item.hint ?? null}
			onmouseenter={(event) => (inSub ? cancelSubClose() : void enter(item, index, event))}
			onclick={(event) => run(item, key, index, event)}
		>
			{#if busy === key}
				<span class="ico"><Spinner size="0.875rem" /></span>
			{:else if item.brand}
				<span class="ico"><BrandIcon name={item.brand} size="0.875rem" /></span>
			{:else if item.icon}
				<span class="ico"><Icon name={item.icon} size="0.875rem" /></span>
			{/if}
			<span class="label">{item.label}</span>
			{#if item.submenu}
				<span class="arrow"><Icon name="arrowRight" size="0.75rem" /></span>
			{/if}
		</button>
	{/if}
{/snippet}

{#if mounted}
	<div
		bind:this={view}
		class="context-menu"
		class:show={shown}
		style:top="{top}px"
		style:left="{left}px"
		style:min-width={minWidth}
		role="menu"
		tabindex="-1"
		onmouseleave={scheduleSubClose}
	>
		{#if header}
			<div class="header"><span class="title">{header}</span></div>
		{/if}
		{#each items as item, i (keyOf(item, i))}
			{@render row(item, i, keyOf(item, i))}
		{/each}
	</div>

	{#each items as item, i (keyOf(item, i))}
		{#if item.submenu && openSub === keyOf(item, i)}
			<div
				bind:this={subView}
				class="context-menu sub"
				class:show={subShown}
				style:top="{subTop}px"
				style:left="{subLeft}px"
				style:min-width={minWidth}
				role="menu"
				tabindex="-1"
				onmouseenter={cancelSubClose}
				onmouseleave={scheduleSubClose}
			>
				{#each item.submenu as sub, j (keyOf(sub, j))}
					{@render row(sub, j, `${keyOf(item, i)}/${keyOf(sub, j)}`, true)}
				{/each}
			</div>
		{/if}
	{/each}
{/if}

<style lang="scss">
	.context-menu {
		position: fixed;
		display: flex;
		flex-direction: column;

		padding: 0.5rem 0;
		border: 0.1rem solid var(--border);
		border-radius: 0.5rem;
		background: color-mix(in srgb, var(--bg-dropdown) 60%, transparent);
		backdrop-filter: blur(0.5rem);

		user-select: none;
		z-index: var(--z-menu);
		overflow: hidden;

		opacity: 0;
		transform: scaleY(0.9);
		transform-origin: top center;
		box-shadow: rgba(0, 7, 22, 0.1) 0 0 0;

		transition:
			opacity 0.4s cubic-bezier(0.16, 1, 0.3, 1),
			transform 0.3s cubic-bezier(0.16, 1, 0.3, 1),
			box-shadow 0.5s cubic-bezier(0.16, 1, 0.3, 1) 0.1s;

		&.show {
			transform: none;
			opacity: 1;
			box-shadow: var(--shadow-dropdown);
		}
	}

	.header {
		background: var(--bg-panel);
		margin-top: -0.5rem;
		margin-bottom: 0.5rem;
		padding: 0.375rem 1rem;
		font-size: 0.75rem;
		border-bottom: 0.1rem solid var(--border-divider);
	}

	.header .title {
		font-weight: 700;
		color: var(--text-heading);
	}

	.section {
		font-size: 0.6875rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.03125rem;
		color: var(--text-secondary);
		padding: 0.375rem 1rem 0.25rem;
	}

	.item {
		--tint: var(--text);

		position: relative;
		display: flex;
		flex-direction: row;
		align-items: center;
		width: 100%;
		padding: 0.375rem 1rem 0.375rem 2.25rem;
		background: none;
		border: none;
		text-align: left;
		cursor: pointer;
	}
	// one tint per row drives the icon, the label and the hover wash
	.item {
		&[data-color='accent'] {
			--tint: var(--link);
		}

		&[data-color='success'] {
			--tint: var(--success);
		}

		&[data-color='warning'] {
			--tint: var(--warning);
		}

		&[data-color='danger'] {
			--tint: var(--error);
		}

		&:hover:not(:disabled) {
			background: color-mix(in srgb, var(--tint) 12%, transparent);
		}

		&.has-submenu {
			padding-right: 2rem;
		}

		&:disabled {
			opacity: 0.4;
			cursor: default;
		}

		&.processing {
			opacity: 0.6;
			cursor: default;
		}
	}

	.ico {
		position: absolute;
		top: 50%;
		left: 0.875rem;
		display: inline-flex;
		transform: translateY(-50%);
		color: var(--tint);
	}

	.arrow {
		position: absolute;
		top: 50%;
		right: 0.875rem;
		display: inline-flex;
		transform: translateY(-50%);
		color: var(--text-secondary);
	}

	.label {
		font-size: 0.875rem;
		font-weight: 400;
		line-height: 1.25rem;
		white-space: nowrap;
		color: var(--tint);
	}

	.separator {
		margin: 0.375rem 1rem;
		height: 0.1rem;
		background: var(--border-divider);
	}
</style>
