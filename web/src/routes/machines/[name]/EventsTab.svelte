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
	import SegmentedControl from '$lib/components/SegmentedControl.svelte';
	import StackedBars from '$lib/components/StackedBars.svelte';
	import StatGrid from '$lib/components/StatGrid.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import type { SeriesStyle } from '$lib/components/chart';
	import { enrichEvents, type InstanceEvent } from '$lib/components/events';
	import { METRICS_RANGES, type MetricsRange } from '$shared/metricsrange';
	import { eventBuckets } from '../../monitoring/fleet';

	/**
	 * A machine's Events tab: what happened to its daemon inside a window
	 * (its link coming and going, checks failing, upgrades), counted, drawn over
	 * time, then listed with who caused each.
	 */
	let {
		name
	}: {
		name: string;
	} = $props();

	let range = $state<MetricsRange>('24h');
	let events = $state.raw<InstanceEvent[]>([]);
	let bounds = $state.raw<{ from: number; to: number } | null>(null);
	let loaded = $state<string | null>(null);
	let status = $state<'loading' | 'ready' | 'error'>('loading');
	let failure = $state('');

	/** Read the window's events; the screen's refresh calls this. */
	export async function load(): Promise<void> {
		const asked = range;
		const machine = name;
		const key = `${machine}\n${asked}`;

		if (loaded !== key) {
			status = 'loading';
		}

		try {
			const data = await api(`/events?instance=${encodeURIComponent(`daemon:${machine}`)}&range=${asked}`);

			if (asked !== range || machine !== name) {
				return;
			}

			events = data.events;
			bounds = { from: data.from, to: data.to };
			loaded = key;
			status = 'ready';
			failure = '';
		} catch (err) {
			failure = (err as Error).message;
			status = 'error';
		}
	}

	$effect(() => {
		void range;
		void name;
		untrack(() => void load());
	});

	const read = $derived(enrichEvents(events));

	const counts = $derived({
		state: read.filter((event) => event.kind === 'state').length,
		action: read.filter((event) => event.kind === 'action').length,
		error: read.filter((event) => event.kind === 'error').length
	});

	const fresh = $derived(status === 'loading' && loaded === null);
	const buckets = $derived(bounds ? eventBuckets(read, bounds.from, bounds.to) : []);
	const rangeLabel = $derived(t(`web.monitor.rangeLabel.${range}`));
	const rangeOptions = $derived(METRICS_RANGES.map((id) => ({ id, label: t(`web.monitor.ranges.${id}`) })));

	const kindStyles = $derived<Record<string, SeriesStyle>>({
		state: { label: t('web.events.kind.state'), color: 'var(--chart-1)' },
		action: { label: t('web.events.kind.action'), color: 'var(--chart-muted)' },
		error: { label: t('web.events.kind.error'), color: 'var(--error)' }
	});
</script>

<div class="events">
	<div class="toolbar">
		<SegmentedControl
			label={t('web.monitor.range')}
			value={range}
			options={rangeOptions}
			onchange={(id) => (range = id as MetricsRange)}
		/>
	</div>

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
	</StatGrid>

	<ChartPanel
		title={t('web.fleet.eventsChart')}
		description={rangeLabel}
		status={status === 'ready' && read.length === 0 ? 'empty' : loaded === null ? status : 'ready'}
		emptyTitle={t('web.fleet.eventsNone')}
		emptyText={t('web.machineDetail.eventsHint')}
		error={failure}
		onretry={() => void load()}
		stale={status === 'loading' && loaded !== null}
		height={9}
	>
		<StackedBars
			series={buckets}
			label={t('web.fleet.eventsChart')}
			styles={kindStyles}
			from={bounds?.from}
			to={bounds?.to}
			height={9}
		/>
	</ChartPanel>

	<Panel title={t('web.events.title')} count={read.length} description={rangeLabel} flush>
		<EventsTable
			tableId="machine-events"
			{events}
			loading={fresh}
			maxHeight="40rem"
			emptyTitle={status === 'error' ? t('web.fleet.eventsFailed') : t('web.fleet.eventsNone')}
			emptyText={status === 'error' ? failure : t('web.machineDetail.eventsHint')}
		/>
	</Panel>
</div>

<style lang="scss">
	.events {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.toolbar {
		display: flex;
		justify-content: flex-end;
	}
</style>
