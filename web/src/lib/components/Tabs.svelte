<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { onMount } from 'svelte';

	/**
	 * A tab bar. A tab carrying an `href` is rendered as a real link rather than a
	 * button, which is what lets it be opened in a new tab, copied, or named in a
	 * breadcrumb; without one it stays a button that only flips `active`.
	 *
	 * Both shapes are kept because not every tab bar addresses a URL - some sit
	 * inside a dialog, where there is nowhere to navigate to.
	 *
	 * Tabs that do not fit one line wrap into rows the way a Windows property
	 * sheet does: the row holding the active tab is drawn last, against the
	 * content it labels, and the other rows keep their cyclic order above it.
	 */
	let {
		tabs,
		active = $bindable()
	}: {
		tabs: Array<{ id: string; label: string; href?: string }>;
		active: string;
	} = $props();

	type Tab = (typeof tabs)[number];

	let bar: HTMLDivElement | undefined = $state();
	let measurer: HTMLDivElement | undefined = $state();
	let barWidth = $state(0);

	// device pixels, read off the hidden single-line copy; empty until mounted,
	// which keeps the server render (and a bar inside a closed dialog) on one
	// plain wrapping row
	let widths: number[] = $state([]);
	let gapPx = $state(0);

	function measure(): void {
		if (!measurer || !bar) {
			return;
		}

		const cells = Array.from(measurer.children) as HTMLElement[];

		widths = cells.map((cell) => cell.getBoundingClientRect().width);
		gapPx = parseFloat(getComputedStyle(bar).columnGap) || 0;
	}

	onMount(() => {
		// Albula arrives after the first paint, and its glyphs are wider than the fallback's
		void document.fonts?.ready.then(measure);
	});

	$effect(() => {
		// a locale switch relabels every tab, so the widths follow the labels
		void tabs.map((tab) => tab.label).join('\u0000');
		measure();
	});

	/** Greedy rows: each tab goes on the current row while it fits. */
	const rows: Tab[][] = $derived.by(() => {
		if (barWidth <= 0 || widths.length !== tabs.length) {
			return [tabs];
		}

		const out: Tab[][] = [];
		let row: Tab[] = [];
		let used = 0;

		tabs.forEach((tab, index) => {
			const width = widths[index] ?? 0;
			const needed = row.length === 0
				? width
				: used + gapPx + width;

			// clientWidth is a rounded integer and the widths are not; half a pixel of
			// slack keeps a row that fits exactly from wrapping its last tab
			if (row.length > 0 && needed > barWidth + 0.5) {
				out.push(row);
				row = [tab];
				used = width;

				return;
			}

			row.push(tab);
			used = needed;
		});

		if (row.length > 0) {
			out.push(row);
		}

		return out;
	});

	/** The rows top to bottom: rotated so the active tab's row is the last one. */
	const ordered: Tab[][] = $derived.by(() => {
		const at = rows.findIndex((row) => row.some((tab) => tab.id === active));

		if (at < 0 || at === rows.length - 1) {
			return rows;
		}

		return [...rows.slice(at + 1), ...rows.slice(0, at + 1)];
	});

	const wrapped = $derived(rows.length > 1);
</script>

{#snippet tabCell(tab: Tab)}
	{#if tab.href}
		<a
			role="tab"
			class="tab"
			class:active={active === tab.id}
			aria-selected={active === tab.id}
			href={tab.href}
		>{tab.label}</a>
	{:else}
		<button
			role="tab"
			class="tab"
			class:active={active === tab.id}
			aria-selected={active === tab.id}
			onclick={() => (active = tab.id)}
		>{tab.label}</button>
	{/if}
{/snippet}

<div class="tabs" class:wrapped role="tablist" bind:this={bar} bind:clientWidth={barWidth}>
	<div class="measure" aria-hidden="true" bind:this={measurer}>
		{#each tabs as tab (tab.id)}
			<span class="tab">{tab.label}</span>
		{/each}
	</div>

	{#each ordered as row, index (row[0]?.id ?? index)}
		<div class="row" role="presentation">
			{#each row as tab (tab.id)}
				{@render tabCell(tab)}
			{/each}
		</div>
	{/each}
</div>

<style lang="scss">
	// The active indicator is a 0.25rem bar overlapping the container's bottom
	// rule, so the indicator lives inside the tab and the rule sits under it.
	.tabs {
		position: relative;
		display: flex;
		flex-direction: column;
		column-gap: 0.5rem;
		border-bottom: 0.1rem solid var(--border-divider);
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;

		// a back row is still a row of tabs, just not the one the content belongs to
		.wrapped &:not(:last-of-type) {
			border-bottom: 0.1rem solid var(--border-divider);
		}

		// every wrapped row spans the bar, as a property sheet's do, so the rows
		// read as stacked strips rather than a ragged paragraph of labels
		.wrapped & > .tab {
			flex: 1 1 auto;
			text-align: center;
		}
	}

	// the unconstrained single-line copy the rows are packed from; it takes no
	// space and is never seen, but keeps the tabs' own metrics
	.measure {
		position: absolute;
		top: 0;
		left: 0;
		display: flex;
		width: max-content;
		height: 0;
		overflow: hidden;
		visibility: hidden;
		pointer-events: none;
	}

	// `a.tab` opts out of the chrome-link styling on purpose: a tab is chrome, and
	// the underline convention is for links that navigate *within* content
	.tab {
		position: relative;
		display: inline-block;
		background: none;
		border: none;
		color: var(--text-heading);
		font-family: var(--font);
		font-size: 0.875rem;
		font-weight: 700;
		padding: 0.625rem 1rem;
		cursor: pointer;
		white-space: nowrap;
		text-decoration: none;

		&::after {
			content: '';
			position: absolute;
			left: 0;
			right: 0;
			bottom: 0;
			height: 0.25rem;
			background: transparent;
		}

		&:hover {
			color: var(--link);
		}

		&.active {
			color: var(--link);

			&::after {
				background: var(--link);
			}
		}
	}
</style>
