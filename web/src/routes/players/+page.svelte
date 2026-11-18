<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { traitsOf } from '$core/software';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { api } from '$lib/api';
	import { copyText } from '$lib/clipboard';
	import { playerVerbGroups } from '$lib/playeractions';
	import type { PlayerActionTarget } from '$lib/playeractions';
	import { MONTH_MS, WEEK_MS, backendColor } from '$lib/players';
	import { fmtDuration, fmtDateTime } from '$lib/format';
	import ScreenLink from '$lib/components/ScreenLink.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import CellStack from '$lib/components/CellStack.svelte';
	import PlayerActionDialogs from '$lib/components/PlayerActionDialogs.svelte';
	import StatGrid from '$lib/components/StatGrid.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import PlayerName from '$lib/components/PlayerName.svelte';
	import { resourceId } from '$shared/iam/resources';
	import { withCopyResourceId } from '$lib/resourceid';
	import PlayerSkin from '$lib/components/PlayerSkin.svelte';
	import DetailPanel from '$lib/components/DetailPanel.svelte';
	import DateTime from '$lib/components/DateTime.svelte';
	import Tabs from '$lib/components/Tabs.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import type { InfoCell } from '$lib/components/grid';
	import DistributionBar from '$lib/components/DistributionBar.svelte';
	import { menuGroups, type ContextMenuItem } from '$lib/components/contextmenu';

	/**
	 * The player directory: every player the network has ever recorded, from
	 * LunaCore's persisted profiles; online or not. The live roster has its own
	 * screen (Online players); this one is for administration: finding a player,
	 * opening their profile, and bulk moderation across instances.
	 */

	interface Player {
		uuid: string;
		username: string;
		firstSeenAtEpochMillis: number;
		lastSeenAtEpochMillis: number;
		lastServer: string;
		lastAddress: string;
		lastClientVersion: string;
		onlineMode: boolean;
		sessionCount: number;
		hasSkin: boolean;
		online: boolean;
		server: string;
		pingMillis: number;
		sessionMillis: number;
		totalPlayMillis: number;
	}

	/** LunaCore pages at 200 max; the sweep stops here even if the DB has more. */
	const PAGE_LIMIT = 200;
	const SWEEP_CAP = 2000;

	let players: Player[] = $state([]);
	let total = $state(0);
	let available = $state(true);
	let problem = $state('');
	let loading = $state(true);

	/** True once the first read settled; the table's skeleton shows only before it */
	let loaded = $state(false);
	let lastUpdated: number | null = $state(null);
	let instances: string[] = $state([]);
	let servers: string[] = $state([]);
	let dialogs: PlayerActionDialogs | undefined = $state();

	/** Bumped on every refresh, so the split panel re-reads the player it shows */
	let refreshKey = $state(0);

	let selected: Set<string> = $state(new Set());

	const selection = $derived(players.filter((player) => selected.has(player.uuid)));

	// -- detail split panel ------------------------------------------------------
	// One selected player opens the docked panel, exactly as the instances screen
	// does: the directory row already carries the profile's headline facts, and
	// the panel enriches them with the full detail as it arrives.
	const one = $derived(selection.length === 1 ? selection[0] : undefined);

	// the row is a new object on every refresh; the skin is redrawn when its
	// player changes, so it is handed the id alone, which does not
	const oneUuid = $derived(one?.uuid ?? '');

	let detailTab = $state('details');
	let panelLocation: 'bottom' | 'right' = $state('bottom');
	let panelSize = $state(42);

	interface PanelDetail {
		playtimeByServer: Array<{ server: string; playMillis: number; stints: number }>;
		chatTotal: number;
		commandTotal: number;
		moderationTotal: number;
		pingMillis: number;
		permissions: { available: boolean; primaryGroupDisplay?: string; primaryGroup?: string };
	}

	interface PanelSession {
		id: number;
		server: string;
		connectedAtEpochMillis: number;
		durationMillis: number;
		open: boolean;
	}

	let panelDetail = $state<PanelDetail | null>(null);
	let panelSessions = $state<PanelSession[]>([]);
	let panelLoading = $state(false);

	/** How many recent sessions the panel lists; the full history is the profile's. */
	const PANEL_SESSIONS = 8;

	/** The player the panel's data belongs to; a refresh of the same one keeps what is shown */
	let panelFor = '';

	$effect(() => {
		const uuid = one?.uuid;

		// read so the panel follows the screen's refresh as well as the selection
		void refreshKey;

		if (uuid !== panelFor) {
			panelFor = uuid ?? '';
			panelDetail = null;
			panelSessions = [];
			panelLoading = !!uuid;
		}

		if (!uuid) {
			return;
		}

		let cancelled = false;

		void (async () => {
			try {
				const [detail, sessions] = await Promise.all([
					api(`/players/${encodeURIComponent(uuid)}`),
					api(`/players/${encodeURIComponent(uuid)}/sessions?limit=${PANEL_SESSIONS}&offset=0`)
				]);

				if (!cancelled) {
					panelDetail = detail.available === false ? null : detail;
					panelSessions = sessions.sessions ?? [];
				}
			} catch {
				// the row's own facts still fill the panel; the profile page is the
				// place that reports directory trouble in full
				if (!cancelled) {
					panelDetail = null;
				}
			} finally {
				if (!cancelled) {
					panelLoading = false;
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	});

	const detailCells: InfoCell[] = $derived.by(() => {
		if (!one) {
			return [];
		}

		return [
			{ id: 'status', label: t('web.players.status') },
			{ label: t('web.players.uuid'), value: one.uuid, copyable: true, style: 'mono' },
			{
				label: t('web.players.auth'),
				value: one.onlineMode ? t('web.players.premium') : t('web.players.offlineAccount')
			},
			{
				label: t('web.players.firstSeen'),
				value: one.firstSeenAtEpochMillis ? fmtDateTime(one.firstSeenAtEpochMillis) : null,
				time: one.firstSeenAtEpochMillis || null
			},
			{
				label: t('web.players.lastSeen'),
				value: one.online
					? t('web.players.online')
					: one.lastSeenAtEpochMillis
						? fmtDateTime(one.lastSeenAtEpochMillis)
						: null,
				time: one.online
					? undefined
					: one.lastSeenAtEpochMillis || null
			},
			{
				label: t('web.playerDetail.backend'),
				value: one.online ? one.server : one.lastServer || null,
				href: (one.online ? one.server : one.lastServer)
					? `/instances/${one.online ? one.server : one.lastServer}`
					: undefined,
				leaves: true
			},
			{ label: t('web.playerDetail.totalPlaytime'), value: fmtDuration(one.totalPlayMillis) },
			{ label: t('web.players.sessions'), value: one.sessionCount },
			{ label: t('web.playerDetail.clientVersion'), value: one.lastClientVersion || null },
			{ label: t('web.players.lastAddress'), value: one.lastAddress || null, style: 'mono' },
			...(panelDetail?.permissions?.available
				? [
						{
							label: t('web.playerDetail.permissionGroup'),
							value:
								panelDetail.permissions.primaryGroupDisplay ??
								panelDetail.permissions.primaryGroup ??
								null
						}
					]
				: [])
		];
	});

	const playtimeSegments = $derived(
		(panelDetail?.playtimeByServer ?? []).map((entry, index) => ({
			key: entry.server,
			count: entry.playMillis,
			color: backendColor(index)
		}))
	);

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const collected: Player[] = [];
			let offset = 0;
			let reported = 0;

			// The directory outlives any one proxy uptime, so it can be larger than a
			// single LunaCore page; sweep until it is all here (capped defensively).
			for (;;) {
				const data = await api(`/players?limit=${PAGE_LIMIT}&offset=${offset}`);

				if (data.available === false) {
					available = false;
					problem = data.error ?? t('web.playerDetail.noAnswer');
					loading = false;
					loaded = true;
					return;
				}

				reported = data.total ?? 0;
				collected.push(...(data.players ?? []));

				if (collected.length >= reported || collected.length >= SWEEP_CAP || !(data.players ?? []).length) {
					break;
				}

				offset = collected.length;
			}

			available = true;
			problem = '';
			players = collected;
			total = reported;
			lastUpdated = Date.now();
			refreshKey++;
		} catch (err) {
			available = false;
			problem = (err as Error).message;
		}

		loading = false;
		loaded = true;
	}

	onMount(() => {
		void refresh();

		// backends the moderation verbs can target; the proxy keeps no lists
		void api('/instances').then((data) => {
			instances = data.instances
				.filter((inst: any) => !traitsOf(inst.software).isProxy && inst.name !== 'proxy')
				.map((inst: any) => inst.name)
				.sort();
			servers = [
				...instances,
				...data.externals.map((inst: any) => inst.name)
			].sort();
		});
	});

	const columns: Column[] = $derived([
		{ id: 'username', label: t('web.players.player2'), sortable: true, minWidth: 180 },
		{ id: 'status', label: t('web.players.status'), sortable: true },
		{ id: 'lastSeen', label: t('web.players.lastSeen'), sortable: true },
		{ id: 'playtime', label: t('web.players.playtime'), sortable: true },
		{ id: 'sessions', label: t('web.players.sessions'), sortable: true, width: 110, align: 'right' },
		{ id: 'firstSeen', label: t('web.players.firstSeen'), sortable: true },
		{ id: 'mode', label: t('web.players.auth'), hidden: true },
		{ id: 'client', label: t('web.players.client'), hidden: true },
		{ id: 'address', label: t('web.players.lastAddress'), hidden: true },
		{ id: 'uuid', label: t('web.players.uuid'), width: 300, hidden: true }
	]);

	const onlineCount = $derived(players.filter((player) => player.online).length);

	/** When a player was last here; a connected one is here now. */
	function lastSeen(player: Player): number {
		return player.online
			? Date.now()
			: player.lastSeenAtEpochMillis;
	}

	const activeCount = $derived(players.filter((player) => Date.now() - lastSeen(player) < WEEK_MS).length);

	const newCount = $derived(
		players.filter((player) => Date.now() - player.firstSeenAtEpochMillis < WEEK_MS).length
	);

	const totalPlayMillis = $derived(players.reduce((sum, player) => sum + player.totalPlayMillis, 0));
	const totalSessions = $derived(players.reduce((sum, player) => sum + player.sessionCount, 0));

	const filters: TableFilterGroup<Player>[] = $derived([
		{
			id: 'status',
			label: t('web.players.filterStatus'),
			options: [
				{ value: 'any', label: t('web.players.anyStatus') },
				{ value: 'online', label: t('web.players.online'), match: (player: Player) => player.online },
				{ value: 'offline', label: t('web.players.offline'), match: (player: Player) => !player.online },
				{
					value: 'week',
					label: t('web.players.seenThisWeek'),
					match: (player: Player) => Date.now() - lastSeen(player) < WEEK_MS
				},
				{
					value: 'away',
					label: t('web.players.awayAMonth'),
					match: (player: Player) => Date.now() - lastSeen(player) >= MONTH_MS
				},
				{
					value: 'new',
					label: t('web.players.joinedThisWeek'),
					match: (player: Player) => Date.now() - player.firstSeenAtEpochMillis < WEEK_MS
				}
			]
		},
		{
			id: 'mode',
			label: t('web.players.filterAccount'),
			options: [
				{ value: 'any', label: t('web.players.anyAccount') },
				{ value: 'premium', label: t('web.players.premium'), match: (player: Player) => player.onlineMode },
				{
					value: 'offline',
					label: t('web.players.offlineAccount'),
					match: (player: Player) => !player.onlineMode
				}
			]
		},
		{
			id: 'server',
			label: t('web.players.filterBackend'),
			options: [
				{ value: 'any', label: t('web.players.anyBackend') },
				...[...new Set(players.map((player) => player.online ? player.server : player.lastServer))]
					.filter(Boolean)
					.sort()
					.map((name) => ({
						value: name,
						label: name,
						match: (player: Player) => (player.online ? player.server : player.lastServer) === name
					}))
			]
		}
	]);

	function sortValue(player: Player, col: string): string | number | null {
		switch (col) {
			case 'username':
				return player.username.toLowerCase();

			case 'status':
				return player.online ? 0 : 1;

			case 'lastSeen':
				return lastSeen(player);

			case 'playtime':
				return player.totalPlayMillis;

			case 'sessions':
				return player.sessionCount;

			case 'firstSeen':
				return player.firstSeenAtEpochMillis;

			default:
				return null;
		}
	}

	function targetsOf(rows: Player[]): PlayerActionTarget[] {
		return rows.map((player) => ({
			uuid: player.uuid,
			username: player.username,
			online: player.online,
			server: player.server,
			...(player.lastAddress ? { address: player.lastAddress } : {})
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
	function bulkActions(rows: Player[]): ContextMenuItem[] {
		const groups = verbs(rows);

		return menuGroups(groups.live, groups.access, groups.remove);
	}

	/** A row's menu: the profile, then the verbs over the selection the row is in. */
	function rowActions(player: Player): ContextMenuItem[] {
		// right-clicking inside the selection acts on all of it, outside on the row
		const rows = selected.has(player.uuid) && selection.length > 1 ? selection : [player];
		const groups = verbs(rows);
		const backend = player.online ? player.server : player.lastServer;

		return menuGroups(
			[
				{
					label: t('web.players.viewProfile'),
					icon: 'user',
					action: () => goto(`/players/${player.uuid}`)
				},
				{
					label: t('web.players.viewOnBackend', { server: backend || '–' }),
					icon: 'userPortrait',
					disabled: !backend,
					hint: backend ? undefined : t('web.players.neverOnABackend'),
					action: () => goto(`/instances/${backend}/players/${player.uuid}`)
				}
			],
			groups.live,
			groups.access,
			[
				{
					id: 'copy-uuid',
					label: t('web.players.copyUuid'),
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

</script>

<svelte:head><title>{t('web.nav.playersList')} | Luna Console</title></svelte:head>

<PageHeader
	title={t('web.players.players')}
	count="{selected.size ? `${selected.size}/` : ''}{players.length}"
	info={t('web.guide.players')}
	description={t('web.players.everyoneTheNetworkHasEver')}
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="players-directory" />
		<Dropdown label={t('web.players.actions')} disabled={selection.length === 0} menu={withCopyResourceId(bulkActions(selection), selection.map((player) => resourceId('player', player.username)))} />
		<Btn icon="userPortrait" href="/players/online">{t('web.playersOnline.onlinePlayers')}</Btn>
	{/snippet}
</PageHeader>

{#if !available}
	<Flash kind="warning">
		<b>{t('web.playerDetail.lunacoreIsNotAnswering')}</b>
		{t('web.playerDetail.lunacoreDownDetail', { problem })}
	</Flash>
{/if}

<StatGrid min={10}>
	<StatTile label={t('web.players.registeredPlayers')} value={loaded && available ? total : null} loading={!loaded} />
	<StatTile
		label={t('web.players.onlineNow')}
		value={loaded && available ? onlineCount : null}
		loading={!loaded}
		href="/players/online"
	/>
	<StatTile
		label={t('web.players.activeThisWeek')}
		value={loaded && available ? activeCount : null}
		secondary={players.length > 0
			? t('web.players.ofRegistered', { percent: Math.round((activeCount / players.length) * 100) })
			: undefined}
		loading={!loaded}
	/>
	<StatTile
		label={t('web.players.newThisWeek')}
		value={loaded && available ? newCount : null}
		loading={!loaded}
	/>
	<StatTile
		label={t('web.players.totalPlaytime')}
		value={loaded && available && players.length > 0 ? totalPlayMillis : null}
		formatValue={fmtDuration}
		loading={!loaded}
	/>
	<StatTile
		label={t('web.players.sessionsRecorded')}
		value={loaded && available ? totalSessions : null}
		loading={!loaded}
	/>
</StatGrid>

<div class="body">
	<Panel flush>
		<ResourceTable
			tableId="players-directory"
			loading={!loaded}
			initialSearch={page.url.searchParams.get('q') ?? ''}
			{columns}
			rows={players}
			getId={(player) => player.uuid}
			searchValue={(player) =>
				`${player.username} ${player.uuid} ${player.lastServer} ${player.lastAddress} ${player.lastClientVersion}`}
			searchPlaceholder={t('web.players.findPlayerByNameBackend')}
			selectable="multi"
			bind:selected
			{rowActions}
			rowLabel={(player) => player.username}
			resourceId={(player) => resourceId('player', player.username)}
			noun={t('web.players.player')}
			{sortValue}
			{filters}
			pageSize={25}
			defaultSort={{ col: 'lastSeen', dir: 'desc' }}
			emptyTitle={t('web.players.noPlayersRecordedYet')}
			emptyText={t('web.players.profilesAppearHereAfterThe')}
		>
			{#snippet cell(player, col)}
				{#if col === 'username'}
					<PlayerName player={player.uuid} name={player.username} />
				{:else if col === 'status'}
					{@const backend = player.online ? player.server : player.lastServer}
					<CellStack>
						{#snippet main()}
							<StatusBadge
								state={player.online ? 'ok' : 'stopped'}
								label={player.online ? t('web.players.online') : t('web.players.offline')}
							/>
						{/snippet}
						{#snippet sub()}
							{#if backend}
								<ScreenLink href="/instances/{backend}/players/{player.uuid}">{backend}</ScreenLink>
							{/if}
						{/snippet}
					</CellStack>
				{:else if col === 'lastSeen'}
					{#if player.online}
						{t('web.players.onFor', { duration: fmtDuration(player.sessionMillis) })}
					{:else if player.lastSeenAtEpochMillis}
						<DateTime at={player.lastSeenAtEpochMillis} text={fmtDateTime(player.lastSeenAtEpochMillis)} />
					{:else}
						<span class="dim">–</span>
					{/if}
				{:else if col === 'playtime'}
					{player.totalPlayMillis ? fmtDuration(player.totalPlayMillis) : '–'}
				{:else if col === 'sessions'}
					{player.sessionCount}
				{:else if col === 'firstSeen'}
					<DateTime
						at={player.firstSeenAtEpochMillis || null}
						text={player.firstSeenAtEpochMillis ? fmtDateTime(player.firstSeenAtEpochMillis) : undefined}
					/>
				{:else if col === 'mode'}
					<StatusBadge
						state={player.onlineMode ? 'passed' : 'warning'}
						label={player.onlineMode ? t('web.players.premium') : t('web.players.offlineAccount')}
					/>
				{:else if col === 'client'}
					<span class="dim">{player.lastClientVersion || '–'}</span>
				{:else if col === 'address'}
					<span class="mono dim">{player.lastAddress || '–'}</span>
				{:else if col === 'uuid'}
					<span class="mono dim">{player.uuid}</span>
				{/if}
			{/snippet}
		</ResourceTable>
	</Panel>

	{#if !one}
		<div class="hint dim">{t('web.players.selectHint')}</div>
	{/if}
</div>

{#if one}
	<DetailPanel
		title={one.username}
		subtitle={one.uuid}
		href="/players/{one.uuid}"
		hrefLabel={t('web.players.viewProfile')}
		bind:location={panelLocation}
		bind:size={panelSize}
		onclose={() => (selected = new Set())}
	>
		{#snippet actions()}
			{#if one.online}
				<StatusBadge state="ok" label={t('web.players.online')} />
			{:else}
				<StatusBadge state="stopped" label={t('web.players.offline')} />
			{/if}
		{/snippet}
		<Tabs
			tabs={[
				{ id: 'details', label: t('web.playerDetail.details') },
				{ id: 'playtime', label: t('web.playerDetail.playtimeByBackend') },
				{ id: 'sessions', label: t('web.playerDetail.sessions') }
			]}
			bind:active={detailTab}
		/>
		<div class="detailbody">
			{#if detailTab === 'details'}
				<div class="pcard">
					<!-- the profile page owns the full 3D viewer; the panel's render is
					     the lighter flat body, enough to recognise a skin at a glance -->
					<div class="pskin"><PlayerSkin player={oneUuid} view="body" px={5} /></div>
					<div class="pfacts">
						<InfoGrid
							cells={detailCells}
							columns={panelLocation === 'right' ? [2, 2, 1] : [4, 3, 2]}
						>
							{#snippet custom(cell)}
								{#if cell.id === 'status'}
									{#if one.online}
										<span class="status">
											<StatusBadge state="ok" label={t('web.players.online')} />
											<span class="dim">{fmtDuration(one.sessionMillis)}</span>
										</span>
									{:else}
										<StatusBadge state="stopped" label={t('web.players.offline')} />
									{/if}
								{/if}
							{/snippet}
						</InfoGrid>
					</div>
				</div>
			{:else if detailTab === 'playtime'}
				{#if playtimeSegments.length > 0}
					<!-- the rows beneath are the legend, with real durations; the bar's own
					     legend would caption each backend with raw milliseconds -->
					<DistributionBar
						segments={playtimeSegments}
						legend={false}
						empty={t('web.playerDetail.noCompletedPlaySessions')}
					/>
					<div class="ptrows">
						{#each panelDetail?.playtimeByServer ?? [] as entry, index}
							<div class="ptrow">
								<i class="swatch" style:background={backendColor(index)}></i>
								<ScreenLink href="/instances/{entry.server}/players/{one.uuid}">{entry.server}</ScreenLink>
								<span class="dim">{fmtDuration(entry.playMillis)}</span>
								<span class="dim stints">×{entry.stints}</span>
							</div>
						{/each}
					</div>
				{:else}
					<p class="dim">
						{panelLoading ? t('web.common.loading') : t('web.playerDetail.noCompletedPlaySessions')}
					</p>
				{/if}
			{:else if panelSessions.length > 0}
				<div class="sesrows">
					{#each panelSessions as session (session.id)}
						<div class="sesrow">
							{#if session.open}
								<StatusBadge state="ok" label={t('web.players.online')} />
							{:else}
								<StatusBadge state="stopped" label={t('web.playerDetail.disconnected')} />
							{/if}
							<ScreenLink href="/instances/{session.server}">{session.server}</ScreenLink>
							<span class="dim"><DateTime at={session.connectedAtEpochMillis} text={fmtDateTime(session.connectedAtEpochMillis)} /></span>
							<span class="dim">{fmtDuration(session.durationMillis)}</span>
						</div>
					{/each}
				</div>
			{:else}
				<p class="dim">
					{panelLoading ? t('web.common.loading') : t('web.playerDetail.noSessionsRecorded')}
				</p>
			{/if}
		</div>
	</DetailPanel>
{/if}

<PlayerActionDialogs bind:this={dialogs} {servers} {instances} ondone={refresh} />

<style lang="scss">
	.body {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		margin-top: 1rem;
	}

	.status {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}

	.hint {
		font-size: 0.75rem;
		text-align: center;
	}

	.detailbody {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 1rem;
		overflow-y: auto;
	}

	.pcard {
		display: flex;
		align-items: flex-start;
		gap: 1.25rem;
	}

	// the skin is decoration beside the facts; it must never squeeze them
	.pskin {
		flex-shrink: 0;
	}

	.pfacts {
		flex: 1;
		min-width: 0;
	}

	.ptrows,
	.sesrows {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.ptrow,
	.sesrow {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		font-size: 0.8125rem;
	}

	.swatch {
		width: 0.625rem;
		height: 0.625rem;
		border-radius: 0.25rem;
	}

	.stints {
		font-variant-numeric: tabular-nums;
	}
</style>
