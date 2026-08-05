<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { api, post } from '$lib/api';
	import { fmtDuration, fmtDateTime, fmtTime } from '$lib/format';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Select from '$lib/components/Select.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import OverviewBar from '$lib/components/OverviewBar.svelte';
	import OverviewCell from '$lib/components/OverviewCell.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import PlayerSkin from '$lib/components/PlayerSkin.svelte';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * Everyone on the network, from LunaCore's own view of the proxy.
	 *
	 * The list is polled through RefreshControl like every other page, but it also
	 * subscribes to LunaCore's players stream: joins and leaves are exactly the events
	 * a poll interval feels slow for, and the stream only speaks when something
	 * actually happened, so reacting to it costs nothing while the network is idle.
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

	/** Latency bands, in ms; the same thresholds the proxy's own tab list uses. */
	const PING_FAIR = 120;
	const PING_POOR = 250;

	let players: Player[] = $state([]);
	let activity: Activity[] = $state([]);
	let byServer: Record<string, number> = $state({});
	let available = $state(true);
	let problem = $state('');
	let servers: string[] = $state([]);
	let loading = $state(true);
	let lastUpdated: number | null = $state(null);

	let selected: Set<string> = $state(new Set());

	let kickOpen = $state(false);
	let kickReason = $state('');
	let messageOpen = $state(false);
	let messageText = $state('');
	let transferOpen = $state(false);
	let transferTo = $state('');
	let broadcastOpen = $state(false);
	let broadcastText = $state('');
	let broadcastServer = $state('');

	const one = $derived(
		selected.size === 1 ? players.find((player) => selected.has(player.uuid)) : undefined
	);

	async function refresh(): Promise<void> {
		try {
			const data = await api('/luna/players');

			available = data.available !== false;
			problem = available ? '' : (data.error ?? 'LunaCore is unreachable');
			players = data.players ?? [];
			activity = data.activity ?? [];
			byServer = data.byServer ?? {};
			lastUpdated = Date.now();
		} catch (err) {
			available = false;
			problem = (err as Error).message;
		}

		loading = false;
	}

	onMount(() => {
		void refresh();

		// the backend list is only needed to offer transfer targets
		void api('/instances').then((data) => {
			servers = [
				...data.instances
					.filter((inst: any) => inst.name !== 'proxy')
					.map((inst: any) => inst.name),
				...data.externals.map((inst: any) => inst.name)
			].sort();

			transferTo = servers[0] ?? '';
		});

		// any event on the stream means the roster changed; the payload is LunaCore's
		// own event shape, and re-reading /players is cheaper than mirroring it here
		const stream = new EventSource('/api/luna/stream?stream=players');

		stream.onmessage = () => void refresh();

		return () => stream.close();
	});

	const columns: Column[] = $derived([
		{ id: 'username', label: t('web.playersOnline.player2'), sortable: true, minWidth: 180 },
		{ id: 'server', label: t('web.playersOnline.backend'), sortable: true },
		{ id: 'session', label: t('web.playersOnline.session'), sortable: true },
		{ id: 'ping', label: t('web.playersOnline.ping'), sortable: true, width: 110, align: 'right' },
		{ id: 'client', label: t('web.playersOnline.client'), sortable: true },
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
				{ value: 'good', label: `Under ${PING_FAIR} ms`, match: (player) => player.pingMillis < PING_FAIR },
				{
					value: 'poor',
					label: `Over ${PING_POOR} ms`,
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

	/** Latency band, for the coloured ping figure. */
	function pingClass(ping: number): string {
		if (ping < PING_FAIR) {
			return 'good';
		}

		return ping < PING_POOR ? 'fair' : 'poor';
	}

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

	/** Run an admin action against LunaCore and report what it did. */
	async function act(
		body: Record<string, unknown>,
		pending: string,
		done: (result: any) => string
	): Promise<void> {
		const note = Notify.loading(pending);

		try {
			const result = await post('/luna/admin', body);

			if (result.ok === false) {
				throw new Error(result.error ?? 'LunaCore refused the action');
			}

			note.set({ level: 'success', message: done(result.data ?? {}), closeable: true });

			await refresh();
		} catch (err) {
			note.set({
				level: 'error',
				message: pending,
				detail: (err as Error).message,
				closeable: true
			});
		}
	}

	async function doKick(): Promise<void> {
		const player = one;

		kickOpen = false;

		if (!player) {
			return;
		}

		await act(
			{ action: 'kick', player: player.username, reason: kickReason },
			`Disconnecting ${player.username}…`,
			() => `${player.username} disconnected`
		);

		kickReason = '';
	}

	async function doMessage(): Promise<void> {
		const player = one;
		const text = messageText.trim();

		messageOpen = false;

		if (!player || !text) {
			return;
		}

		await act(
			{ action: 'message', player: player.username, message: text },
			`Sending a message to ${player.username}…`,
			() => `Message delivered to ${player.username}`
		);

		messageText = '';
	}

	async function doTransfer(): Promise<void> {
		const player = one;

		transferOpen = false;

		if (!player || !transferTo) {
			return;
		}

		await act(
			{ action: 'transfer', player: player.username, server: transferTo },
			`Moving ${player.username} to ${transferTo}…`,
			(data) => `${player.username} moved to ${data.server ?? transferTo}`
		);
	}

	async function doBroadcast(): Promise<void> {
		const text = broadcastText.trim();

		broadcastOpen = false;

		if (!text) {
			return;
		}

		await act(
			{
				action: 'broadcast',
				message: text,
				server: broadcastServer || undefined
			},
			'Broadcasting…',
			(data) => `Broadcast reached ${data.reached ?? 0} player(s)`
		);

		broadcastText = '';
	}

	/** A player's verbs; the row menu and the toolbar's Actions button. */
	function rowActions(player: Player): ContextMenuItem[] {
		return [
			{
				label: t('web.playersOnline.viewProfile'),
				icon: 'user',
				action: () => goto(`/players/${player.uuid}`)
			},
			{
				label: `Open ${player.server}`,
				icon: 'server',
				action: () => goto(`/instances/${player.server}`)
			},
			{ separator: true },
			{
				label: t('web.playersOnline.sendAMessage'),
				icon: 'paperPlane',
				action: () => {
					selected = new Set([player.uuid]);
					messageOpen = true;
				}
			},
			{
				label: t('web.playersOnline.moveToAnotherBackend'),
				icon: 'rightLeft',
				action: () => {
					selected = new Set([player.uuid]);
					transferOpen = true;
				}
			},
			{
				label: t('web.playersOnline.copyUuid'),
				icon: 'copy',
				action: () => void copy(player.uuid)
			},
			{ separator: true },
			{
				label: t('web.playersOnline.disconnectPlayer'),
				icon: 'userSlash',
				color: 'danger',
				action: () => {
					selected = new Set([player.uuid]);
					kickOpen = true;
				}
			}
		];
	}

	/** The console runs on plain HTTP, where navigator.clipboard does not exist. */
	async function copy(text: string): Promise<void> {
		const { copyText } = await import('$lib/clipboard');

		await copyText(text);
	}

	const activityCols: Column[] = $derived([
		{ id: 'time', label: t('web.playersOnline.time'), width: 170, sortable: true },
		{ id: 'type', label: t('web.playersOnline.event2'), width: 120 },
		{ id: 'username', label: t('web.playersOnline.player2'), sortable: true },
		{ id: 'where', label: t('web.playersOnline.backend') },
		{ id: 'session', label: t('web.playersOnline.sessionLength') }
	]);
</script>

<svelte:head><title>{t('web.playersOnline.onlinePlayersLunaConsole')}</title></svelte:head>

<PageHeader title={t('web.playersOnline.onlinePlayers')} count="{selected.size ? `${selected.size}/` : ''}{players.length}" info>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="players" />
		<Dropdown label={t('web.playersOnline.actions')} disabled={!one} menu={one ? rowActions(one) : []} />
		<Btn icon="bullhorn" onclick={() => (broadcastOpen = true)}>{t('web.playersOnline.broadcast')}</Btn>
	{/snippet}
</PageHeader>

{#if !available}
	<Flash kind="warning">
		<b>{t('web.playersOnline.lunacoreIsNotAnswering')}</b> {problem}. The proxy may be stopped, or running a
		{t('web.playersOnline.buildWithoutThePlayers')}
	</Flash>
{/if}

<OverviewBar title={t('web.playersOnline.networkOverview')}>
	<OverviewCell label={t('web.playersOnline.onlineNow')}>
		{players.length}
	</OverviewCell>
	<OverviewCell label={t('web.playersOnline.backendsOccupied')}>
		{Object.keys(byServer).length || '–'}
	</OverviewCell>
	<OverviewCell label={t('web.playersOnline.averagePing')}>
		{players.length ? `${averagePing} ms` : '–'}
	</OverviewCell>
	<OverviewCell label={t('web.playersOnline.longestSession')}>
		{players.length ? fmtDuration(longestSession) : '–'}
	</OverviewCell>
	<OverviewCell label={t('web.playersOnline.joinsInTheLastHour')}>
		{recentJoins}
	</OverviewCell>
</OverviewBar>

<div class="body">
	<Panel flush>
		<ResourceTable
			tableId="players"
			initialSearch={page.url.searchParams.get('q') ?? ''}
			{columns}
			rows={players}
			getId={(player) => player.uuid}
			searchValue={(player) =>
				`${player.username} ${player.server} ${player.uuid} ${player.clientVersion} ${player.remoteAddress} ${player.virtualHost}`}
			searchPlaceholder={t('web.playersOnline.findPlayerByNameBackend')}
			selectable="single"
			bind:selected
			{rowActions}
			rowLabel={(player) => player.username}
			noun={t('web.playersOnline.player')}
			{sortValue}
			{filters}
			pageSize={25}
			emptyTitle={t('web.playersOnline.nobodyIsOnline')}
			emptyText={t('web.playersOnline.joinsAppearHereAsThey')}
		>
			{#snippet cell(player, col)}
				{#if col === 'username'}
					<span class="who">
						<PlayerSkin player={player.uuid} view="face" px={3} />
						<a href="/players/{player.uuid}"><b>{player.username}</b></a>
					</span>
				{:else if col === 'server'}
					<a href="/instances/{player.server}">{player.server}</a>
				{:else if col === 'session'}
					<span title={fmtDateTime(player.connectedAtEpochMillis)}>
						{fmtDuration(player.sessionMillis)}
					</span>
				{:else if col === 'ping'}
					<span class="ping {pingClass(player.pingMillis)}">{player.pingMillis} ms</span>
				{:else if col === 'client'}
					<span class="dim">{player.clientVersion}</span>
				{:else if col === 'mode'}
					<StatusBadge
						state={player.onlineMode ? 'passed' : 'warning'}
						label={player.onlineMode ? 'Premium' : 'Offline'}
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
					<span class="mono dim" title={fmtDateTime(event.atEpochMillis)}>
						{fmtTime(event.atEpochMillis)}
					</span>
				{:else if col === 'type'}
					<StatusBadge
						state={event.type === 'join' ? 'ok' : event.type === 'leave' ? 'stopped' : 'warning'}
						label={event.type}
					/>
				{:else if col === 'username'}
					{event.username}
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

<Modal title="Disconnect {one?.username ?? 'player'}" bind:open={kickOpen}>
	<p>{t('web.playersOnline.theyAreRemovedFrom')}</p>
	<label class="field">
		<span class="lbl">{t('web.playersOnline.reasonShownToThe')}</span>
		<span class="hint">{t('web.playersOnline.optionalLunacoreSendsIts')}</span>
		<input class="input" bind:value={kickReason} placeholder={t('web.playersOnline.eGRestartingTheLobby')} />
	</label>
	{#snippet footer()}
		<Btn onclick={() => (kickOpen = false)}>{t('web.playersOnline.cancel')}</Btn>
		<Btn variant="danger" onclick={doKick}>{t('web.playersOnline.disconnect')}</Btn>
	{/snippet}
</Modal>

<Modal title="Message {one?.username ?? 'player'}" bind:open={messageOpen}>
	<label class="field">
		<span class="lbl">{t('web.playersOnline.message')}</span>
		<span class="hint">{t('web.playersOnline.deliveredInChatVisible')}</span>
		<input class="input" bind:value={messageText} placeholder={t('web.playersOnline.typeAMessage')} />
	</label>
	{#snippet footer()}
		<Btn onclick={() => (messageOpen = false)}>{t('web.playersOnline.cancel')}</Btn>
		<Btn variant="primary" disabled={!messageText.trim()} onclick={doMessage}>{t('web.playersOnline.send')}</Btn>
	{/snippet}
</Modal>

<Modal title="Move {one?.username ?? 'player'}" bind:open={transferOpen}>
	<p>
		{t('web.playersOnline.theProxyMovesThem')}
	</p>
	<div class="field">
		<span class="lbl">{t('web.playersOnline.destinationBackend')}</span>
		<Select
			bind:value={transferTo}
			width="100%"
			options={servers
				.filter((name) => name !== one?.server)
				.map((name) => ({ value: name, label: name }))}
		/>
	</div>
	{#snippet footer()}
		<Btn onclick={() => (transferOpen = false)}>{t('web.playersOnline.cancel')}</Btn>
		<Btn variant="primary" disabled={!transferTo} onclick={doTransfer}>{t('web.playersOnline.move')}</Btn>
	{/snippet}
</Modal>

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
				...servers.map((name) => ({ value: name, label: `Only ${name}` }))
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

	.who {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
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
