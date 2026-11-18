<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->
<script lang="ts">
	import { untrack } from 'svelte';

	import { t } from '$lib/i18n.svelte';
	import { api } from '$lib/api';
	import ChartPanel from '$lib/components/ChartPanel.svelte';
	import EventsTable from '$lib/components/EventsTable.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import RankedList from '$lib/components/RankedList.svelte';
	import StackedBars from '$lib/components/StackedBars.svelte';
	import StatGrid from '$lib/components/StatGrid.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import type { SeriesStyle } from '$lib/components/chart';
	import { enrichEvents, type InstanceEvent } from '$lib/components/events';
	import { instanceTabPath } from '$lib/components/instancetabs';
	import type { RankedRow } from '$lib/components/ranked';
	import type { MetricsRange } from '$shared/metricsrange';
	import { eventBuckets, isUnaskedStop } from './fleet';

	/**
	 * The Monitoring page's Events tab: every instance's and every machine's
	 * events inside the page's window, counted, drawn over time, ranked by where
	 * they happened, then listed with who caused each and why.
	 */
	let {
		range
	}: {
		range: MetricsRange;
	} = $props();

	let events = $state.raw<InstanceEvent[]>([]);
	let bounds = $state.raw<{ from: number; to: number } | null>(null);
	let loaded = $state<MetricsRange | null>(null);
	let status = $state<'loading' | 'ready' | 'error'>('loading');
	let failure = $state('');

	/** Read the window's events; the page's refresh calls this. */
	export async function load(): Promise<void> {
		const asked = range;

		if (loaded !== asked) {
			status = 'loading';
		}

		try {
			const data = await api(`/events?range=${asked}`);

			if (asked !== range) {
				return;
			}

			events = data.events;
			bounds = { from: data.from, to: data.to };
			loaded = asked;
			status = 'ready';
			failure = '';
		} catch (err) {
			failure = (err as Error).message;
			status = 'error';
		}
	}

	$effect(() => {
		void range;
		untrack(() => void load());
	});

	// the same reading the table gives them, so a stop is counted as unasked only where the table says so
	const read = $derived(enrichEvents(events));

	const counts = $derived({
		state: read.filter((event) => event.kind === 'state').length,
		action: read.filter((event) => event.kind === 'action').length,
		error: read.filter((event) => event.kind === 'error').length,
		unasked: read.filter(isUnaskedStop).length
	});

	const fresh = $derived(status === 'loading' && loaded === null);
	const buckets = $derived(bounds ? eventBuckets(read, bounds.from, bounds.to) : []);

	const kindStyles = $derived<Record<string, SeriesStyle>>({
		state: { label: t('web.events.kind.state'), color: 'var(--chart-1)' },
		action: { label: t('web.events.kind.action'), color: 'var(--chart-muted)' },
		error: { label: t('web.events.kind.error'), color: 'var(--error)' }
	});

	const sources = $derived.by((): RankedRow[] => {
		const tally = new Map<string, { count: number; errors: number }>();

		for (const event of read) {
			const key = event.instance ?? '';
			const entry = tally.get(key) ?? { count: 0, errors: 0 };

			entry.count++;

			if (event.kind === 'error' || isUnaskedStop(event)) {
				entry.errors++;
			}

			tally.set(key, entry);
		}

		return [...tally.entries()]
			.filter(([key]) => key !== '')
			.map(([key, entry]): RankedRow => {
				const machine = key.startsWith('daemon:')
					? key.slice(7)
					: null;

				return {
					key,
					label: machine ?? key,
					icon: machine ? 'server' : 'cube',
					count: entry.count,
					href: machine
						? `/machines/${encodeURIComponent(machine)}`
						: instanceTabPath(key, 'monitoring'),
					secondary: entry.errors > 0
						? t('web.fleet.eventsProblems', { count: String(entry.errors) })
						: undefined,
					tone: entry.errors > 0
						? 'warning'
						: undefined
				};
			})
			.sort((left, right) => right.count - left.count);
	});

	const rangeLabel = $derived(t(`web.monitor.rangeLabel.${range}`));
</script>

<div class="events">
	<StatGrid>
		<StatTile label={t('web.events.title')} value={fresh ? null : read.length} loading={fresh} secondary={rangeLabel} />
		<StatTile label={t('web.events.kind.state')} value={fresh ? null : counts.state} loading={fresh} />
		<StatTile label={t('web.events.kind.action')} value={fresh ? null : counts.action} loading={fresh} />
		<StatTile
			label={t('web.events.kind.error')}
			value={fresh ? null : counts.error}
			loading={fresh}
			tone={counts.error > 0 ? 'critical' : 'default'}
		/>
		<StatTile
			label={t('web.fleet.unaskedStops')}
			info={t('web.fleet.unaskedStopsInfo')}
			value={fresh ? null : counts.unasked}
			loading={fresh}
			tone={counts.unasked > 0 ? 'warning' : 'default'}
		/>
	</StatGrid>

	<div class="split">
		<ChartPanel
			title={t('web.fleet.eventsChart')}
			description={rangeLabel}
			status={status === 'ready' && read.length === 0 ? 'empty' : loaded === null ? status : 'ready'}
			emptyTitle={t('web.fleet.eventsNone')}
			emptyText={t('web.instances.events.noneHint')}
			error={failure}
			onretry={() => void load()}
			stale={status === 'loading' && loaded !== null}
			height={11}
		>
			<StackedBars
				series={buckets}
				label={t('web.fleet.eventsChart')}
				styles={kindStyles}
				from={bounds?.from}
				to={bounds?.to}
				height={11}
			/>
		</ChartPanel>

		<Panel title={t('web.fleet.eventsBySource')} description={rangeLabel}>
			<RankedList
				rows={sources}
				label={t('web.fleet.eventsBySource')}
				total={read.length}
				limit={6}
				empty={fresh ? t('web.chart.loading') : t('web.fleet.eventsNone')}
			/>
		</Panel>
	</div>

	<Panel title={t('web.events.title')} count={read.length} description={rangeLabel} flush>
		<EventsTable
			tableId="monitoring-events"
			{events}
			instanceColumn
			loading={fresh}
			maxHeight="40rem"
			emptyTitle={status === 'error' ? t('web.fleet.eventsFailed') : t('web.fleet.eventsNone')}
			emptyText={status === 'error' ? failure : t('web.instances.events.noneHint')}
		/>
	</Panel>
</div>

<style lang="scss">
	.events {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.split {
		display: grid;
		grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
		gap: 1rem;

		@include below($bp-medium) {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
