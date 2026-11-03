<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import Icon from './Icon.svelte';

	/**
	 * A full-screen look at one picture of a set: the image fitted to the window
	 * over a dark backdrop, zoomed with the wheel (around the pointer), the
	 * toolbar or + − 0, dragged around once it is bigger than the window, and
	 * double-clicked to jump between fitted and twice that. Arrows (and ←/→)
	 * step through the set; Escape or a click on the backdrop closes it.
	 * `index` is the picture shown; null means closed.
	 */
	let {
		images,
		index = $bindable(null)
	}: {
		images: Array<{ src: string; alt: string; name?: string }>;
		index?: number | null;
	} = $props();

	const MIN_ZOOM = 0.25;
	const MAX_ZOOM = 8;
	const STEP = 1.25;

	// per px of wheel travel: a 100px mouse notch zooms by about one STEP
	const WHEEL_RATE = Math.log(STEP) / 100;

	let zoom = $state(1);
	let x = $state(0);
	let y = $state(0);
	let dragging = $state(false);
	let stage: HTMLDivElement | undefined = $state();

	/** px the console's own chrome takes at the top and bottom, which the viewer leaves showing */
	let inset = $state({ top: 0, bottom: 0 });

	let drag: { pointer: number; startX: number; startY: number; fromX: number; fromY: number } | null = null;

	const current = $derived(index === null ? null : images[index] ?? null);
	const percent = $derived(`${Math.round(zoom * 100)}%`);
	const changed = $derived(zoom !== 1 || x !== 0 || y !== 0);

	// a different picture starts fitted and centred
	$effect(() => {
		void index;
		reset();
	});

	function reset(): void {
		zoom = 1;
		x = 0;
		y = 0;
	}

	function clamp(value: number): number {
		return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
	}

	/**
	 * Zoom to `next`, keeping the point under (`cx`, `cy`) where it is; without
	 * a point, the middle of the stage stays put. Coordinates are px from the
	 * stage's centre, which is where the picture's transform is anchored.
	 */
	function zoomTo(next: number, cx = 0, cy = 0): void {
		const target = clamp(next);
		const ratio = target / zoom;

		x = cx - (cx - x) * ratio;
		y = cy - (cy - y) * ratio;
		zoom = target;

		if (zoom <= 1) {
			x = 0;
			y = 0;
		}
	}

	/** The pointer's place relative to the stage's centre, in px */
	function fromCentre(event: MouseEvent): { cx: number; cy: number } {
		const box = stage?.getBoundingClientRect();

		if (!box) {
			return { cx: 0, cy: 0 };
		}

		return {
			cx: event.clientX - box.left - box.width / 2,
			cy: event.clientY - box.top - box.height / 2
		};
	}

	/**
	 * The wheel zooms around the pointer, a trackpad pinch (which browsers send
	 * as a wheel with Ctrl held) included. The step follows how far the wheel
	 * moved, so a mouse notch is about one button press and a trackpad glides.
	 * Attached by hand because Svelte's `onwheel` is passive, and a passive
	 * listener cannot keep the browser from zooming the whole page instead.
	 */
	function wheelZoom(node: HTMLElement): { destroy: () => void } {
		const onWheel = (event: WheelEvent): void => {
			event.preventDefault();

			const lines = event.deltaMode === WheelEvent.DOM_DELTA_LINE
				? event.deltaY * 16
				: event.deltaY;
			const { cx, cy } = fromCentre(event);

			zoomTo(zoom * Math.exp(-Math.max(-200, Math.min(200, lines)) * WHEEL_RATE), cx, cy);
		};

		node.addEventListener('wheel', onWheel, { passive: false });

		return {
			destroy: () => node.removeEventListener('wheel', onWheel)
		};
	}

	function onDoubleClick(event: MouseEvent): void {
		if (changed) {
			reset();

			return;
		}

		const { cx, cy } = fromCentre(event);

		zoomTo(2, cx, cy);
	}

	function onPointerDown(event: PointerEvent): void {
		if (event.button !== 0 || zoom <= 1) {
			return;
		}

		drag = { pointer: event.pointerId, startX: event.clientX, startY: event.clientY, fromX: x, fromY: y };
		dragging = true;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	function onPointerMove(event: PointerEvent): void {
		if (!drag || drag.pointer !== event.pointerId) {
			return;
		}

		x = drag.fromX + event.clientX - drag.startX;
		y = drag.fromY + event.clientY - drag.startY;
	}

	function onPointerUp(event: PointerEvent): void {
		if (drag?.pointer === event.pointerId) {
			drag = null;
			dragging = false;
		}
	}

	function step(by: number): void {
		if (index === null || images.length < 2) {
			return;
		}

		index = (index + by + images.length) % images.length;
	}

	function close(): void {
		index = null;
	}

	function onKey(event: KeyboardEvent): void {
		if (index === null) {
			return;
		}

		switch (event.key) {
			case 'Escape':
				// the viewer swallows the Escape; a chat or modal beneath must not act on it too
				event.preventDefault();
				event.stopPropagation();
				close();
				break;

			case 'ArrowLeft':
				step(-1);
				break;

			case 'ArrowRight':
				step(1);
				break;

			case '+':
			case '=':
				zoomTo(zoom * STEP);
				break;

			case '-':
				zoomTo(zoom / STEP);
				break;

			case '0':
				reset();
				break;
		}
	}

	/**
	 * Move the viewer to the end of the page while it is open. It is rendered
	 * inside a chat message, and an ancestor with a transform or its own
	 * stacking context (a message's entry animation, the docked panel) would
	 * otherwise pin `position: fixed` to itself and let the page draw over it.
	 */
	function portal(node: HTMLElement): { destroy: () => void } {
		document.body.appendChild(node);
		measureChrome();

		return {
			destroy: () => node.remove()
		};
	}

	/**
	 * Fit between the top navigation and the status bar, so the console stays
	 * visible around the picture; a bare window (a popped-out chat) has neither.
	 */
	function measureChrome(): void {
		const top = document.querySelector('header.topnav')?.getBoundingClientRect();
		const bottom = document.querySelector('footer.statusbar')?.getBoundingClientRect();

		inset = {
			top: top ? Math.max(0, top.bottom) : 0,
			bottom: bottom ? Math.max(0, window.innerHeight - bottom.top) : 0
		};
	}

	/** A file name for the download: the one given, else the last part of its address */
	function fileName(image: { src: string; name?: string }): string {
		if (image.name) {
			return image.name;
		}

		const last = image.src.split('?')[0]?.split('/').pop() ?? 'image';

		return decodeURIComponent(last);
	}
</script>

<svelte:window onkeydowncapture={onKey} onresize={() => current && measureChrome()} />

{#if current}
	<div class="viewer" role="dialog" aria-modal="true" aria-label={current.alt} style:top="{inset.top}px" style:bottom="{inset.bottom}px" use:portal>
		<!-- the stage is the backdrop: a click on it (not a drag) closes the viewer -->
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<div
			class="stage"
			bind:this={stage}
			use:wheelZoom
			onclick={(event) => {
				if (event.target === event.currentTarget) {
					close();
				}
			}}
		>
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<img
				src={current.src}
				alt={current.alt}
				draggable="false"
				class:zoomed={zoom > 1}
				class:dragging
				style:transform="translate({x}px, {y}px) scale({zoom})"
				ondblclick={onDoubleClick}
				onpointerdown={onPointerDown}
				onpointermove={onPointerMove}
				onpointerup={onPointerUp}
				onpointercancel={onPointerUp}
			/>
		</div>

		<div class="top">
			{#if images.length > 1}
				<span class="count">{(index ?? 0) + 1} / {images.length}</span>
			{/if}
			<span class="title">{current.alt}</span>
			<div class="group">
				<a class="tool" href={current.src} target="_blank" rel="noopener" title={t('web.imageViewer.original')}>
					<Icon name="arrowUpRightFromSquare" size="0.875rem" />
				</a>
				<a class="tool" href={current.src} download={fileName(current)} title={t('web.imageViewer.download')}>
					<Icon name="arrowDownToLine" size="0.875rem" />
				</a>
				<span class="sep"></span>
				<button class="tool close" type="button" title={t('web.common.close')} onclick={close}>
					<Icon name="close" size="0.875rem" />
				</button>
			</div>
		</div>

		<div class="zoombar group">
			<button class="tool" type="button" title={t('web.imageViewer.zoomOut')} disabled={zoom <= MIN_ZOOM} onclick={() => zoomTo(zoom / STEP)}>
				<Icon name="minus" size="0.875rem" />
			</button>
			<button class="level" type="button" title={t('web.imageViewer.reset')} disabled={!changed} onclick={reset}>
				{percent}
			</button>
			<button class="tool" type="button" title={t('web.imageViewer.zoomIn')} disabled={zoom >= MAX_ZOOM} onclick={() => zoomTo(zoom * STEP)}>
				<Icon name="plus" size="0.875rem" />
			</button>
			<span class="sep"></span>
			<button class="tool" type="button" title={t('web.imageViewer.reset')} disabled={!changed} onclick={reset}>
				<Icon name="rotateLeft" size="0.875rem" />
			</button>
		</div>

		{#if images.length > 1}
			<button class="nav prev" type="button" title={t('web.imageViewer.previous')} onclick={() => step(-1)}>
				<Icon name="arrowLeft" size="1rem" style="solid" />
			</button>
			<button class="nav next" type="button" title={t('web.imageViewer.next')} onclick={() => step(1)}>
				<Icon name="arrowRight" size="1rem" style="solid" />
			</button>
		{/if}
	</div>
{/if}

<style lang="scss">
	// top and bottom are measured off the console's chrome as the viewer opens
	.viewer {
		position: fixed;
		inset: 0;
		z-index: var(--z-modal);
		background: rgb(0 0 0 / 90%);
		animation: fadein 0.12s ease-out;
		user-select: none;
	}

	.stage {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		padding: 4rem 4.5rem;
		overflow: hidden;

		@include below($bp-narrow) {
			padding: 4rem 1rem;
		}

		img {
			max-width: 100%;
			max-height: 100%;
			object-fit: contain;
			border-radius: 0.5rem;
			box-shadow: 0 1rem 3rem rgb(0 0 0 / 50%);
			transition: transform 0.12s ease-out;

			&.zoomed {
				cursor: grab;
			}

			// a drag follows the pointer exactly; easing it would make the picture lag
			&.dragging {
				cursor: grabbing;
				transition: none;
			}
		}
	}

	// controls over the backdrop stay light whatever the theme, since the backdrop is always dark
	.top {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem 0.75rem 0.75rem 1.25rem;
		background: linear-gradient(rgb(0 0 0 / 55%), transparent);
		color: rgb(255 255 255 / 85%);
		font-size: 0.875rem;
		pointer-events: none;

		> * {
			pointer-events: auto;
		}

		.count {
			flex: none;
			font-variant-numeric: tabular-nums;
			color: rgb(255 255 255 / 60%);
		}

		.title {
			@include ellipsis;

			flex: 1;
			min-width: 0;
		}
	}

	// a pill of tools on frosted glass, the way the zoom bar below is drawn
	.group {
		display: inline-flex;
		align-items: center;
		gap: 0.125rem;
		padding: 0.25rem;
		border: 0.1rem solid rgb(255 255 255 / 12%);
		border-radius: 2rem;
		background: rgb(30 30 36 / 72%);
		backdrop-filter: blur(0.75rem);
		box-shadow: 0 0.5rem 1.5rem rgb(0 0 0 / 35%);
	}

	.sep {
		width: 0.1rem;
		height: 1.25rem;
		margin: 0 0.25rem;
		background: rgb(255 255 255 / 16%);
	}

	.tool,
	.level,
	.nav {
		@include bare-button;

		display: inline-grid;
		place-items: center;
		color: rgb(255 255 255 / 85%);
		cursor: pointer;
		transition: background 0.12s, color 0.12s;

		&:hover:not(:disabled) {
			background: rgb(255 255 255 / 14%);
			color: #fff;
		}

		&:focus-visible {
			@include focus-ring;
		}

		&:disabled {
			color: rgb(255 255 255 / 30%);
			cursor: default;
		}
	}

	.tool {
		width: 2rem;
		height: 2rem;
		border-radius: 50%;

		&.close:hover {
			background: color-mix(in srgb, var(--error) 70%, transparent);
		}
	}

	.level {
		min-width: 3.5rem;
		height: 2rem;
		padding: 0 0.5rem;
		border-radius: 1rem;
		font-size: 0.8125rem;
		font-variant-numeric: tabular-nums;

		// the level reads as text while there is nothing to reset
		&:disabled {
			color: rgb(255 255 255 / 85%);
		}
	}

	.zoombar {
		position: absolute;
		bottom: 1rem;
		left: 50%;
		transform: translateX(-50%);
	}

	.nav {
		position: absolute;
		top: 50%;
		width: 2.75rem;
		height: 2.75rem;
		border: 0.1rem solid rgb(255 255 255 / 12%);
		border-radius: 50%;
		background: rgb(30 30 36 / 72%);
		backdrop-filter: blur(0.75rem);
		transform: translateY(-50%);

		&.prev {
			left: 1rem;
		}

		&.next {
			right: 1rem;
		}
	}
</style>
