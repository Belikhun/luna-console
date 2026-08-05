<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { api, post, patch, del } from '$lib/api';
	import { fmtDateTime } from '$lib/format';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Toggle from '$lib/components/Toggle.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import type { Column } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * Instance schedules, EventBridge-Scheduler style: one-time, cron or rate
	 * triggers firing start/stop/restart across instances, with the full
	 * execution log below. Runs fire in this console's server process.
	 */

	interface Schedule {
		id: string;
		name: string;
		description?: string;
		enabled: boolean;
		action: 'start' | 'stop' | 'restart';
		instances: string[];
		trigger: { kind: 'at'; at: string } | { kind: 'cron'; expr: string } | { kind: 'rate'; minutes: number };
		maxRuns?: number;
		runs: number;
		nextRun?: string;
		lastRunAt?: string;
		lastOutcome?: 'ok' | 'partial' | 'error' | 'missed';
	}

	interface ScheduleEvent {
		seq: number;
		t: number;
		id: string;
		name: string;
		outcome: 'ok' | 'partial' | 'error' | 'missed';
		detail: string;
	}

	let schedules: Schedule[] = $state([]);
	let events: ScheduleEvent[] = $state([]);
	let loading = $state(true);
	let lastUpdated: number | null = $state(null);
	let historyFor: string | null = $state(null);

	async function refresh(): Promise<void> {
		try {
			const data = await api('/schedules');

			schedules = data.schedules;
			events = data.events;
			lastUpdated = Date.now();
		} catch (err) {
			Notify.error(t('web.schedules.loadFailed'), { detail: (err as Error).message });
		}

		loading = false;
	}

	onMount(() => {
		void refresh();
	});

	function triggerText(schedule: Schedule): string {
		const trigger = schedule.trigger;

		if (trigger.kind === 'at') {
			return t('web.schedules.onceAt', { time: fmtDateTime(new Date(trigger.at).getTime()) });
		}

		if (trigger.kind === 'cron') {
			return `cron(${trigger.expr})`;
		}

		return t('web.schedules.everyMin', { minutes: trigger.minutes });
	}

	const OUTCOME_BADGE: Record<string, { state: string; label: string }> = $derived({
		ok: { state: 'passed', label: t('web.schedules.succeeded') },
		partial: { state: 'warning', label: t('web.schedules.partial') },
		error: { state: 'failed', label: t('web.schedules.failed') },
		missed: { state: 'stopped', label: t('web.schedules.missed') }
	});

	async function toggleEnabled(schedule: Schedule, enabled: boolean): Promise<void> {
		try {
			await patch(`/schedules/${schedule.id}`, { enabled });
			await refresh();
		} catch (err) {
			Notify.error(t(enabled ? 'web.schedules.enableFailed' : 'web.schedules.pauseFailed', { name: schedule.name }), {
				detail: (err as Error).message
			});
		}
	}

	async function runNow(schedule: Schedule): Promise<void> {
		const note = Notify.loading(t('web.schedules.runningName', { name: schedule.name }));

		try {
			const result = await post(`/schedules/${schedule.id}`, { action: 'run' });

			note.set({
				level: result.outcome === 'ok' ? 'success' : 'error',
				message: t('web.schedules.ran', { name: schedule.name }),
				detail: result.detail,
				closeable: true
			});

			await refresh();
		} catch (err) {
			note.set({
				level: 'error',
				message: t('web.schedules.runFailed', { name: schedule.name }),
				detail: (err as Error).message,
				closeable: true
			});
		}
	}

	async function remove(schedule: Schedule): Promise<void> {
		try {
			await del(`/schedules/${schedule.id}`);
			Notify.success(t('web.schedules.deleted', { name: schedule.name }));
			await refresh();
		} catch (err) {
			Notify.error(t('web.schedules.deleteFailed', { name: schedule.name }), { detail: (err as Error).message });
		}
	}

	const columns: Column[] = $derived([
		{ id: 'state', label: t('web.schedules.colState'), width: 90 },
		{ id: 'name', label: t('web.common.name'), sortable: true },
		{ id: 'action', label: t('web.schedules.colAction'), width: 100 },
		{ id: 'instances', label: t('web.nav.instancesList') },
		{ id: 'trigger', label: t('web.schedules.colTrigger') },
		{ id: 'next', label: t('web.schedules.colNext'), sortable: true },
		{ id: 'last', label: t('web.schedules.colLast') },
		{ id: 'runs', label: t('web.schedules.colRuns'), width: 90, align: 'right' }
	]);

	/** A schedule's verbs; the row menu and the toolbar's Actions button. */
	function rowActions(schedule: Schedule): ContextMenuItem[] {
		return [
			{ label: t('web.schedules.runNow'), icon: 'play', action: () => runNow(schedule) },
			{
				label: historyFor === schedule.id ? t('web.schedules.showAll') : t('web.schedules.showIts'),
				icon: 'clockRotateLeft',
				action: () => {
					historyFor = historyFor === schedule.id ? null : schedule.id;
				}
			},
			{
				label: schedule.enabled ? t('web.schedules.disable') : t('web.schedules.enable'),
				icon: schedule.enabled ? 'pause' : 'play',
				action: () => toggleEnabled(schedule, !schedule.enabled)
			},
			{ separator: true },
			{
				label: t('web.schedules.delete'),
				icon: 'trash',
				color: 'danger',
				action: () => remove(schedule)
			}
		];
	}

	const scheduleText = (schedule: Schedule): string =>
		[
			schedule.name,
			schedule.description ?? '',
			schedule.action,
			schedule.instances.join(' '),
			triggerText(schedule),
			schedule.enabled ? 'enabled' : 'disabled',
			schedule.lastOutcome ?? ''
		].join(' ');

	const eventCols: Column[] = $derived([
		{ id: 'time', label: t('web.schedules.colTime'), width: 180, sortable: true },
		{ id: 'name', label: t('web.schedules.colSchedule'), sortable: true, width: 220 },
		{ id: 'outcome', label: t('web.schedules.colOutcome'), width: 130 },
		{ id: 'detail', label: t('web.schedules.colDetail') }
	]);

	const shownEvents = $derived(
		historyFor ? events.filter((event) => event.id === historyFor) : events
	);

	let selected: Set<string> = $state(new Set());

	/** The row the header's Actions dropdown acts on. */
	const one = $derived(schedules.find((row: any) => selected.has(row.id)));
</script>

<svelte:head><title>{t('web.nav.schedules')} | Luna Console</title></svelte:head>

<PageHeader
	title={t('web.nav.schedules')}
	count={schedules.length}
	description={t('web.schedules.pageDescription')}
	info
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="schedules" />
		<Dropdown label={t('web.common.actions')} disabled={!one} menu={one ? rowActions(one) : []} />
		<Btn variant="primary" icon="clock" onclick={() => goto('/schedules/new')}>{t('web.schedules.create')}</Btn>
	{/snippet}
</PageHeader>

<Panel flush>
	<ResourceTable
		tableId="schedules"
		initialSearch={page.url.searchParams.get('q') ?? ''}
		{columns}
		rows={schedules}
		getId={(schedule) => schedule.id}
		searchValue={scheduleText}
		searchPlaceholder={t('web.schedules.searchPlaceholder')}
		selectable="single"
		bind:selected
		{rowActions}
		rowLabel={(schedule) => schedule.name}
		noun={t('web.schedules.noun')}
		emptyTitle={t('web.schedules.emptyTitle')}
		emptyText={t('web.schedules.emptyText')}
	>
		{#snippet cell(schedule, col)}
			{#if col === 'state'}
				<Toggle
					checked={schedule.enabled}
					label={t('web.schedules.enabled')}
					onchange={(on) => toggleEnabled(schedule, on)}
				/>
			{:else if col === 'name'}
				<b>{schedule.name}</b>
			{:else if col === 'action'}
				{schedule.action}
			{:else if col === 'instances'}
				<span class="mono">{schedule.instances.join(', ')}</span>
			{:else if col === 'trigger'}
				<span class="mono">{triggerText(schedule)}</span>
			{:else if col === 'next'}
				{#if schedule.nextRun}
					{fmtDateTime(new Date(schedule.nextRun).getTime())}
				{:else}
					<span class="dim">{t('web.schedules.finished')}</span>
				{/if}
			{:else if col === 'last'}
				{#if schedule.lastOutcome}
					<StatusBadge
						state={OUTCOME_BADGE[schedule.lastOutcome]!.state}
						label={OUTCOME_BADGE[schedule.lastOutcome]!.label}
					/>
				{:else}
					<span class="dim">{t('web.schedules.neverRan')}</span>
				{/if}
			{:else if col === 'runs'}
				{schedule.runs}{schedule.maxRuns ? ` / ${schedule.maxRuns}` : ''}
			{/if}
		{/snippet}
	</ResourceTable>
</Panel>

<div class="gap"></div>

<Panel
	title={t('web.schedules.eventLog')}
	count={shownEvents.length}
	description={historyFor
		? t('web.schedules.executionsOf', {
				name: schedules.find((schedule) => schedule.id === historyFor)?.name ?? historyFor
			})
		: t('web.schedules.everyExecution')}
	flush
>
	<ResourceTable
		tableId="schedule-events"
		columns={eventCols}
		rows={shownEvents}
		getId={(event) => String(event.seq)}
		searchPlaceholder={t('web.schedules.findExecution')}
		searchWidth="20rem"
		pageSize={10}
		noun={t('web.schedules.executionNoun')}
		emptyTitle={t('web.schedules.noExecutions')}
		emptyText={t('web.schedules.executionsHint')}
	>
		{#snippet cell(event, col)}
			{#if col === 'time'}
				<span class="mono dim">{fmtDateTime(event.t)}</span>
			{:else if col === 'name'}
				{event.name}
			{:else if col === 'outcome'}
				<StatusBadge
					state={OUTCOME_BADGE[event.outcome]!.state}
					label={OUTCOME_BADGE[event.outcome]!.label}
				/>
			{:else if col === 'detail'}
				<span class="dim">{event.detail}</span>
			{/if}
		{/snippet}
	</ResourceTable>
</Panel>

<style lang="scss">
	.gap {
		height: 1rem;
	}
</style>
