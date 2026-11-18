<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';

	import DateTime from './DateTime.svelte';
	import { fmtMoment, fmtValue, timestamps, valueAt, type Series, type SeriesStyle } from './chart';

	/**
	 * A chart's series as rows of moments, newest first: what `ChartPanel`'s
	 * table view shows, so every value on a plot can be read without hovering.
	 */
	let {
		series,
		styles,
		formatValue
	}: {
		series: Series[];
		styles?: Record<string, SeriesStyle>;
		formatValue?: (value: number) => string;
	} = $props();

	const times = $derived(timestamps(series).reverse());
	const span = $derived(times.length > 1 ? times[0]! - times.at(-1)! : 0);

	function cell(entry: Series, at: number): string {
		const value = valueAt(entry, at);

		if (value === null) {
			return '–';
		}

		return formatValue
			? formatValue(value)
			: fmtValue(value, entry.unit);
	}
</script>

<table class="series-table">
	<thead>
		<tr>
			<th scope="col">{t('web.chart.time')}</th>
			{#each series as entry (entry.key)}
				<th scope="col" class="num">{styles?.[entry.key]?.label ?? entry.key}</th>
			{/each}
		</tr>
	</thead>
	<tbody>
		{#each times as at (at)}
			<tr>
				<th scope="row"><DateTime {at} text={fmtMoment(at, span)} /></th>
				{#each series as entry (entry.key)}
					<td class="num">{cell(entry, at)}</td>
				{/each}
			</tr>
		{/each}
	</tbody>
</table>

<style lang="scss">
	.series-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.8125rem;
	}

	th,
	td {
		padding: 0.25rem 0.75rem;
		text-align: left;
		border-bottom: var(--hairline) solid var(--border-divider);
		white-space: nowrap;
	}

	thead th {
		position: sticky;
		top: 0;
		background: var(--bg-table-header);
		font-weight: 700;
		color: var(--text-label);
	}

	tbody th {
		font-weight: 400;
		color: var(--text-secondary);
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
</style>
