<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { untrack } from 'svelte';

	import { t } from '$lib/i18n.svelte';
	import { fmtDateTime } from '$lib/format';
	import Btn from '$lib/components/Btn.svelte';
	import ChartPanel from '$lib/components/ChartPanel.svelte';
	import DateTime from '$lib/components/DateTime.svelte';
	import DetailPanel from '$lib/components/DetailPanel.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import PlayerName from '$lib/components/PlayerName.svelte';
	import RankedList from '$lib/components/RankedList.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import SeriesTable from '$lib/components/SeriesTable.svelte';
	import StackedBars from '$lib/components/StackedBars.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import type { SeriesStyle } from '$lib/components/chart';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import type { InfoCell } from '$lib/components/grid';
	import type { RankedRow } from '$lib/components/ranked';
	import type { Column, TableFilterGroup } from '$lib/components/table';

	import {
		ACTION_KINDS,
		KIND_COLORS,
		KIND_STATES,
		actionKind,
		actionLabel,
		bucketLog,
		targetHref,
		targetIsAddress,
		type LogEntry
	} from './moderation';

	/**
	 * The network's moderation history: what was done over time, who did it and
	 * to whom, then every entry. The chart and the two lists read the entries
	 * loaded so far, and say so while older ones are still on the proxy.
	 */
	let {
		entries,
		total,
		actions,
		available,
		problem,
		loaded,
		loadingMore,
		initialSearch = '',
		rowActions,
		onloadolder
	}: {
		entries: LogEntry[];
		/** Every entry the proxy holds, loaded or not */
		total: number;
		/** The action ids the log has ever recorded */
		actions: string[];
		available: boolean;
		problem: string;
		loaded: boolean;
		loadingMore: boolean;
		initialSearch?: string;
		rowActions: (entry: LogEntry) => ContextMenuItem[];
		onloadolder: () => void;
	} = $props();

	/** The actor key of entries nobody is recorded for. */
	const NO_ACTOR = '\u0000none';

	// the query a link arrived with; the reader's own typing takes over from there
	let search = $state(untrack(() => initialSearch));
	let selected: Set<string> = $state(new Set());
	let panelLocation = $state<'bottom' | 'right'>('bottom');
	let panelSize = $state(34);

	const partial = $derived(available && entries.length < total);
	const one = $derived(entries.find((entry) => selected.has(String(entry.id))) ?? null);
	const buckets = $derived(bucketLog(entries));

	const styles: Record<string, SeriesStyle> = $derived(
		Object.fromEntries(
			ACTION_KINDS.map((kind) => [kind, { label: t(`web.moderation.kind.${kind}`), color: KIND_COLORS[kind] }])
		)
	);

	const actorRows: RankedRow[] = $derived.by(() => {
		const counts = new Map<string, number>();

		for (const entry of entries) {
			const key = entry.actor || NO_ACTOR;

			counts.set(key, (counts.get(key) ?? 0) + 1);
		}

		return [...counts].map(([key, count]) => ({
			key,
			label: key === NO_ACTOR ? t('web.moderation.log.noActor') : key,
			count
		}));
	});

	const targetRows: RankedRow[] = $derived.by(() => {
		const rows = new Map<string, RankedRow>();

		for (const entry of entries) {
			const key = entry.targetUuid || entry.targetName.toLowerCase();

			if (!key) {
				continue;
			}

			const row = rows.get(key);

			if (row) {
				row.count++;
				continue;
			}

			rows.set(key, {
				key,
				label: entry.targetName || entry.targetUuid,
				count: 1,
				href: targetHref(entry) ?? undefined,
				mono: targetIsAddress(entry)
			});
		}

		return [...rows.values()];
	});

	const chartStatus = $derived(
		!loaded
			? 'loading'
			: buckets
				? 'ready'
				: 'empty'
	);

	const coverage = $derived(
		partial
			? t('web.moderation.log.coverage', { loaded: entries.length, total })
			: undefined
	);

	const columns: Column[] = $derived([
		{ id: 'time', label: t('web.moderation.colTime'), sortable: true, minWidth: 170 },
		{ id: 'action', label: t('web.moderation.colAction'), sortable: true, minWidth: 170 },
		{ id: 'target', label: t('web.moderation.colTarget'), sortable: true, minWidth: 160 },
		{ id: 'actor', label: t('web.moderation.colActor'), sortable: true },
		{ id: 'server', label: t('web.moderation.colServer'), sortable: true },
		{ id: 'reason', label: t('web.access.colReason') },
		{ id: 'details', label: t('web.moderation.colDetails'), hidden: true }
	]);

	const filters: TableFilterGroup<LogEntry>[] = $derived([
		{
			id: 'kind',
			label: t('web.moderation.filterKind'),
			options: [
				{ value: 'any', label: t('web.moderation.anyKind') },
				...ACTION_KINDS.map((kind) => ({
					value: kind,
					label: t(`web.moderation.kind.${kind}`),
					match: (entry: LogEntry) => actionKind(entry.action) === kind
				}))
			]
		},
		{
			id: 'action',
			label: t('web.moderation.filterAction'),
			options: [
				{ value: 'any', label: t('web.moderation.anyAction') },
				...actions.map((action) => ({
					value: action,
					label: actionLabel(action),
					match: (entry: LogEntry) => entry.action === action
				}))
			]
		}
	]);

	const detailCells: InfoCell[] = $derived(
		one
			? [
					{ id: 'action', label: t('web.moderation.colAction') },
					{ id: 'target', label: t('web.moderation.colTarget') },
					{ label: t('web.moderation.colActor'), value: one.actor || '–' },
					{ label: t('web.moderation.colTime'), time: one.atEpochMillis, value: fmtDateTime(one.atEpochMillis) },
					{ label: t('web.moderation.colServer'), value: one.server || '–' },
					{ label: t('web.moderation.log.actionId'), value: one.action, style: 'mono' as const, copyable: true },
					{ label: t('web.access.colReason'), value: one.reason || '–', colSpan: 2 },
					...(one.details
						? [{ label: t('web.moderation.colDetails'), value: one.details, colSpan: 'all' as const }]
						: [])
				]
			: []
	);

	function sortValue(entry: LogEntry, col: string): string | number | null {
		switch (col) {
			case 'time':
				return entry.atEpochMillis;

			case 'action':
				return actionLabel(entry.action).toLowerCase();

			case 'target':
				return entry.targetName.toLowerCase();

			case 'actor':
				return entry.actor.toLowerCase();

			case 'server':
				return entry.server.toLowerCase();

			default:
				return null;
		}
	}

	function wholeCount(value: number): string {
		return String(Math.round(value));
	}
</script>

{#snippet actionCell(entry: LogEntry)}
	{@const kind = actionKind(entry.action)}

	{#if kind === 'other'}
		{actionLabel(entry.action)}
	{:else}
		<StatusBadge state={KIND_STATES[kind]} label={actionLabel(entry.action)} />
	{/if}
{/snippet}

{#snippet targetCell(entry: LogEntry)}
	{#if targetIsAddress(entry)}
		<a href={targetHref(entry)}><b class="mono">{entry.targetName}</b></a>
	{:else if entry.targetUuid || entry.targetName}
		<PlayerName player={entry.targetUuid || entry.targetName} name={entry.targetName || entry.targetUuid} />
	{:else}
		<span class="dim">–</span>
	{/if}
{/snippet}

{#if loaded && !available}
	<Flash kind="warning">
		<b>{t('web.moderation.logUnavailable')}</b>
		{problem}. {t('web.moderation.logNeedsBuild')}
	</Flash>
{/if}

{#if available}
	<div class="summary">
		<ChartPanel
			title={t('web.moderation.log.chartTitle')}
			description={buckets?.weekly ? t('web.moderation.log.perWeek') : t('web.moderation.log.perDay')}
			headline={loaded ? String(entries.length) : undefined}
			status={chartStatus}
			emptyTitle={t('web.moderation.noLogEntries')}
			emptyText={t('web.moderation.logHint')}
			footer={coverage}
			height={11}
		>
			{#snippet table()}
				<SeriesTable series={buckets?.series ?? []} {styles} formatValue={wholeCount} />
			{/snippet}
			{#if buckets}
				<StackedBars
					series={buckets.series}
					label={t('web.moderation.log.chartTitle')}
					{styles}
					from={buckets.from}
					to={buckets.to}
					height={11}
					formatValue={wholeCount}
				/>
			{/if}
		</ChartPanel>

		<Panel title={t('web.moderation.log.byActor')}>
			<RankedList
				rows={actorRows}
				label={t('web.moderation.log.byActor')}
				nameHeader={t('web.moderation.colActor')}
				valueHeader={t('web.moderation.log.colEntries')}
				total={entries.length || undefined}
				limit={6}
				empty={loaded ? t('web.moderation.noLogEntries') : t('web.common.loading')}
				onselect={(row) => {
					if (row.key !== NO_ACTOR) {
						search = row.key;
					}
				}}
			/>
		</Panel>

		<Panel title={t('web.moderation.log.byTarget')}>
			<RankedList
				rows={targetRows}
				label={t('web.moderation.log.byTarget')}
				nameHeader={t('web.moderation.colTarget')}
				valueHeader={t('web.moderation.log.colEntries')}
				limit={6}
				empty={loaded ? t('web.moderation.noLogEntries') : t('web.common.loading')}
			/>
		</Panel>
	</div>
{/if}

<Panel title={t('web.moderation.tabLogs')} count={loaded && available ? total : undefined} flush>
	<ResourceTable
		tableId="moderation-log"
		loading={!loaded}
		{initialSearch}
		bind:search
		{columns}
		rows={entries}
		getId={(entry) => String(entry.id)}
		searchValue={(entry) =>
			`${entry.targetName} ${entry.targetUuid} ${entry.actor} ${entry.action} ${actionLabel(entry.action)} ${entry.server} ${entry.reason} ${entry.details}`}
		searchPlaceholder={t('web.moderation.findLogEntry')}
		noun={t('web.moderation.nounEntry')}
		selectable="single"
		bind:selected
		{sortValue}
		defaultSort={{ col: 'time', dir: 'desc' }}
		{filters}
		{rowActions}
		rowLabel={(entry) => entry.targetName || actionLabel(entry.action)}
		pageSize={25}
		emptyTitle={available ? t('web.moderation.noLogEntries') : t('web.moderation.log.offlineTitle')}
		emptyText={available ? t('web.moderation.logHint') : ''}
	>
		{#snippet cell(entry, col)}
			{#if col === 'time'}
				<DateTime at={entry.atEpochMillis} text={fmtDateTime(entry.atEpochMillis)} />
			{:else if col === 'action'}
				{@render actionCell(entry)}
			{:else if col === 'target'}
				{@render targetCell(entry)}
			{:else if col === 'actor'}
				{entry.actor || '–'}
			{:else if col === 'server'}
				<span class="dim">{entry.server || '–'}</span>
			{:else if col === 'reason'}
				{entry.reason || '–'}
			{:else if col === 'details'}
				<span class="dim">{entry.details || '–'}</span>
			{/if}
		{/snippet}
	</ResourceTable>

	{#if partial}
		<div class="more">
			<span class="dim">
				{t('web.moderation.loadedOf', { loaded: entries.length, total })}
			</span>
			<Btn icon="arrowDown" disabled={loadingMore} onclick={onloadolder}>
				{t('web.moderation.loadOlder')}
			</Btn>
		</div>
	{/if}
</Panel>

{#if one}
	<DetailPanel
		title={actionLabel(one.action)}
		subtitle={one.targetName || undefined}
		href={targetHref(one) ?? undefined}
		hrefLabel={targetIsAddress(one) ? t('web.moderation.log.checkAddress') : t('web.players.viewProfile')}
		bind:location={panelLocation}
		bind:size={panelSize}
		onclose={() => (selected = new Set())}
	>
		<InfoGrid cells={detailCells} columns={[4, 2, 1]}>
			{#snippet custom(info)}
				{#if info.id === 'action'}
					{@render actionCell(one)}
				{:else if info.id === 'target'}
					{@render targetCell(one)}
				{/if}
			{/snippet}
		</InfoGrid>
	</DetailPanel>
{/if}

<style lang="scss">
	// the chart reads left to right and wants the width; the two lists are short
	.summary {
		display: grid;
		grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr);
		gap: 1rem;

		@include below($bp-wide) {
			grid-template-columns: repeat(2, minmax(0, 1fr));

			> :global(:first-child) {
				grid-column: 1 / -1;
			}
		}

		@include below($bp-narrow) {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.more {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: center;
		gap: 0.5rem 1rem;
		padding: 0.75rem 1rem;
		border-top: var(--hairline) solid var(--border-divider);
	}
</style>
