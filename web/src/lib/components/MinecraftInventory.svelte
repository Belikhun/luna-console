<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	/**
	 * The chest the selector actually is: six rows on the real container texture,
	 * with the top five holding servers and the bottom one the plugin's own
	 * footer.
	 *
	 * Slots are positioned as percentages of the background so the whole thing
	 * scales with its container and still lines up with the texture's own grid.
	 *
	 * The chest also publishes `--gui-px`, one Minecraft pixel in CSS terms, so
	 * anything drawn inside it; the title, an item tooltip; is sized off the
	 * game's own grid instead of a fixed rem value that would drift out of scale
	 * the moment the panel resized.
	 */

	import Icon from './Icon.svelte';
	import MinecraftItem from './MinecraftItem.svelte';
	import { CHEST_TEXTURE_URL } from './mcassets';
	import type { InventorySlot, SlotDragSource } from './minecraftinventory';

	interface Props {
		/** 45 entries; a null slot is empty */
		slots: Array<InventorySlot | null>;
		/** Multiplier on the chest's full size; 1 is a GUI as wide as it may be */
		scale?: number;
		selected?: number | null;
		/** Slots the plugin decorates when nothing else occupies them */
		showBorder?: boolean;
		/** The plugin's fixed bottom row (lobby, back, dashboard, close, paging) */
		footer?: Array<InventorySlot | null>;
		title?: import('svelte').Snippet;
		/** Drawn beside the hovered slot, the way the game hangs one off the cursor */
		tooltip?: import('svelte').Snippet<[number]>;
		onselect?: (slot: number) => void;
		ondropslot?: (source: SlotDragSource, slot: number) => void;
		/** Hovering a slot; the page renders the tooltip so it can position it */
		onhover?: (slot: number | null) => void;
	}

	const {
		slots,
		scale = 1,
		selected = null,
		showBorder = true,
		footer,
		title,
		tooltip,
		onselect,
		ondropslot,
		onhover
	}: Props = $props();

	// The chest is drawn in the top-left 176×222 of a 256×256 sheet. Its slots are
	// where the client puts them: the first 16×16 item area starts at (8,18) and
	// they step 18px apart, the extra two being the slot's own bevel. Everything
	// below is a percentage of the 176×222 crop, so the whole thing scales with
	// its container.
	const SHEET = 256;
	const TEXTURE_W = 176;
	const TEXTURE_H = 222;
	const CELL = 18;
	const ORIGIN_X = 8;
	const ORIGIN_Y = 18;
	const COLS = 9;
	const GRID_ROWS = 5;

	function cellStyle(index: number): string {
		const row = Math.floor(index / COLS);
		const col = index % COLS;
		const left = ((ORIGIN_X + col * CELL) / TEXTURE_W) * 100;
		const top = ((ORIGIN_Y + row * CELL) / TEXTURE_H) * 100;

		return `left:${left}%;top:${top}%;width:${(16 / TEXTURE_W) * 100}%;height:${(16 / TEXTURE_H) * 100}%`;
	}

	/** The plugin paints its gradient border on edge cells nothing else uses. */
	function isBorder(index: number): boolean {
		const row = Math.floor(index / COLS);
		const col = index % COLS;

		return row === 0 || row === GRID_ROWS - 1 || col === 0 || col === COLS - 1;
	}

	// the dragged item is held in module state rather than dataTransfer: the same
	// pattern the table's column reorder uses, and it survives the drag entering
	// a different component
	let dragging: SlotDragSource | null = $state(null);
	let over: number | null = $state(null);
	let hovered: number | null = $state(null);

	function enter(index: number): void {
		hovered = index;
		onhover?.(index);
	}

	function leave(index: number): void {
		if (hovered === index) {
			hovered = null;
		}

		onhover?.(null);
	}

	let chestEl: HTMLDivElement | undefined = $state();
	let tipEl: HTMLDivElement | undefined = $state();
	// px, not rem: this is measured geometry, converted on the way into the style
	let tip = $state({ left: 0, top: 0, unit: 0, ready: false });
	let resized = $state(0);

	/** How far a tooltip is kept from the edge of the window, in game pixels. */
	const MARGIN = 4;

	/**
	 * Hang the tooltip off the hovered slot and then clamp it to the window.
	 *
	 * The game puts a tooltip down-and-right of the cursor, flips it to the other
	 * side when it would run off the screen, and pulls it back in when even that
	 * does not fit. The screen is the bound there and the window is the bound here,
	 * which is why the card is placed in viewport coordinates and lives outside the
	 * chest: an item's lore is routinely wider than the GUI it hangs off, and a card
	 * clipped to the panel would be missing the end of every line the player reads.
	 */
	$effect(() => {
		const card = tipEl;
		const chest = chestEl;
		const index = hovered;
		void resized;

		if (!card || !chest || index === null) {
			return;
		}

		const unit = chest.clientWidth / TEXTURE_W;
		const size = card.getBoundingClientRect();
		const chestBox = chest.getBoundingClientRect();
		const col = index % COLS;
		const row = Math.floor(index / COLS);
		const gap = 12 * unit;
		const margin = MARGIN * unit;

		let left = chestBox.left + (ORIGIN_X + col * CELL + 16) * unit + gap;

		if (left + size.width > window.innerWidth - margin) {
			left = chestBox.left + (ORIGIN_X + col * CELL) * unit - gap - size.width;
		}

		const top = chestBox.top + (ORIGIN_Y + row * CELL) * unit;

		tip = {
			left: Math.max(margin, Math.min(left, window.innerWidth - margin - size.width)),
			top: Math.max(margin, Math.min(top, window.innerHeight - margin - size.height)),
			unit,
			ready: true
		};
	});

	// the card is placed against the viewport, so anything that moves the chest
	// within it has to re-place it; and the page scrolls a panel, not the window
	$effect(() => {
		const bump = (): void => {
			resized += 1;
		};

		document.addEventListener('scroll', bump, true);

		return () => document.removeEventListener('scroll', bump, true);
	});

	// a card's own size settles late: a line whose glyphs are not in the sheets
	// waits on a fetch, and the width it was placed at was the width before them
	$effect(() => {
		const card = tipEl;

		if (!card || typeof ResizeObserver === 'undefined') {
			return;
		}

		const observer = new ResizeObserver(() => (resized += 1));
		observer.observe(card);

		return () => observer.disconnect();
	});

	export function beginDrag(source: SlotDragSource): void {
		dragging = source;
	}

	export function endDrag(): void {
		dragging = null;
		over = null;
	}

	function handleDrop(index: number): void {
		if (dragging) {
			ondropslot?.(dragging, index);
		}

		endDrag();
	}
</script>

<svelte:window onresize={() => resized++} />

<div
	bind:this={chestEl}
	class="chest"
	style:--chest-ratio={`${TEXTURE_W} / ${TEXTURE_H}`}
	style:--sheet-w={`${(SHEET / TEXTURE_W) * 100}%`}
	style:--sheet-h={`${(SHEET / TEXTURE_H) * 100}%`}
	style:--chest-bg={`url("${CHEST_TEXTURE_URL}")`}
	style:--chest-scale={scale}
>
	{#if title}
		<div class="title" style:left={`${(8 / TEXTURE_W) * 100}%`} style:top={`${(6 / TEXTURE_H) * 100}%`}>
			{@render title()}
		</div>
	{/if}

	{#each { length: COLS * GRID_ROWS } as _, index (index)}
		{@const slot = slots[index] ?? null}
		<button
			class="cell"
			class:filled={!!slot}
			class:selected={selected === index}
			class:over={over === index}
			class:border={showBorder && !slot && isBorder(index)}
			style={cellStyle(index)}
			draggable={!!slot}
			aria-label={slot ? `${slot.name}; page ${slot.page}, slot ${index}` : `slot ${index}`}
			onclick={() => onselect?.(index)}
			onmouseenter={() => enter(index)}
			onmouseleave={() => leave(index)}
			ondragstart={() => slot && beginDrag({ kind: 'slot', name: slot.name, fromSlot: index })}
			ondragend={endDrag}
			ondragover={(event) => {
				event.preventDefault();
				over = index;
			}}
			ondragleave={() => (over === index ? (over = null) : null)}
			ondrop={(event) => {
				event.preventDefault();
				handleDrop(index);
			}}
		>
			{#if slot}
				<MinecraftItem
					item={slot.item}
					glint={slot.glint}
					size="100%"
					fallbackLabel={slot.name}
					fallbackColor={slot.accentColor}
				/>
			{/if}
		</button>
	{/each}

	{#each { length: COLS } as _, index (index)}
		{@const slot = footer?.[index] ?? null}
		<div class="cell footer" style={cellStyle(COLS * GRID_ROWS + index)} title={slot?.name}>
			{#if slot}
				<MinecraftItem item={slot.item} size="100%" fallbackLabel={slot.name} />
			{/if}
		</div>
	{/each}

	{#if !slots.some(Boolean)}
		<p class="empty">
			<Icon name="hand" style="light" /> drag a server from the palette into a slot
		</p>
	{/if}
</div>

<!--
	Outside the chest on purpose: the chest is a query container inside a panel
	that clips, and a card is routinely wider than both. Its Minecraft pixel is
	therefore measured and handed over rather than inherited.
-->
{#if tooltip && hovered !== null && slots[hovered]}
	<div
		class="tipcard"
		bind:this={tipEl}
		style:--gui-px={`${tip.unit}px`}
		style:left={`${tip.left}px`}
		style:top={`${tip.top}px`}
		style:visibility={tip.ready ? 'visible' : 'hidden'}
	>
		{@render tooltip(hovered)}
	</div>
{/if}

<style lang="scss">
	.chest {
		position: relative;
		// the scale is the GUI's own zoom, the way the game's is: it changes how big
		// a Minecraft pixel is and nothing else, so the whole chest; slots, title,
		// the tooltip hanging off it; resizes together and stays in proportion
		width: calc(100% * var(--chest-scale));
		max-width: calc(40rem * var(--chest-scale));
		aspect-ratio: var(--chest-ratio);
		margin-inline: auto;

		// One Minecraft pixel, for everything drawn on top of the chest. The
		// container query is what makes it a measurement rather than a guess: the
		// GUI is 176 pixels wide whatever size the panel hands it, so text sized
		// off this stays in proportion instead of drifting the moment it resizes.
		container-type: inline-size;
		--gui-px: calc(100cqw / 176);

		// The sheet is larger than the chest drawn on it, and the rest is
		// transparent padding that would throw every slot's position off. Painting
		// it as a background crops it to the element for free, so the chest no
		// longer needs `overflow: hidden`; which would otherwise eat any tooltip
		// hanging past its edge.
		background-image: var(--chest-bg);
		background-size: var(--sheet-w) var(--sheet-h);
		background-position: 0 0;
		background-repeat: no-repeat;
		image-rendering: pixelated;
	}

	.title {
		position: absolute;
		// The game's glyphs are 8 pixels tall on a 9-pixel line. Ten of our pixels
		// is what reproduces that: measured, the rendered band is 8.25 game pixels
		// from cap to descender. Sizing to the cap height instead would come out
		// 9 tall and start colliding with the line below.
		font-size: calc(var(--gui-px) * 10);
		line-height: calc(var(--gui-px) * 9);
		// a container label is drawn in this grey, and without a shadow
		color: #3f3f3f;
		pointer-events: none;
		white-space: nowrap;
	}

	// hung off the slot the way the game hangs one off the cursor; the placement
	// itself is measured, because a card's size is not knowable in CSS
	.tipcard {
		position: fixed;
		z-index: var(--z-tooltip);
		pointer-events: none;
	}

	.cell {
		position: absolute;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		border: none;
		background: none;
		cursor: pointer;

		&:hover {
			background: rgba(255, 255, 255, 0.35);
		}

		&.selected {
			outline: 0.125rem solid var(--primary);
			outline-offset: 0.0625rem;
		}

		&.over {
			background: rgba(66, 180, 255, 0.45);
		}

		// the decorative panes the plugin paints on unoccupied edge slots
		&.border {
			background: linear-gradient(135deg, rgba(109, 255, 212, 0.22), rgba(78, 163, 255, 0.22));
		}

		&.footer {
			cursor: default;
			opacity: 0.85;

			&:hover {
				background: none;
			}
		}
	}

	.empty {
		position: absolute;
		inset: auto 0 12%;
		text-align: center;
		font-size: 0.75rem;
		color: var(--text-secondary);
		pointer-events: none;
	}
</style>
