<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { api } from '$lib/api';
	import { copyText } from '$lib/clipboard';
	import { lunaAdmin, playerVerbGroups } from '$lib/playeractions';
	import type { PlayerActionTarget } from '$lib/playeractions';
	import { PING_FAIR, PING_POOR, pingClass } from '$lib/players';
	import { fmtDuration, fmtTime } from '$lib/format';
	import ScreenLink from '$lib/components/ScreenLink.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Select from '$lib/components/Select.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import CellStack from '$lib/components/CellStack.svelte';
	import PlayerActionDialogs from '$lib/components/PlayerActionDialogs.svelte';
	import StatGrid from '$lib/components/StatGrid.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import { loadInterval } from '$lib/components/refresh';
	import DateTime from '$lib/components/DateTime.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import PlayerName from '$lib/components/PlayerName.svelte';
	import { menuGroups, type ContextMenuItem } from '$lib/components/contextmenu';
	import { Notify } from '$lib/notifications.svelte';
	import { resourceId } from '$shared/iam/resources';
	import { withCopyResourceId } from '$lib/resourceid';

	/**
	 * Everyone on the network, from LunaCore's own view of the proxy.
	 *
	 * The list is polled through RefreshControl like every other page, but it also
	 * subscribes to LunaCore's players stream: joins and leaves are exactly the events
	 * a poll interval feels slow for, and the stream only speaks when something
	 * actually happened, so reacting to it costs nothing while the network is idle.
	 * A stream event is still a reload, so it follows the refresh control: with
	 * auto-refresh switched off, the roster changes only when the operator asks.
	 */

	interface Player {
		uuid: string;
		username: string;
		server: string;
		pingMillis: number;
		sessionMillis: number;
		connectedAtEpochMillis: number;
		remoteAddress: string;
		virtualHost: string;
		protocolVersion: number;
		clientVersion: string;
		onlineMode: boolean;
	}

	interface Activity {
		type: string;
		uuid: string;
		username: string;
		server: string;
		previousServer: string;
		atEpochMillis: number;
		sessionMillis: number;
	}

	let players: Player[] = $state([]);
	let activity: Activity[] = $state([]);
	let byServer: Record<string, number> = $state({});
	let available = $state(true);
	let problem = $state('');
	let servers: string[] = $state([]);

	/** Backends luna manages, which the access-list verbs can target */
	let instances: string[] = $state([]);
	let loading = $state(true);

	/** True once the first read settled; the tables' skeletons show only before it */
	let loaded = $state(false);

	/** The refresh control's storage key, which the stream reads the setting through */
	const REFRESH_KEY = 'players';
	let lastUpdated: number | null = $state(null);

	let selected: Set<string> = $state(new Set());

	let dialogs: PlayerActionDialogs | undefined = $state();
	let broadcastOpen = $state(false);
	let broadcastText = $state('');
	let broadcastServer = $state('');

	const selection = $derived(players.filter((player) => selected.has(player.uuid)));

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const data = await api('/luna/players');

			available = data.available !== false;
			problem = available ? '' : (data.error ?? t('web.playerDetail.noAnswer'));
			players = data.players ?? [];
			activity = data.activity ?? [];
			byServer = data.byServer ?? {};
			lastUpdated = Date.now();
		} catch (err) {
			available = false;
			problem = (err as Error).message;
		}

		loading = false;
		loaded = true;
	}

	onMount(() => {
		void refresh();

		// the backend list is only needed to offer transfer targets
		void api('/instances').then((data) => {
			instances = data.instances
				.filter((inst: any) => inst.name !== 'proxy')
				.map((inst: any) => inst.name)
				.sort();
			servers = [
				...data.instances
					.filter((inst: any) => inst.name !== 'proxy')
					.map((inst: any) => inst.name),
				...data.externals.map((inst: any) => inst.name)
			].sort();
		});

		// any event on the stream means the roster changed; the payload is LunaCore's
		// own event shape, and re-reading /players is cheaper than mirroring it here
		const stream = new EventSource('/api/luna/stream?stream=players');

		stream.onmessage = () => {
			if (loadInterval(REFRESH_KEY) > 0) {
				void refresh();
			}
		};

		return () => stream.close();
	});

	const columns: Column[] = $derived([
		{ id: 'username', label: t('web.playersOnline.player2'), sortable: true, minWidth: 180 },
		{ id: 'server', label: t('web.playersOnline.backend'), sortable: true },
		{ id: 'session', label: t('web.playersOnline.session'), sortable: true },
		{ id: 'ping', label: t('web.playersOnline.ping'), sortable: true, width: 110, align: 'right' },
		{ id: 'client', label: t('web.playersOnline.client'), sortable: true, hidden: true },
		{ id: 'mode', label: t('web.playersOnline.auth') },
		{ id: 'address', label: t('web.playersOnline.address'), hidden: true },
		{ id: 'host', label: t('web.playersOnline.connectedVia'), hidden: true },
		{ id: 'uuid', label: t('web.playersOnline.uuid'), width: 300, hidden: true }
	]);

	const filters: TableFilterGroup<Player>[] = $derived([
		{
			id: 'server',
			label: t('web.playersOnline.filterBackend'),
			options: [
				{ value: 'any', label: t('web.playersOnline.anyBackend') },
				...Object.keys(byServer)
					.sort()
					.map((name) => ({
						value: name,
						label: `${name} (${byServer[name]})`,
						match: (player: Player) => player.server === name
					}))
			]
		},
		{
			id: 'ping',
			label: t('web.playersOnline.filterLatency'),
			options: [
				{ value: 'any', label: t('web.playersOnline.anyLatency') },
				{
					value: 'good',
					label: t('web.instancePlayers.under', { ms: PING_FAIR }),
					match: (player) => player.pingMillis < PING_FAIR
				},
				{
					value: 'poor',
					label: t('web.instancePlayers.over', { ms: PING_POOR }),
					match: (player) => player.pingMillis >= PING_POOR
				}
			]
		}
	]);

	function sortValue(player: Player, col: string): string | number | null {
		switch (col) {
			case 'username':
				return player.username.toLowerCase();

			case 'server':
				return player.server;

			case 'session':
				return player.sessionMillis;

			case 'ping':
				return player.pingMillis;

			case 'client':
				return player.protocolVersion;

			default:
				return null;
		}
	}

	/** The backend with the most players on it, as `[name, count]`. */
	const busiest = $derived(
		Object.entries(byServer).sort((left, right) => right[1] - left[1])[0]
	);

	const slowCount = $derived(players.filter((player) => player.pingMillis >= PING_POOR).length);

	const longestSession = $derived(
		players.length ? Math.max(...players.map((player) => player.sessionMillis)) : 0
	);

	const averagePing = $derived(
		players.length
			? Math.round(players.reduce((sum, player) => sum + player.pingMillis, 0) / players.length)
			: 0
	);

	/** Joins within the last hour, from the activity log. */
	const recentJoins = $derived(
		activity.filter(
			(event) => event.type === 'join' && Date.now() - event.atEpochMillis < 3_600_000
		).length
	);

	async function doBroadcast(): Promise<void> {
		const text = broadcastText.trim();

		broadcastOpen = false;

		if (!text) {
			return;
		}

		const busy = t('web.playersOnline.broadcasting');
		const note = Notify.loading(busy);

		try {
			const data = await lunaAdmin({
				action: 'broadcast',
				message: text,
				server: broadcastServer || undefined
			});

			note.set({
				level: 'success',
				message: t('web.playersOnline.broadcastReached', { count: Number(data.reached ?? 0) }),
				closeable: true
			});
		} catch (err) {
			note.set({ level: 'error', message: busy, detail: (err as Error).message, closeable: true });
		}

		broadcastText = '';
	}

	function targetsOf(rows: Player[]): PlayerActionTarget[] {
		return rows.map((player) => ({
			uuid: player.uuid,
			username: player.username,
			online: true,
			server: player.server,
			address: player.remoteAddress
		}));
	}

	/** The verbs over a set of players, in the shared order and wording. */
	function verbs(rows: Player[]): ReturnType<typeof playerVerbGroups> {
		return playerVerbGroups({
			targets: targetsOf(rows),
			servers,
			open: (kind, targets) => dialogs?.open(kind, targets)
		});
	}

	/** Verbs over a selection; the Actions dropdown and each row's menu share these. */
	function selectionActions(rows: Player[]): ContextMenuItem[] {
		const groups = verbs(rows);

		return menuGroups(groups.live, groups.access, groups.remove);
	}

	/** A row's menu: its links and copies around the verbs over the selection it is in. */
	function rowActions(player: Player): ContextMenuItem[] {
		const rows = selected.has(player.uuid) && selection.length > 1 ? selection : [player];
		const groups = verbs(rows);

		return menuGroups(
			[
				{
					label: t('web.playersOnline.viewProfile'),
					icon: 'user',
					action: () => goto(`/players/${player.uuid}`)
				},
				{
					label: t('web.players.viewOnBackend', { server: player.server }),
					icon: 'userPortrait',
					action: () => goto(`/instances/${player.server}/players/${player.uuid}`)
				}
			],
			groups.live,
			groups.access,
			[
				{
					id: 'copy-uuid',
					label: t('web.playersOnline.copyUuid'),
					icon: 'copy',
					action: () => void copyText(player.uuid)
				},
				{
					id: 'copy-name',
					label: t('web.instancePlayers.copyName'),
					icon: 'copy',
					action: () => void copyText(player.username)
				}
			],
			groups.remove
		);
	}

	const ACTIVITY: Record<string, { state: string; label: string }> = {
		join: { state: 'ok', label: 'web.playersOnline.eventJoin' },
		leave: { state: 'stopped', label: 'web.playersOnline.eventLeave' },
		switch: { state: 'warning', label: 'web.playersOnline.eventSwitch' }
	};

	const activityCols: Column[] = $derived([
		{ id: 'time', label: t('web.playersOnline.time'), width: 170, sortable: true },
		{ id: 'type', label: t('web.playersOnline.event2'), width: 120 },
		{ id: 'username', label: t('web.playersOnline.player2'), sortable: true },
		{ id: 'where', label: t('web.playersOnline.backend') },
		{ id: 'session', label: t('web.playersOnline.sessionLength') }
	]);
</script>

<svelte:head><title>{t('web.playersOnline.onlinePlayersLunaConsole')}</title></svelte:head>

<PageHeader
	title={t('web.playersOnline.onlinePlayers')}
	count="{selected.size ? `${selected.size}/` : ''}{players.length}"
	info={t('web.guide.playersOnline')}
	description={t('web.playersOnline.description')}
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey={REFRESH_KEY} />
		<Dropdown
			label={t('web.playersOnline.actions')}
			disabled={selection.length === 0}
			menu={withCopyResourceId(selectionActions(selection), selection.map((player) => resourceId('player', player.username)))}
		/>
		<Btn icon="users" href="/players">{t('web.playersOnline.allPlayers')}</Btn>
		<Btn icon="bullhorn" onclick={() => (broadcastOpen = true)}>{t('web.playersOnline.broadcast')}</Btn>
	{/snippet}
</PageHeader>

{#if !available}
	<Flash kind="warning">
		<b>{t('web.playersOnline.lunacoreIsNotAnswering')}</b>
		{t('web.playerDetail.lunacoreDownDetail', { problem })}
	</Flash>
{/if}

<StatGrid min={10}>
	<StatTile label={t('web.playersOnline.onlineNow')} value={loaded && available ? players.length : null} loading={!loaded} />
	<StatTile
		label={t('web.playersOnline.backendsOccupied')}
		value={loaded && available ? Object.keys(byServer).length : null}
		secondary={busiest ? t('web.playersOnline.busiest', { server: busiest[0], count: busiest[1] }) : undefined}
		loading={!loaded}
	/>
	<StatTile
		label={t('web.playersOnline.averagePing')}
		value={players.length > 0 ? averagePing : null}
		unit="ms"
		tone={players.length > 0 && averagePing >= PING_POOR ? 'critical' : players.length > 0 && averagePing >= PING_FAIR ? 'warning' : 'default'}
		secondary={slowCount > 0 ? t('web.playersOnline.slowCount', { count: slowCount, ms: PING_POOR }) : undefined}
		loading={!loaded}
	/>
	<StatTile
		label={t('web.playersOnline.longestSession')}
		value={players.length > 0 ? longestSession : null}
		formatValue={fmtDuration}
		loading={!loaded}
	/>
	<StatTile
		label={t('web.playersOnline.joinsInTheLastHour')}
		value={loaded && available ? recentJoins : null}
		loading={!loaded}
	/>
</StatGrid>

<div class="body">
	<Panel flush>
		<ResourceTable
			tableId="players"
			loading={!loaded}
			initialSearch={page.url.searchParams.get('q') ?? ''}
			{columns}
			rows={players}
			getId={(player) => player.uuid}
			searchValue={(player) =>
				`${player.username} ${player.server} ${player.uuid} ${player.clientVersion} ${player.remoteAddress} ${player.virtualHost}`}
			searchPlaceholder={t('web.playersOnline.findPlayerByNameBackend')}
			selectable="multi"
			bind:selected
			{rowActions}
			rowLabel={(player) => player.username}
			resourceId={(player) => resourceId('player', player.username)}
			noun={t('web.playersOnline.player')}
			{sortValue}
			{filters}
			pageSize={25}
			defaultSort={{ col: 'session', dir: 'desc' }}
			emptyTitle={t('web.playersOnline.nobodyIsOnline')}
			emptyText={t('web.playersOnline.joinsAppearHereAsThey')}
		>
			{#snippet cell(player, col)}
				{#if col === 'username'}
					<PlayerName player={player.uuid} name={player.username} />
				{:else if col === 'server'}
					<ScreenLink href="/instances/{player.server}/access">{player.server}</ScreenLink>
				{:else if col === 'session'}
					<DateTime at={player.connectedAtEpochMillis} text={fmtDuration(player.sessionMillis)} />
				{:else if col === 'ping'}
					<CellStack align="right">
						{#snippet main()}
							<span class="ping {pingClass(player.pingMillis)}">{player.pingMillis} ms</span>
						{/snippet}
						{#snippet sub()}
							{player.clientVersion}
						{/snippet}
					</CellStack>
				{:else if col === 'client'}
					<span class="dim">{player.clientVersion}</span>
				{:else if col === 'mode'}
					<StatusBadge
						state={player.onlineMode ? 'passed' : 'warning'}
						label={player.onlineMode ? t('web.players.premium') : t('web.players.offlineAccount')}
					/>
				{:else if col === 'address'}
					<span class="mono dim">{player.remoteAddress}</span>
				{:else if col === 'host'}
					<span class="mono dim">{player.virtualHost}</span>
				{:else if col === 'uuid'}
					<span class="mono dim">{player.uuid}</span>
				{/if}
			{/snippet}
		</ResourceTable>
	</Panel>

	<Panel
		title={t('web.playersOnline.recentActivity')}
		count={activity.length}
		description={t('web.playersOnline.joinsLeavesAndBackendSwitches')}
		flush
	>
		<ResourceTable
			tableId="player-activity"
			loading={!loaded}
			columns={activityCols}
			rows={activity}
			getId={(event) => `${event.atEpochMillis}-${event.uuid}-${event.type}`}
			searchValue={(event) => `${event.username} ${event.server ?? ''} ${event.type}`}
			searchPlaceholder={t('web.playersOnline.findActivity')}
			searchWidth="20rem"
			noun={t('web.playersOnline.event')}
			pageSize={20}
			sortValue={(event, col) =>
				col === 'time' ? event.atEpochMillis : col === 'username' ? event.username : null}
			maxHeight="32rem"
			emptyTitle={t('web.playersOnline.noActivityRecorded')}
			emptyText={t('web.playersOnline.lunacoreKeepsThisLogIn')}
		>
			{#snippet cell(event, col)}
				{#if col === 'time'}
					<span class="mono dim">
						<DateTime at={event.atEpochMillis} text={fmtTime(event.atEpochMillis)} />
					</span>
				{:else if col === 'type'}
					<StatusBadge
						state={ACTIVITY[event.type]?.state ?? 'info'}
						label={ACTIVITY[event.type] ? t(ACTIVITY[event.type]!.label) : event.type}
					/>
				{:else if col === 'username'}
					<PlayerName player={event.uuid} name={event.username} />
				{:else if col === 'where'}
					<!-- a switch is the only event with both ends, and the pair is the point -->
					{#if event.type === 'switch' && event.previousServer}
						<span class="dim">{event.previousServer}</span>
						<span class="dim">→</span>
						{event.server}
					{:else}
						{event.server || '–'}
					{/if}
				{:else if col === 'session'}
					{event.sessionMillis ? fmtDuration(event.sessionMillis) : '–'}
				{/if}
			{/snippet}
		</ResourceTable>
	</Panel>
</div>

<PlayerActionDialogs bind:this={dialogs} {servers} {instances} ondone={refresh} />

<Modal title={t('web.playersOnline.broadcastAMessage')} bind:open={broadcastOpen}>
	<label class="field">
		<span class="lbl">{t('web.playersOnline.message')}</span>
		<span class="hint">{t('web.playersOnline.sentToEveryoneOn')}</span>
		<input class="input" bind:value={broadcastText} placeholder={t('web.playersOnline.typeAMessage')} />
	</label>
	<div class="field">
		<span class="lbl">{t('web.playersOnline.audience')}</span>
		<Select
			bind:value={broadcastServer}
			width="100%"
			options={[
				{ value: '', label: t('web.playersOnline.everyoneOnTheNetwork') },
				...servers.map((name) => ({ value: name, label: t('web.playersOnline.onlyOn', { server: name }) }))
			]}
		/>
	</div>
	{#snippet footer()}
		<Btn onclick={() => (broadcastOpen = false)}>{t('web.playersOnline.cancel')}</Btn>
		<Btn variant="primary" disabled={!broadcastText.trim()} onclick={doBroadcast}>{t('web.playersOnline.broadcast')}</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.body {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		margin-top: 1rem;
	}

	// latency bands, the same three-step scale as the instances table's TPS column
	.ping {
		font-variant-numeric: tabular-nums;

		&.good {
			color: var(--success);
		}

		&.fair {
			color: var(--warning);
		}

		&.poor {
			color: var(--error);
		}
	}
</style>
