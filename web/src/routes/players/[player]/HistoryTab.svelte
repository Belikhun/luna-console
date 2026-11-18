<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { untrack } from 'svelte';
	import { t } from '$lib/i18n.svelte';
	import { api } from '$lib/api';
	import { LOG_PAGE, loadWholeLog } from '$lib/log';
	import { fmtDuration, fmtDateTime } from '$lib/format';
	import { playPointsOf } from '$lib/players';
	import ScreenLink from '$lib/components/ScreenLink.svelte';
	import CalendarGraph from '$lib/components/CalendarGraph.svelte';
	import type { CalendarDay } from '$lib/components/calendargraph';
	import type { OverviewDetail } from '$lib/components/nodeoverview';
	import DateTime from '$lib/components/DateTime.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import type { Session } from './player';

	/** A player's play history: the calendar of days played, and every session under it. */
	let {
		player,
		active,
		refreshKey
	}: {
		/** The uuid or name the profile was opened with */
		player: string;
		/** Whether this tab is the one on screen; a hidden tab waits for its turn to reload */
		active: boolean;
		/** Bumped by the screen on each refresh */
		refreshKey: number;
	} = $props();

	let sessions: Session[] = $state([]);
	let total = $state(0);
	let loaded = $state(false);
	let loadedKey = -1;

	async function load(): Promise<void> {
		try {
			const result = await loadWholeLog<Session>(async (offset) => {
				const more = await api(
					`/players/${encodeURIComponent(player)}/sessions?limit=${LOG_PAGE}&offset=${offset}`
				);

				return more.available === false
					? { total: 0, rows: [] }
					: { total: more.total ?? 0, rows: more.sessions ?? [] };
			});

			total = result.total;
			sessions = result.rows;
		} catch {
			// the rows already shown stay; the profile's own notice says the directory is down
		} finally {
			loaded = true;
		}
	}

	$effect(() => {
		if (active && loadedKey !== refreshKey) {
			loadedKey = refreshKey;
			untrack(() => void load());
		}
	});

	// GitHub-style ramp for the play calendar: an empty day has to read as empty,
	// so the low stop is the panel's own hover tint rather than the lighter track.
	const PLAY_RAMP = ['var(--bg-hover)', 'var(--success)'];

	const playPoints = $derived(playPointsOf(sessions));

	// the range ends today rather than at the last session, so a player who
	// stopped playing shows the gap since instead of ending on their last day
	const playRangeEnd = $derived(sessions.length > 0 ? Date.now() : null);

	// how many sessions made up the day's total, which the duration alone hides
	const playDayDetails = $derived((day: CalendarDay): OverviewDetail[] => [
		{ key: t('web.playerDetail.sessions'), value: String(day.count), mono: true }
	]);

	const columns: Column[] = $derived([
		{ id: 'connected', label: t('web.playerDetail.connected'), sortable: true },
		{ id: 'server', label: t('web.playerDetail.backend'), sortable: true },
		{ id: 'duration', label: t('web.playerDetail.duration'), sortable: true },
		{ id: 'ended', label: t('web.playerDetail.disconnected') }
	]);

	const filters: TableFilterGroup<Session>[] = $derived([
		{
			id: 'server',
			label: t('web.players.filterBackend'),
			options: [
				{ value: 'any', label: t('web.players.anyBackend') },
				...[...new Set(sessions.map((session) => session.server))]
					.filter(Boolean)
					.sort()
					.map((name) => ({
						value: name,
						label: name,
						match: (session: Session) => session.server === name
					}))
			]
		}
	]);
</script>

<Panel
	title={t('web.playerDetail.playCalendar')}
	description={t('web.playerDetail.playCalendarHint')}
>
	<CalendarGraph
		points={playPoints}
		to={playRangeEnd}
		ramp={PLAY_RAMP}
		valueFormat={(value) => (value > 0 ? fmtDuration(value) : '0s')}
		dayDetails={playDayDetails}
		empty={t('web.playerDetail.noPlayDays')}
	/>
</Panel>

<Panel title={t('web.playerDetail.sessions')} count={loaded ? total : undefined} flush>
	<ResourceTable
		tableId="player-sessions"
		loading={!loaded}
		{columns}
		{filters}
		rows={sessions}
		getId={(session) => String(session.id)}
		searchValue={(session) => session.server}
		searchPlaceholder={t('web.playerDetail.findBackend')}
		noun={t('web.playerDetail.session')}
		pageSize={25}
		sortValue={(session, col) =>
			col === 'connected'
				? session.connectedAtEpochMillis
				: col === 'server'
					? session.server
					: col === 'duration'
						? session.durationMillis
						: null}
		defaultSort={{ col: 'connected', dir: 'desc' }}
		emptyTitle={t('web.playerDetail.noSessionsRecorded')}
		emptyText={t('web.playerDetail.playSessionsAreRecordedFrom')}
	>
		{#snippet cell(session, col)}
			{#if col === 'connected'}
				<DateTime at={session.connectedAtEpochMillis} text={fmtDateTime(session.connectedAtEpochMillis)} />
			{:else if col === 'server'}
				<ScreenLink href="/instances/{session.server}/players/{encodeURIComponent(player)}">{session.server}</ScreenLink>
			{:else if col === 'duration'}
				{#if session.open}
					<StatusBadge state="ok" label={t('web.playerDetail.ongoing')} />
				{:else}
					{fmtDuration(session.durationMillis)}
				{/if}
			{:else if col === 'ended'}
				{#if session.open}
					<span class="dim">–</span>
				{:else}
					<DateTime at={session.disconnectedAtEpochMillis} text={fmtDateTime(session.disconnectedAtEpochMillis)} />
				{/if}
			{/if}
		{/snippet}
	</ResourceTable>
	{#if sessions.length < total}
		<p class="capped dim">
			{t('web.playerDetail.newestRecordsShown', { shown: sessions.length, total })}
		</p>
	{/if}
</Panel>

<style lang="scss">
	// the cap is a fact about the table above it, not an invitation to click
	.capped {
		margin: 0;
		padding: 0.75rem 1.25rem;
		font-size: 0.8125rem;
		border-top: 0.1rem solid var(--border-divider);
	}
</style>
