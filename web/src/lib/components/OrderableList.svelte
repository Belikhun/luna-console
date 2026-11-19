<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';
	import { onMount, tick } from 'svelte';
	import { t } from '$lib/i18n.svelte';
	import { tooltip } from '$lib/tooltip.svelte';
	import Icon from './Icon.svelte';

	/**
	 * A vertical list the user reorders by dragging. The picked-up row follows
	 * the pointer, the rows it passes slide aside, and a slot marks where it
	 * will land; nothing changes until it is dropped (Escape puts it back).
	 * With `handle` (the default) only the grip starts a drag, so the row's own
	 * buttons and switches keep working; without it the whole row is the grip,
	 * except its interactive controls. The grip is also a keyboard control:
	 * the arrow keys move the row one step, Home and End to either end.
	 */
	let {
		items = $bindable(),
		key,
		label,
		handle = true,
		disabled = false,
		class: className = '',
		onreorder,
		item
	}: {
		items: T[];
		/** A stable identity for each item, for keyed rendering. */
		key: (item: T) => string | number;
		/** The item's name, for the grip's accessible label and the announcements. */
		label?: (item: T) => string;
		/** Drag by the grip only; false makes the whole row draggable. */
		handle?: boolean;
		disabled?: boolean;
		class?: string;
		/** Called after a move with the new order; `items` is updated as well. */
		onreorder?: (items: T[], from: number, to: number) => void;
		/** Renders one row's content, after the grip. */
		item: Snippet<[T, number]>;
	} = $props();

	/** px the pointer travels before a press becomes a drag, so clicks stay clicks */
	const THRESHOLD = 4;
	/** px from a scroll container's edge where dragging starts to scroll it */
	const EDGE = 40;
	/** px per frame at the very edge */
	const SCROLL_SPEED = 14;

	const INTERACTIVE = "button, a[href], input, select, textarea, label, [contenteditable], [role='button'], [role='switch'], [role='checkbox']";

	let listEl: HTMLDivElement | null = $state(null);

	// a press that may still become a drag
	let pressIndex = -1;
	let pressY = 0;

	let dragging = $state(false);
	let from = $state(-1);
	let to = $state(-1);
	let offset = $state(0);
	let stride = $state(0);
	let slotTop = $state(0);
	let slotHeight = $state(0);
	let announcement = $state('');

	// row geometry at drag start, in list coordinates, before anything moved
	let tops: number[] = [];
	let heights: number[] = [];

	let pointerY = 0;
	let scroller: HTMLElement | null = null;
	let frame: number | null = null;

	function nameOf(entry: T): string {
		return label?.(entry) ?? '';
	}

	function listTop(): number {
		return listEl?.getBoundingClientRect().top ?? 0;
	}

	function rowElements(): HTMLElement[] {
		return listEl
			? Array.from(listEl.children as HTMLCollectionOf<HTMLElement>).filter((child) => child.classList.contains('row'))
			: [];
	}

	function scrollParent(node: HTMLElement): HTMLElement | null {
		for (let parent = node.parentElement; parent; parent = parent.parentElement) {
			const overflow = getComputedStyle(parent).overflowY;

			if ((overflow === 'auto' || overflow === 'scroll') && parent.scrollHeight > parent.clientHeight) {
				return parent;
			}
		}

		return null;
	}

	function pointerDown(index: number, event: PointerEvent): void {
		if (disabled || items.length < 2 || event.button !== 0 || !event.isPrimary) {
			return;
		}

		// the whole row is the grip, but its own controls still take their clicks
		if (!handle && (event.target as Element).closest(INTERACTIVE) && !(event.target as Element).closest('.handle')) {
			return;
		}

		pressIndex = index;
		pressY = event.clientY - listTop();
		pointerY = event.clientY;

		window.addEventListener('pointermove', pointerMove);
		window.addEventListener('pointerup', pointerUp);
		window.addEventListener('pointercancel', cancel);
		window.addEventListener('keydown', escape, true);
	}

	function begin(): void {
		const rows = rowElements();
		const base = listTop();

		tops = rows.map((row) => row.getBoundingClientRect().top - base);
		heights = rows.map((row) => row.getBoundingClientRect().height);

		from = pressIndex;
		to = pressIndex;
		slotHeight = heights[from] ?? 0;
		slotTop = tops[from] ?? 0;

		// the distance the neighbours slide: the row plus the space after it
		stride = from < tops.length - 1
			? (tops[from + 1] ?? 0) - (tops[from] ?? 0)
			: (tops[from] ?? 0) - (tops[from - 1] ?? 0) - (heights[from - 1] ?? 0) + slotHeight;

		scroller = listEl ? scrollParent(listEl) : null;
		dragging = true;
		window.getSelection()?.removeAllRanges();
		frame = requestAnimationFrame(autoScroll);
	}

	function update(): void {
		const last = tops.length - 1;
		const bottom = (tops[last] ?? 0) + (heights[last] ?? 0);
		const start = tops[from] ?? 0;
		const height = heights[from] ?? 0;

		// the row stays inside the list, however far the pointer goes; held
		// against an end, its centre sits exactly on the last row's middle,
		// which is why reaching a middle (not passing it) counts
		offset = Math.min(Math.max(pointerY - listTop() - pressY, -start), bottom - start - height);

		const center = start + offset + height / 2;
		let target = from;

		for (let index = from + 1; index <= last; index++) {
			if (center >= (tops[index] ?? 0) + (heights[index] ?? 0) / 2) {
				target = index;
			}
		}

		for (let index = from - 1; index >= 0; index--) {
			if (center <= (tops[index] ?? 0) + (heights[index] ?? 0) / 2) {
				target = index;
			}
		}

		to = target;
		slotTop = to > from
			? (tops[to] ?? 0) + (heights[to] ?? 0) - height
			: tops[to] ?? 0;
	}

	function pointerMove(event: PointerEvent): void {
		pointerY = event.clientY;

		if (!dragging) {
			if (Math.abs(event.clientY - listTop() - pressY) < THRESHOLD) {
				return;
			}

			begin();
		}

		event.preventDefault();
		update();
	}

	function autoScroll(): void {
		if (!dragging) {
			return;
		}

		if (scroller) {
			const box = scroller.getBoundingClientRect();
			let step = 0;

			if (pointerY < box.top + EDGE) {
				step = -SCROLL_SPEED * Math.min(1, (box.top + EDGE - pointerY) / EDGE);
			} else if (pointerY > box.bottom - EDGE) {
				step = SCROLL_SPEED * Math.min(1, (pointerY - box.bottom + EDGE) / EDGE);
			}

			if (step !== 0) {
				const before = scroller.scrollTop;

				scroller.scrollTop += step;

				if (scroller.scrollTop !== before) {
					update();
				}
			}
		}

		frame = requestAnimationFrame(autoScroll);
	}

	function pointerUp(): void {
		if (dragging) {
			// the release would otherwise click whatever is under the pointer
			window.addEventListener('click', swallow, { capture: true, once: true });
			setTimeout(() => window.removeEventListener('click', swallow, true), 0);
			move(from, to);
		}

		finish();
	}

	function escape(event: KeyboardEvent): void {
		if (event.key !== 'Escape') {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		cancel();
	}

	function swallow(event: MouseEvent): void {
		event.preventDefault();
		event.stopPropagation();
	}

	function cancel(): void {
		finish();
	}

	function finish(): void {
		window.removeEventListener('pointermove', pointerMove);
		window.removeEventListener('pointerup', pointerUp);
		window.removeEventListener('pointercancel', cancel);
		window.removeEventListener('keydown', escape, true);

		if (frame !== null) {
			cancelAnimationFrame(frame);
			frame = null;
		}

		pressIndex = -1;
		dragging = false;
		from = -1;
		to = -1;
		offset = 0;
		scroller = null;
	}

	function move(source: number, target: number): boolean {
		if (source === target || source < 0 || target < 0 || target >= items.length) {
			return false;
		}

		const next = [...items];
		const [moved] = next.splice(source, 1);

		next.splice(target, 0, moved as T);
		items = next;
		onreorder?.(next, source, target);
		announcement = t('web.orderable.moved', { name: nameOf(moved as T), position: target + 1, count: next.length });

		return true;
	}

	async function keyDown(index: number, event: KeyboardEvent): Promise<void> {
		if (disabled) {
			return;
		}

		const targets: Record<string, number> = {
			ArrowUp: index - 1,
			ArrowDown: index + 1,
			Home: 0,
			End: items.length - 1
		};
		const target = targets[event.key];

		if (target === undefined) {
			return;
		}

		event.preventDefault();

		if (!move(index, target)) {
			return;
		}

		// the moved row's node is re-inserted, which drops its focus
		await tick();
		rowElements()[target]?.querySelector<HTMLElement>('.handle')?.focus();
	}

	function shift(index: number): string | undefined {
		if (!dragging) {
			return undefined;
		}

		if (index === from) {
			return `translateY(${offset}px)`;
		}

		if (from < to && index > from && index <= to) {
			return `translateY(${-stride}px)`;
		}

		if (to < from && index >= to && index < from) {
			return `translateY(${stride}px)`;
		}

		return undefined;
	}

	// a list unmounted mid-drag must not leave its window listeners behind
	onMount(() => finish);
</script>

<div class="orderable {className}" class:sorting={dragging} class:whole={!handle} class:disabled role="list" bind:this={listEl}>
	{#if dragging}
		<div class="slot" aria-hidden="true" style:top="{slotTop}px" style:height="{slotHeight}px"></div>
	{/if}

	{#each items as entry, index (key(entry))}
		<div
			class="row"
			class:lifted={dragging && index === from}
			role="listitem"
			style:transform={shift(index)}
			onpointerdown={handle ? undefined : (event: PointerEvent) => pointerDown(index, event)}
		>
			<button
				type="button"
				class="handle"
				{disabled}
				aria-label={t('web.orderable.move', { name: nameOf(entry) })}
				use:tooltip={{ content: t('web.orderable.hint') }}
				onpointerdown={handle ? (event: PointerEvent) => pointerDown(index, event) : undefined}
				onkeydown={(event: KeyboardEvent) => keyDown(index, event)}
			>
				<Icon name="gripLines" size="0.875rem" style="solid" />
			</button>
			<div class="content">{@render item(entry, index)}</div>
		</div>
	{/each}

	<span class="announce" aria-live="polite">{announcement}</span>
</div>

<style lang="scss">
	.orderable {
		position: relative;
		display: flex;
		flex-direction: column;

		&.sorting {
			user-select: none;
			cursor: grabbing;

			.row:not(.lifted) {
				transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
			}

			.handle {
				cursor: grabbing;
			}
		}

		&.whole:not(.disabled) > .row {
			cursor: grab;
			touch-action: none;
		}
	}

	.row {
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.375rem 0.25rem;
		border-bottom: 0.1rem solid var(--border-divider);

		// a divider separates rows: none under the last one
		&:nth-last-child(1 of .row) {
			border-bottom-color: transparent;
		}

		// above the slot and the rows it passes, as if picked up off the list
		&.lifted {
			z-index: 2;
			border-radius: 0.25rem;
			border-bottom-color: transparent;
			background: var(--bg-panel);
			box-shadow: var(--shadow-dropdown);
		}
	}

	// where the dragged row will land
	.slot {
		position: absolute;
		left: 0;
		right: 0;
		z-index: 1;
		box-sizing: border-box;
		border: 0.125rem dashed var(--link);
		border-radius: 0.25rem;
		background: color-mix(in srgb, var(--link) 10%, transparent);
		pointer-events: none;
	}

	.handle {
		@include bare-button;

		display: inline-flex;
		flex: none;
		padding: 0.25rem;
		border-radius: 0.25rem;
		color: var(--text-secondary);
		cursor: grab;
		touch-action: none;

		&:hover:not(:disabled) {
			color: var(--text);
		}

		&:focus-visible {
			@include focus-ring;
		}

		&:disabled {
			color: var(--text-disabled);
			cursor: default;
		}
	}

	.content {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex: 1;
		min-width: 0;
	}

	// read by screen readers only
	.announce {
		position: absolute;
		width: 0.0625rem;
		height: 0.0625rem;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>
