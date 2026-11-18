<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import type { Snippet } from 'svelte';

	import { t } from '$lib/i18n.svelte';

	import Btn from './Btn.svelte';
	import Flash from './Flash.svelte';
	import Icon from './Icon.svelte';
	import Panel from './Panel.svelte';
	import Spinner from './Spinner.svelte';
	import type { PopoverDetail } from './statusbadge';

	/**
	 * A `Panel` holding one chart, with the states every chart has drawn at the
	 * chart's own height so nothing jumps: loading, nothing in the range (why,
	 * and what makes data appear), failed (a `Flash` with Retry), and denied (the
	 * action the account lacks; nothing is fetched). A reload keeps the previous
	 * drawing at reduced opacity rather than flashing a spinner.
	 *
	 * The title row carries the headline figure, the panel's own toggles
	 * (`actions`), a text link to the view behind the chart (`href`), and, with
	 * a `table` snippet, a switch to the same data as a table.
	 */
	let {
		title,
		description,
		info,
		headline,
		href,
		hrefLabel,
		status = 'ready',
		emptyTitle,
		emptyText,
		error,
		onretry,
		deniedAction,
		deniedScope = 'instance',
		stale = false,
		height = 10,
		footer,
		guide,
		actions,
		table,
		children
	}: {
		title: string;
		/** A quiet line under the title: the span a small chart covers ("last hour") */
		description?: string;
		/** How the figure is measured, behind the title's dashed underline */
		info?: PopoverDetail;
		/** The figure beside the title: the latest value, the range's total */
		headline?: string;
		/** The view behind the chart ("View requests") */
		href?: string;
		hrefLabel?: string;
		status?: 'ready' | 'loading' | 'empty' | 'error' | 'denied';
		/** The empty state's first line: why there is nothing */
		emptyTitle?: string;
		/** Its second line: what makes data appear; under a denial, what the action guards */
		emptyText?: string;
		/** What went wrong, for the error state */
		error?: string;
		onretry?: () => void;
		/** The IAM action the account lacks, for the denied state */
		deniedAction?: string;
		/** Whether that action is checked against the instance or console-wide */
		deniedScope?: 'instance' | 'console';
		/** A reload is under way; the drawing stays and dims */
		stale?: boolean;
		/** The body's height in rem while it has no chart, matching the chart's */
		height?: number;
		/** A quiet line under the chart: "Measured 82% of this range" */
		footer?: string | Snippet;
		/** `data-guide` area name, for Mèo Béo's spotlight */
		guide?: string;
		actions?: Snippet;
		table?: Snippet;
		children: Snippet;
	} = $props();

	let view: 'chart' | 'table' = $state('chart');

	const deniedParts = $derived(
		(deniedScope === 'console'
			? t('web.monitoring.state.deniedConsole', { action: '\u0000' })
			: t('web.monitoring.state.denied', { action: '\u0000' })
		).split('\u0000')
	);
</script>

<div class="chart-panel" data-guide={guide} aria-busy={status === 'loading' || stale}>
	<Panel {title} {info} {description} fill>
		{#snippet actions()}
			{#if headline && status === 'ready'}
				<span class="headline">{headline}</span>
			{/if}
			{#if panelActions && status === 'ready'}
				{@render panelActions()}
			{/if}
			{#if table && status === 'ready'}
				<Btn
					variant="icon"
					icon={view === 'chart' ? 'table' : 'chartLine'}
					title={view === 'chart' ? t('web.chart.showTable') : t('web.chart.showChart')}
					onclick={() => (view = view === 'chart' ? 'table' : 'chart')}
				/>
			{/if}
			{#if href && status !== 'denied'}
				<a class="view-link" {href}>{hrefLabel ?? t('web.chart.view')}</a>
			{/if}
		{/snippet}

		{#if status === 'loading'}
			<div class="placeholder" style:height="{height}rem">
				<Spinner size="1.25rem" />
				<span>{t('web.chart.loading')}</span>
			</div>
		{:else if status === 'error'}
			<div class="placeholder error" style:height="{height}rem">
				<Flash kind="error">{error ?? t('web.chart.failed')}</Flash>
				{#if onretry}
					<Btn icon="arrowRotateRight" onclick={onretry}>{t('web.chart.retry')}</Btn>
				{/if}
			</div>
		{:else if status === 'empty'}
			<div class="placeholder" style:height="{height}rem">
				<span class="glyph"><Icon name="chartLine" /></span>
				<span class="why">{emptyTitle ?? t('web.monitoring.empty.noSamples')}</span>
				{#if emptyText}
					<span class="how">{emptyText}</span>
				{/if}
			</div>
		{:else if status === 'denied'}
			<div class="placeholder" style:height="{height}rem">
				<span class="glyph"><Icon name="lock" /></span>
				<span class="why">{deniedParts[0]}<code>{deniedAction ?? ''}</code>{deniedParts[1] ?? ''}</span>
				{#if emptyText}
					<span class="how">{emptyText}</span>
				{/if}
			</div>
		{:else}
			<div class="body" class:stale>
				{#if view === 'table' && table}
					<div class="table-view">{@render table()}</div>
				{:else}
					{@render children()}
				{/if}
			</div>
			{#if typeof footer === 'function'}
				<p class="footer">{@render footer()}</p>
			{:else if footer}
				<p class="footer">{footer}</p>
			{/if}
		{/if}
	</Panel>
</div>

<!-- the caller's `actions` snippet, renamed so the Panel's own slot can wrap it -->
{#snippet panelActions()}
	{#if actions}
		{@render actions()}
	{/if}
{/snippet}

<style lang="scss">
	// a grid row stretches the cell, and the panel fills it, so two charts side by
	// side stay level when only one of them has a legend
	.chart-panel {
		min-width: 0;
	}

	.headline {
		font-size: 1rem;
		font-weight: 700;
		color: var(--text-heading);
	}

	.view-link {
		font-size: 0.8125rem;
		white-space: nowrap;
	}

	.placeholder {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.375rem;
		padding: 0 1rem;
		font-size: 0.8125rem;
		color: var(--text-secondary);
		text-align: center;

		.glyph {
			font-size: 1.25rem;
			color: var(--text-disabled);
		}

		.why {
			color: var(--text);
		}

		.how {
			max-width: 28rem;
		}

		code {
			font-family: var(--font-mono);
			font-size: 0.75rem;
			padding: 0 0.25rem;
			border-radius: 0.25rem;
			background: var(--bg-hover);
		}

		&.error {
			align-items: stretch;
			gap: 0.75rem;

			:global(.btn) {
				align-self: center;
			}
		}
	}

	.body {
		min-width: 0;
		transition: opacity 0.15s ease;

		&.stale {
			opacity: 0.5;
		}
	}

	.table-view {
		max-height: 20rem;
		overflow: auto;
	}

	.footer {
		margin: 0.5rem 0 0;
		font-size: 0.75rem;
		color: var(--text-secondary);
	}
</style>
