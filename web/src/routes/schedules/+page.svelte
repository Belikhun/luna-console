<script lang="ts">
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
			Notify.error('Could not load schedules', { detail: (err as Error).message });
		}

		loading = false;
	}

	onMount(() => {
		void refresh();
	});

	function triggerText(schedule: Schedule): string {
		const trigger = schedule.trigger;

		if (trigger.kind === 'at') {
			return `once at ${fmtDateTime(new Date(trigger.at).getTime())}`;
		}

		if (trigger.kind === 'cron') {
			return `cron(${trigger.expr})`;
		}

		return `every ${trigger.minutes} min`;
	}

	const OUTCOME_BADGE: Record<string, { state: string; label: string }> = {
		ok: { state: 'passed', label: 'Succeeded' },
		partial: { state: 'warning', label: 'Partial' },
		error: { state: 'failed', label: 'Failed' },
		missed: { state: 'stopped', label: 'Missed' }
	};

	async function toggleEnabled(schedule: Schedule, enabled: boolean): Promise<void> {
		try {
			await patch(`/schedules/${schedule.id}`, { enabled });
			await refresh();
		} catch (err) {
			Notify.error(`Could not ${enabled ? 'enable' : 'pause'} ${schedule.name}`, {
				detail: (err as Error).message
			});
		}
	}

	async function runNow(schedule: Schedule): Promise<void> {
		const note = Notify.loading(`Running ${schedule.name}…`);

		try {
			const result = await post(`/schedules/${schedule.id}`, { action: 'run' });

			note.set({
				level: result.outcome === 'ok' ? 'success' : 'error',
				message: `${schedule.name} ran`,
				detail: result.detail,
				closeable: true
			});

			await refresh();
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not run ${schedule.name}`,
				detail: (err as Error).message,
				closeable: true
			});
		}
	}

	async function remove(schedule: Schedule): Promise<void> {
		try {
			await del(`/schedules/${schedule.id}`);
			Notify.success(`${schedule.name} deleted`);
			await refresh();
		} catch (err) {
			Notify.error(`Could not delete ${schedule.name}`, { detail: (err as Error).message });
		}
	}

	const columns: Column[] = [
		{ id: 'state', label: 'State', width: 90 },
		{ id: 'name', label: 'Name', sortable: true },
		{ id: 'action', label: 'Action', width: 100 },
		{ id: 'instances', label: 'Instances' },
		{ id: 'trigger', label: 'Trigger' },
		{ id: 'next', label: 'Next run', sortable: true },
		{ id: 'last', label: 'Last outcome' },
		{ id: 'runs', label: 'Runs', width: 90, align: 'right' }
	];

	/** A schedule's verbs — the row menu and the toolbar's Actions button. */
	function rowActions(schedule: Schedule): ContextMenuItem[] {
		return [
			{ label: 'Run now', icon: 'play', action: () => runNow(schedule) },
			{
				label: historyFor === schedule.id ? 'Show all executions' : 'Show its executions',
				icon: 'clockRotateLeft',
				action: () => {
					historyFor = historyFor === schedule.id ? null : schedule.id;
				}
			},
			{
				label: schedule.enabled ? 'Disable schedule' : 'Enable schedule',
				icon: schedule.enabled ? 'pause' : 'play',
				action: () => toggleEnabled(schedule, !schedule.enabled)
			},
			{ separator: true },
			{
				label: 'Delete schedule',
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

	const eventCols: Column[] = [
		{ id: 'time', label: 'Time', width: 180, sortable: true },
		{ id: 'name', label: 'Schedule', sortable: true, width: 220 },
		{ id: 'outcome', label: 'Outcome', width: 130 },
		{ id: 'detail', label: 'Detail' }
	];

	const shownEvents = $derived(
		historyFor ? events.filter((event) => event.id === historyFor) : events
	);

	let selected: Set<string> = $state(new Set());

	/** The row the header's Actions dropdown acts on. */
	const one = $derived(schedules.find((row: any) => selected.has(row.id)));
</script>

<svelte:head><title>Schedules | MRDS Console</title></svelte:head>

<PageHeader
	title="Schedules"
	count={schedules.length}
	description="Start, stop or restart instances on a fixed time, a cron expression or a rate — runs fire from the mrds daemon, 24/7"
	info
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="schedules" />
		<Dropdown label="Actions" disabled={!one} menu={one ? rowActions(one) : []} />
		<Btn variant="primary" icon="clock" onclick={() => goto('/schedules/new')}>Create schedule</Btn>
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
		searchPlaceholder="Find a schedule by name, action or instance"
		selectable="single"
		bind:selected
		{rowActions}
		rowLabel={(schedule) => schedule.name}
		noun="schedule"
		emptyTitle="No schedules"
		emptyText="Create one — e.g. a nightly survival restart at 04:30."
	>
		{#snippet cell(schedule, col)}
			{#if col === 'state'}
				<Toggle
					checked={schedule.enabled}
					label="Enabled"
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
					<span class="dim">finished</span>
				{/if}
			{:else if col === 'last'}
				{#if schedule.lastOutcome}
					<StatusBadge
						state={OUTCOME_BADGE[schedule.lastOutcome]!.state}
						label={OUTCOME_BADGE[schedule.lastOutcome]!.label}
					/>
				{:else}
					<span class="dim">never ran</span>
				{/if}
			{:else if col === 'runs'}
				{schedule.runs}{schedule.maxRuns ? ` / ${schedule.maxRuns}` : ''}
			{/if}
		{/snippet}
	</ResourceTable>
</Panel>

<div class="gap"></div>

<Panel
	title="Event log"
	count={shownEvents.length}
	description={historyFor
		? `Executions of ${schedules.find((schedule) => schedule.id === historyFor)?.name ?? historyFor} — click History again for all`
		: 'Every execution, newest first (kept across restarts)'}
	flush
>
	<ResourceTable
		tableId="schedule-events"
		columns={eventCols}
		rows={shownEvents}
		getId={(event) => String(event.seq)}
		searchPlaceholder="Find an execution"
		searchWidth="20rem"
		pageSize={10}
		noun="execution"
		emptyTitle="No executions yet"
		emptyText="Runs land here as schedules fire."
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
