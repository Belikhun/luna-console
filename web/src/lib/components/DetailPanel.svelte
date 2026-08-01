<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';

	/**
	 * Split panel. Docks flush to the bottom (or the right) of the content area
	 * — outside the page's scroll box, spanning from the side nav to the window
	 * edge — with a drag handle on the leading edge, a collapse toggle and a
	 * dock-side toggle. While open it publishes its size as --split-bottom /
	 * --split-right so the layout can inset the page content instead of hiding
	 * it underneath.
	 */
	let {
		title,
		subtitle,
		href,
		hrefLabel = 'Open full details',
		location = $bindable('bottom'),
		size = $bindable(38),
		collapsed = $bindable(false),
		onclose,
		actions,
		children
	}: {
		title: string;
		subtitle?: string;
		href?: string;
		hrefLabel?: string;
		/** dock side: bottom (the default) or right */
		location?: 'bottom' | 'right';
		/** percent of the viewport */
		size?: number;
		collapsed?: boolean;
		onclose?: () => void;
		actions?: Snippet;
		children: Snippet;
	} = $props();

	/** rem — a collapsed panel is exactly its header row */
	const HEADER_H = 2.75;

	/** percent of the viewport the panel may be resized between */
	const MIN_SIZE = 15;
	const MAX_SIZE = 80;

	/** percentage points one arrow-key press moves the edge */
	const KEY_STEP = 4;

	let dragging = $state(false);
	let panel: HTMLElement | undefined = $state();

	/** distance from the pointer to the panel's leading edge when the drag began */
	let grabOffset = 0;

	const extent = $derived.by(() => {
		if (collapsed) {
			return `${HEADER_H}rem`;
		}

		return location === 'bottom' ? `${size}vh` : `${size}vw`;
	});

	/** Clamp a proposed size to the resize range. */
	function clampSize(value: number): number {
		return Math.min(Math.max(value, MIN_SIZE), MAX_SIZE);
	}

	$effect(() => {
		const root = document.documentElement;

		root.style.setProperty('--split-bottom', location === 'bottom' ? extent : '0rem');
		root.style.setProperty('--split-right', location === 'right' ? extent : '0rem');

		return () => {
			root.style.setProperty('--split-bottom', '0rem');
			root.style.setProperty('--split-right', '0rem');
		};
	});

	/**
	 * The handle sits inside the panel and the panel's far edge is inset by the
	 * status bar and terminal drawer, so resizing has to work from the panel's
	 * measured box and keep the pointer's grab offset — deriving the size straight
	 * from the viewport makes the panel jump to meet the cursor on the first move.
	 */
	function onPointerMove(event: PointerEvent): void {
		if (!dragging || !panel) {
			return;
		}

		const box = panel.getBoundingClientRect();

		const value =
			location === 'bottom'
				? ((box.bottom - (event.clientY - grabOffset)) / window.innerHeight) * 100
				: ((box.right - (event.clientX - grabOffset)) / window.innerWidth) * 100;

		size = clampSize(value);
	}

	function startDrag(event: PointerEvent): void {
		if (collapsed || !panel) {
			return;
		}

		event.preventDefault();

		const box = panel.getBoundingClientRect();

		grabOffset =
			location === 'bottom' ? event.clientY - box.top : event.clientX - box.left;
		dragging = true;
	}

	/** Arrow keys resize the panel, matching the slider role on the handle. */
	function onSliderKey(event: KeyboardEvent): void {
		const grow = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
		const shrink = event.key === 'ArrowDown' || event.key === 'ArrowRight';

		if (!grow && !shrink) {
			return;
		}

		event.preventDefault();

		size = clampSize(size + (grow ? KEY_STEP : -KEY_STEP));
	}
</script>

<svelte:window onpointermove={onPointerMove} onpointerup={() => (dragging = false)} />

<aside class="dp {location}" class:dragging class:collapsed style:--extent={extent} bind:this={panel}>
	<div class="handle" role="presentation" onpointerdown={startDrag}>
		<button
			class="slider"
			type="button"
			role="slider"
			aria-label="Resize split panel"
			aria-valuenow={Math.round(size)}
			aria-valuemin={MIN_SIZE}
			aria-valuemax={MAX_SIZE}
			onkeydown={onSliderKey}
		>
			<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8H14" /></svg>
		</button>
	</div>
	<div class="hd">
		<div class="ttl">
			<h2>{title}</h2>
			{#if subtitle}<span class="sub">{subtitle}</span>{/if}
			{#if href}
				<a class="lnk" {href}>
					<span class="lt">{hrefLabel}</span>
					<Icon name="arrowRight" size="0.75rem" />
				</a>
			{/if}
		</div>
		<div class="acts">
			{#if actions && !collapsed}{@render actions()}{/if}
			<button
				class="tool"
				title={location === 'bottom' ? 'Dock to the right' : 'Dock to the bottom'}
				onclick={() => (location = location === 'bottom' ? 'right' : 'bottom')}
			>
				<Icon name={location === 'bottom' ? 'sidebarFlip' : 'toggleOff'} size="1rem" />
			</button>
			<button
				class="tool"
				title={collapsed ? 'Expand panel' : 'Collapse panel'}
				onclick={() => (collapsed = !collapsed)}
			>
				<Icon name={collapsed ? 'arrowUp' : 'arrowDown'} size="1rem" />
			</button>
			{#if onclose}
				<button class="tool" title="Close panel" onclick={onclose}>
					<Icon name="close" size="1rem" />
				</button>
			{/if}
		</div>
	</div>
	{#if !collapsed}
		<div class="bd">{@render children()}</div>
	{/if}
</aside>

<style lang="scss">
	.dp {
		position: fixed;
		z-index: var(--z-split-panel);
		display: flex;
		flex-direction: column;
		background: var(--bg-panel);
		min-height: 0;
		min-width: 0;
	}
	// the far edge clears the status bar and, when it is open, the terminal drawer
	.dp.bottom {
		left: var(--nav-w);
		right: 0;
		bottom: calc(var(--statusbar-h, 1.75rem) + var(--shell-h, 0px));
		height: var(--extent);
		border-top: 0.1rem solid var(--border-drawer);

		.handle {
			top: 0;
			left: 50%;
			transform: translateX(-50%);
			width: 8rem;
			height: 1.5rem;
			cursor: row-resize;
		}
	}

	.dp.right {
		top: var(--content-top, 4.5rem);
		bottom: calc(var(--statusbar-h, 1.75rem) + var(--shell-h, 0px));
		right: 0;
		width: var(--extent);
		border-left: 0.1rem solid var(--border-drawer);

		.handle {
			left: 0;
			top: 50%;
			transform: translateY(-50%);
			width: 1.5rem;
			height: 8rem;
			cursor: col-resize;
		}

		.slider {
			transform: rotate(90deg);
		}
	}

	.dp.dragging {
		user-select: none;

		.slider {
			color: var(--link);
		}
	}

	.dp.collapsed .handle {
		cursor: default;

		&:hover .slider {
			color: var(--text-heading);
		}
	}

	.handle {
		position: absolute;
		z-index: 5;
		display: flex;
		align-items: center;
		justify-content: center;

		&:hover .slider {
			color: var(--link);
		}
	}

	// the split-panel slider: a 1rem icon box drawing a single 0.75rem rule,
	// sitting just inside the panel edge — not a rounded pill.
	.slider {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1rem;
		height: 1.125rem;
		padding: 0;
		border: none;
		background: none;
		color: var(--text-heading);
		cursor: inherit;

		svg {
			width: 1rem;
			height: 1rem;
			fill: none;
			stroke: currentColor;
			stroke-width: 2;
			stroke-linecap: round;
		}

		&:focus-visible {
			outline: 0.125rem solid var(--link);
			outline-offset: 0.125rem;
			border-radius: 0.25rem;
		}
	}

	.hd {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		height: 2.75rem;
		padding: 0 1.25rem;
		flex: none;
	}
	.ttl {
		display: flex;
		align-items: baseline;
		gap: 0.75rem;
		min-width: 0;

		h2 {
			font-size: 1rem;
			white-space: nowrap;
		}
	}

	.sub {
		color: var(--text-secondary);
		white-space: nowrap;
	}

	.lnk {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.875rem;
		white-space: nowrap;
	}

	.acts {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex: none;
	}

	.tool {
		@include bare-button;

		color: var(--text);
		padding: 0.125rem;
		border-radius: 0.25rem;
		display: inline-flex;

		&:hover {
			color: var(--link);
		}
	}

	.bd {
		flex: 1;
		overflow: auto;
		padding: 0 1.25rem 1.25rem;
		min-height: 0;
	}
</style>
