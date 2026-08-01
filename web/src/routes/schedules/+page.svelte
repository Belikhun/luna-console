<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { api, post, patch, del } from '$lib/api';
	import { fmtDateTime } from '$lib/format';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Toggle from '$lib/components/Toggle.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import type { Column } from '$lib/components/table';
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
		{ id: 'runs', label: 'Runs', width: 90, align: 'right' },
		{ id: 'controls', label: '', width: 210 }
	];

	const eventCols: Column[] = [
		{ id: 'time', label: 'Time', width: 180, sortable: true },
		{ id: 'name', label: 'Schedule', sortable: true, width: 220 },
		{ id: 'outcome', label: 'Outcome', width: 130 },
		{ id: 'detail', label: 'Detail' }
	];

	const shownEvents = $derived(
		historyFor ? events.filter((event) => event.id === historyFor) : events
	);
</script>

<svelte:head><title>Schedules | MRDS Console</title></svelte:head>

<PageHeader
	title="Schedules"
	count={schedules.length}
	description="Start, stop or restart instances on a fixed time, a cron expression or a rate — runs fire while the console server is up"
	info
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="schedules" />
		<Btn variant="primary" icon="clock" onclick={() => goto('/schedules/new')}>Create schedule</Btn>
	{/snippet}
</PageHeader>

<Panel flush>
	<DataTable
		{columns}
		rows={schedules}
		getId={(schedule) => schedule.id}
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
			{:else if col === 'controls'}
				<span class="controls">
					<Btn onclick={() => runNow(schedule)}>Run now</Btn>
					<Btn onclick={() => (historyFor = historyFor === schedule.id ? null : schedule.id)}>
						History
					</Btn>
					<Btn variant="icon" icon="trash" title="Delete" onclick={() => remove(schedule)} />
				</span>
			{/if}
		{/snippet}
	</DataTable>
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
	<DataTable
		columns={eventCols}
		rows={shownEvents}
		getId={(event) => String(event.seq)}
		maxHeight="30rem"
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
	</DataTable>
</Panel>

<style lang="scss">
	.gap {
		height: 1rem;
	}

	.controls {
		display: inline-flex;
		gap: 0.375rem;
	}
</style>
