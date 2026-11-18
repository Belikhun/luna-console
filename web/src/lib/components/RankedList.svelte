<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';

	import { fmtValue, type SeriesUnit } from './chart';
	import Icon from './Icon.svelte';
	import { middleCut, type RankedRow } from './ranked';

	/**
	 * Top N of something, largest first: each row a name, its count and its
	 * share, with a faint fill behind the row as long as its count against the
	 * largest. The fill sits behind the text rather than on a line of its own,
	 * so the list stays dense. The rows are nominal, so every fill is the same
	 * hue; a row that is a problem says so with an icon.
	 *
	 * Rows with an `href` are links over their whole width. "Show more" grows
	 * the list from `limit` to `expandTo`.
	 */
	let {
		rows,
		label,
		total,
		unit = 'count',
		limit = 10,
		expandTo = 50,
		empty,
		nameHeader,
		valueHeader,
		onselect,
		formatValue
	}: {
		rows: RankedRow[];
		/** What the list ranks, for screen readers */
		label: string;
		/** The whole the rows are part of; each row then shows its share */
		total?: number;
		unit?: SeriesUnit;
		limit?: number;
		expandTo?: number;
		/** Said in place of the list when it has no rows */
		empty?: string;
		nameHeader?: string;
		valueHeader?: string;
		/** A row without an `href` was chosen */
		onselect?: (row: RankedRow) => void;
		formatValue?: (value: number) => string;
	} = $props();

	let expanded = $state(false);

	const sorted = $derived([...rows].sort((a, b) => b.count - a.count));
	const shown = $derived(sorted.slice(0, expanded ? expandTo : limit));
	const largest = $derived(Math.max(1, sorted[0]?.count ?? 1));

	function format(value: number): string {
		return formatValue
			? formatValue(value)
			: fmtValue(value, unit);
	}

	function share(count: number): string | null {
		if (!total) {
			return null;
		}

		const pct = (count / total) * 100;

		return pct >= 10
			? `${Math.round(pct)}%`
			: `${Math.round(pct * 10) / 10}%`;
	}
</script>

{#snippet content(row: RankedRow)}
	<span class="fill" style:width="{(row.count / largest) * 100}%"></span>
	<span class="name">
		{#if row.tone}
			<span class="tone" data-tone={row.tone}><Icon name="triangleExclamation" /></span>
		{:else if row.icon}
			<span class="icon"><Icon name={row.icon} /></span>
		{/if}
		{#if row.mono}
			{@const cut = middleCut(row.label ?? row.key)}
			<span class="text mono"><span class="head">{cut.head}</span><span class="tail">{cut.tail}</span></span>
		{:else}
			<span class="text">{row.label ?? row.key}</span>
		{/if}
	</span>
	{#if row.secondary}
		<span class="secondary">{row.secondary}</span>
	{/if}
	<span class="count">{format(row.count)}</span>
	{#if total}
		<span class="share">{share(row.count)}</span>
	{/if}
{/snippet}

<div class="ranked-list">
	{#if sorted.length === 0}
		<p class="empty">{empty ?? t('web.chart.noneInRange')}</p>
	{:else}
		{#if nameHeader || valueHeader}
			<div class="header" aria-hidden="true">
				<span>{nameHeader ?? ''}</span>
				<span>{valueHeader ?? ''}</span>
			</div>
		{/if}

		<ol aria-label={label}>
			{#each shown as row (row.key)}
				<li>
					{#if row.href}
						<a class="row" href={row.href}>{@render content(row)}</a>
					{:else if onselect}
						<button type="button" class="row" onclick={() => onselect?.(row)}>{@render content(row)}</button>
					{:else}
						<div class="row">{@render content(row)}</div>
					{/if}
				</li>
			{/each}
		</ol>

		{#if sorted.length > limit}
			<button type="button" class="more" onclick={() => (expanded = !expanded)} aria-expanded={expanded}>
				{expanded
					? t('web.chart.showFewer')
					: t('web.chart.showMore', { count: String(Math.min(sorted.length, expandTo) - limit) })}
			</button>
		{/if}
	{/if}
</div>

<style lang="scss">
	.ranked-list {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
	}

	.header {
		display: flex;
		justify-content: space-between;
		padding: 0 0.5rem 0.25rem;
		font-size: 0.75rem;
		font-weight: 700;
		color: var(--text-label);
	}

	ol {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.row {
		@include bare-button;

		position: relative;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		min-height: 1.75rem;
		padding: 0.25rem 0.5rem;
		border-radius: 0.375rem;
		overflow: hidden;
		text-align: left;
		text-decoration: none;
		color: var(--text);
		cursor: default;
	}

	a.row,
	button.row {
		cursor: pointer;

		&:hover {
			background: var(--bg-hover);
			color: var(--text);

			.text {
				text-decoration: underline;
				text-underline-offset: 0.25rem;
			}
		}

		&:focus-visible {
			@include focus-ring;
		}
	}

	// the row's size against the largest row: a faint wash behind the text
	.fill {
		position: absolute;
		top: 0;
		bottom: 0;
		left: 0;
		background: var(--chart-1);
		opacity: 0.1;
		border-radius: 0.375rem;
		pointer-events: none;
	}

	.name {
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.375rem;
		flex: 1 1 auto;
		min-width: 0;
	}

	.text {
		@include ellipsis;

		font-size: 0.8125rem;

		&.mono {
			display: flex;
			font-family: var(--font-mono);
			font-size: 0.75rem;
		}

		.head {
			@include ellipsis;
		}

		.tail {
			flex: none;
			white-space: pre;
		}
	}

	.tone,
	.icon {
		flex: none;
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.tone {
		color: var(--warning);

		&[data-tone='critical'] {
			color: var(--error);
		}
	}

	.secondary,
	.share {
		position: relative;
		flex: none;
		font-size: 0.75rem;
		color: var(--text-secondary);
		font-variant-numeric: tabular-nums;
	}

	.share {
		width: 2.75rem;
		text-align: right;
	}

	.count {
		position: relative;
		flex: none;
		font-size: 0.8125rem;
		color: var(--text);
		font-variant-numeric: tabular-nums;
	}

	.empty {
		margin: 0;
		padding: 1rem 0.5rem;
		font-size: 0.8125rem;
		color: var(--text-secondary);
	}

	.more {
		@include bare-button;

		align-self: flex-start;
		margin: 0.25rem 0.5rem 0;
		font-size: 0.8125rem;
		color: var(--link);

		&:hover {
			color: var(--link-hover);
			text-decoration: underline;
		}

		&:focus-visible {
			@include focus-ring;
		}
	}
</style>
