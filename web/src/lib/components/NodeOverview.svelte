<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	/**
	 * A flat grid of small cells, one per node, coloured by a value on a ramp or
	 * by an explicit colour, with a hover card carrying that node's full detail.
	 * Ported from the dashboard's `NodeOverviewGraph` in src/charts.js.
	 *
	 * It exists for the case a table handles badly: a few hundred things where the
	 * shape of the set is the point ("most idle, two pinned") and any individual
	 * one is worth reading only once you have spotted it. Every node is drawn -
	 * nothing is paged or topped-N - because a grid that hides its tail cannot
	 * answer the question it was opened for.
	 *
	 * The ramp is built as `color-mix()` expressions over the caller's stops
	 * rather than interpolated in JavaScript, so design tokens can be used as
	 * stops and keep resolving at paint time; a JS-side rgb interpolation would
	 * freeze them at whatever the theme was when the grid was built.
	 */

	import { onMount } from 'svelte';

	import type { OverviewLegendEntry, OverviewNode } from './nodeoverview';

	let {
		nodes,
		cell = '0.75rem',
		gap = '0.25rem',
		columns = null,
		ramp = ['var(--bg-track)', 'var(--link)'],
		min = null,
		max = null,
		legend = true,
		legendFormat = (value: number) => String(value),
		empty
	}: {
		nodes: OverviewNode[];
		/** Cell edge; keep it on the spacing scale */
		cell?: string;
		gap?: string;
		/** Fixed column count; null auto-fills the available width */
		columns?: number | null;
		/**
		 * Ramp stops, low to high. Two or more; design tokens are fine. Pass an
		 * empty array to colour purely by each node's own `color`.
		 */
		ramp?: string[];
		/** Value scale bounds; derived from the data when null */
		min?: number | null;
		max?: number | null;
		legend?: boolean | OverviewLegendEntry[];
		legendFormat?: (value: number) => string;
		/** Shown in place of the grid when there is nothing to draw */
		empty?: string;
	} = $props();

	/** How far the hover card is kept from the edge of the window. */
	const MARGIN = 12;
	/** Space between the hovered cell and its card. */
	const OFFSET = 10;

	let hovered: number | null = $state(null);
	let cardEl: HTMLElement | undefined = $state();
	let gridEl: HTMLElement | undefined = $state();

	let card = $state({ left: 0, top: 0, ready: false });
	let bump = $state(0);

	const valued = $derived(
		nodes.filter((node) => node.value !== undefined && !node.color) as Array<
			OverviewNode & { value: number }
		>
	);

	const scaleMin = $derived(
		min ?? (valued.length ? Math.min(...valued.map((node) => node.value)) : 0)
	);

	const scaleMax = $derived(
		max ?? (valued.length ? Math.max(...valued.map((node) => node.value)) : 1)
	);

	const node = $derived(hovered === null ? null : (nodes[hovered] ?? null));

	/** Position on the ramp, clamped; a zero-width scale reads as the low end. */
	function normalize(value: number): number {
		const span = scaleMax - scaleMin;

		if (span <= 0) {
			return 0;
		}

		return Math.max(0, Math.min(1, (value - scaleMin) / span));
	}

	/**
	 * The cell's paint colour.
	 *
	 * A value lands between two ramp stops and is expressed as a mix of that pair,
	 * so an N-stop ramp needs no more than one `color-mix` per cell.
	 */
	function colorOf(item: OverviewNode): string {
		if (item.color) {
			return item.color;
		}

		if (item.value === undefined || ramp.length === 0) {
			return 'var(--bg-track)';
		}

		if (ramp.length === 1) {
			return ramp[0]!;
		}

		const scaled = normalize(item.value) * (ramp.length - 1);
		const index = Math.min(Math.floor(scaled), ramp.length - 2);
		const share = Math.round((scaled - index) * 1000) / 10;

		return `color-mix(in srgb, ${ramp[index + 1]} ${share}%, ${ramp[index]})`;
	}

	const legendChips = $derived.by(() => {
		if (Array.isArray(legend)) {
			return legend;
		}

		// derived from the data: one chip per distinct colour that carries a status,
		// which is what names a colour in the first place
		const seen = new Map<string, OverviewLegendEntry>();

		for (const item of nodes) {
			if (!item.color || !item.status || seen.has(item.color)) {
				continue;
			}

			seen.set(item.color, { color: item.color, label: item.status });
		}

		return [...seen.values()];
	});

	const showRampLegend = $derived(legend === true && ramp.length > 1 && valued.length > 0);

	/**
	 * Hang the card off the hovered cell, then pull it back inside the window.
	 *
	 * Placed against the viewport rather than the grid: the grid lives inside a
	 * panel that clips and scrolls, and a card taller than a cell row would be cut
	 * off exactly when it has the most to say.
	 */
	$effect(() => {
		const element = cardEl;
		const index = hovered;

		void bump;
		void node;

		if (!element || index === null || !gridEl) {
			return;
		}

		const target = gridEl.children[index] as HTMLElement | undefined;

		if (!target) {
			return;
		}

		const anchor = target.getBoundingClientRect();
		const size = element.getBoundingClientRect();

		// above the cell by default, below it when there is no room up there
		let top = anchor.top - size.height - OFFSET;

		if (top < MARGIN) {
			top = anchor.bottom + OFFSET;
		}

		const left = anchor.left + anchor.width / 2 - size.width / 2;

		card = {
			left: Math.max(MARGIN, Math.min(left, window.innerWidth - MARGIN - size.width)),
			top: Math.max(MARGIN, Math.min(top, window.innerHeight - MARGIN - size.height)),
			ready: true
		};
	});

	// the card is placed against the viewport, so anything that moves the grid
	// inside it has to re-place the card; the console scrolls panels, not the window
	onMount(() => {
		const reposition = (): void => {
			bump += 1;
		};

		window.addEventListener('resize', reposition);
		window.addEventListener('scroll', reposition, true);

		return () => {
			window.removeEventListener('resize', reposition);
			window.removeEventListener('scroll', reposition, true);
		};
	});

	function enter(index: number): void {
		hovered = index;
		card = { ...card, ready: false };
	}

	function leave(index: number): void {
		if (hovered === index) {
			hovered = null;
		}
	}
</script>

<div class="nov" style:--nov-cell={cell} style:--nov-gap={gap}>
	{#if nodes.length === 0}
		<div class="empty dim">{empty ?? ''}</div>
	{:else}
		<div
			class="nodes"
			bind:this={gridEl}
			style:grid-template-columns={columns ? `repeat(${columns}, var(--nov-cell))` : undefined}
		>
			{#each nodes as item, index (index)}
				<!-- A swatch, not a control: several hundred cells turned into tab stops
				     would bury every real control on the page, so the grid stays
				     presentational and the readout beside it carries the keyboard path. -->
				<div
					class="node"
					class:active={hovered === index}
					style:background-color={colorOf(item)}
					role="img"
					aria-label={item.label}
					onmouseenter={() => enter(index)}
					onmouseleave={() => leave(index)}
				></div>
			{/each}
		</div>
	{/if}

	{#if legend && (showRampLegend || legendChips.length > 0)}
		<div class="legend">
			{#if showRampLegend}
				<span class="tick">{legendFormat(scaleMin)}</span>
				<div
					class="ramp"
					style:background="linear-gradient(to right, {ramp.join(', ')})"
				></div>
				<span class="tick">{legendFormat(scaleMax)}</span>
			{:else}
				{#each legendChips as chip (chip.color)}
					<span class="chip">
						<span class="swatch" style:background-color={chip.color}></span>
						<span class="chiplabel">{chip.label}</span>
					</span>
				{/each}
			{/if}
		</div>
	{/if}
</div>

{#if node}
	<div
		class="novcard"
		bind:this={cardEl}
		style:left="{card.left}px"
		style:top="{card.top}px"
		style:visibility={card.ready ? 'visible' : 'hidden'}
	>
		<div class="head">
			<span class="name">{node.label}</span>
			{#if node.status}
				<span
					class="pill"
					style:background-color={node.statusColor ?? node.color ?? 'var(--bg-track)'}
				>{node.status}</span>
			{/if}
		</div>

		{#if node.value !== undefined}
			<div class="readout">
				<span class="swatch" style:background-color={colorOf(node)}></span>
				<span class="big">{legendFormat(node.value)}</span>
			</div>
		{/if}

		{#if node.details?.length}
			<div class="details">
				{#each node.details as detail (detail.key)}
					<div class="detail">
						<span class="key">{detail.key}</span>
						<span class="val" class:mono={detail.mono}>{detail.value}</span>
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/if}

<style lang="scss">
	.nov {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.nodes {
		display: grid;
		grid-template-columns: repeat(auto-fill, var(--nov-cell));
		grid-auto-rows: var(--nov-cell);
		gap: var(--nov-gap);
	}

	.node {
		border-radius: 0.125rem;
		transition: transform 0.1s ease;

		// the outline sits outside the cell so the grid does not reflow on hover
		&.active {
			outline: 0.1rem solid var(--text);
			outline-offset: 0.1rem;
			transform: scale(1.15);
		}
	}

	.empty {
		font-size: 0.8125rem;
	}

	.legend {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;

		.tick {
			font-size: 0.6875rem;
			color: var(--text-secondary);
			font-variant-numeric: tabular-nums;
		}

		.ramp {
			flex: 1;
			min-width: 6rem;
			max-width: 16rem;
			height: 0.5rem;
			border-radius: 0.25rem;
		}

		.chip {
			display: flex;
			align-items: center;
			gap: 0.375rem;
		}

		.swatch {
			width: 0.625rem;
			height: 0.625rem;
			border-radius: 0.125rem;
		}

		.chiplabel {
			font-size: 0.6875rem;
			color: var(--text-secondary);
		}
	}

	.novcard {
		position: fixed;
		z-index: 60;
		pointer-events: none;
		min-width: 14rem;
		max-width: 22rem;
		padding: 0.625rem 0.75rem;
		border: 0.1rem solid var(--border);
		border-radius: 0.5rem;
		background: color-mix(in srgb, var(--bg-dropdown) 96%, transparent);
		box-shadow: 0 0.5rem 1.5rem rgb(0 0 0 / 35%);
	}

	.head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.5rem;

		.name {
			font-size: 0.8125rem;
			font-weight: 700;
			color: var(--text);
		}

		.pill {
			padding: 0.125rem 0.375rem;
			border-radius: 0.75rem;
			font-size: 0.625rem;
			font-weight: 700;
			color: var(--text);
		}
	}

	.readout {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		margin-bottom: 0.5rem;

		.swatch {
			width: 0.625rem;
			height: 0.625rem;
			border-radius: 0.125rem;
		}

		.big {
			font-size: 0.875rem;
			font-weight: 700;
			color: var(--text);
			font-variant-numeric: tabular-nums;
		}
	}

	.details {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;

		.detail {
			display: flex;
			justify-content: space-between;
			gap: 1rem;
			font-size: 0.75rem;
		}

		.key {
			color: var(--text-secondary);
		}

		.val {
			color: var(--text);
			font-variant-numeric: tabular-nums;
			text-align: right;

			&.mono {
				font-family: var(--font-mono);
			}
		}
	}
</style>
