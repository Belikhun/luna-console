<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { api } from '$lib/api';
	import { copyText } from '$lib/clipboard';
	import { playerVerbGroups } from '$lib/playeractions';
	import type { PlayerActionTarget, PlayerDialogKind } from '$lib/playeractions';
	import { fmtDuration, fmtDateTime } from '$lib/format';
	import { PING_FAIR, PING_POOR, accessFlagsOf, blockCoords, gameModeState, pingClass } from '$lib/players';
	import type { AccessIndex } from '$lib/players';
	import { GAME_MODES, dimensionLabel } from '$core/playerdata';
	import type { PlayerRosterEntry } from '$core/playerdata';
	import Panel from './Panel.svelte';
	import CellStack from './CellStack.svelte';
	import Dropdown from './Dropdown.svelte';
	import DateTime from './DateTime.svelte';
	import Flash from './Flash.svelte';
	import StatusBadge from './StatusBadge.svelte';
	import CopyValue from './CopyValue.svelte';
	import PlayerAccessBadges from './PlayerAccessBadges.svelte';
	import PlayerActionDialogs from './PlayerActionDialogs.svelte';
	import PlayerName from './PlayerName.svelte';
	import PlayerVitals from './PlayerVitals.svelte';
	import ResourceTable from './ResourceTable.svelte';
	import type { Column, TableFilterGroup } from './table';
	import { menuGroups, type ContextMenuItem } from './contextmenu';
	import { resourceId } from '$shared/iam/resources';

	/**
	 * Who is on this backend right now, with what the backend last saved about
	 * each of them.
	 *
	 * The roster, ping, client and session come from the proxy and are live. The
	 * vitals, position, game mode and advancements come from the player's save
	 * under the instance's world, which the server writes on its autosave cadence
	 * and on disconnect; the panel says how old the newest save is rather than
	 * dressing those columns up as live. Joins and leaves refresh the table through
	 * the proxy's player stream, the same way the network-wide page does.
	 */
	let {
		instance,
		access = null,
		refreshKey = 0,
		count = $bindable(null),
		onchanged
	}: {
		instance: string;
		/** This server's access lists, which the Access column reads */
		access?: AccessIndex | null;
		/** How many are online, once known; the tab's summary reads it */
		count?: number | null;
		/** Bumped by the screen on each refresh tick and each roster change it follows */
		refreshKey?: number;
		/** A verb here changed an access list */
		onchanged?: () => void;
	} = $props();

	interface Row {
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
		stintSince: number | null;
		stintMillis: number | null;
		balance: { amount: number; formatted: string } | null;
		vitals: PlayerRosterEntry['vitals'];
		advancements: PlayerRosterEntry['advancements'];
	}

	let rows: Row[] = $state([]);
	let available = $state(true);
	let problem = $state('');
	let savedProblem = $state('');
	let instState = $state('stopped');
	let loaded = $state(false);
	let servers: string[] = $state([]);

	let selected: Set<string> = $state(new Set());
	let dialogs: PlayerActionDialogs | undefined = $state();

	const selection = $derived(rows.filter((row) => selected.has(row.uuid)));

	/** The newest save among the rows; the age the panel reports. */
	const newestSave = $derived(
		rows.reduce((latest, row) => Math.max(latest, row.vitals?.savedAt ?? 0), 0)
	);

	async function refresh(): Promise<void> {
		try {
			const data = await api(`/instances/${encodeURIComponent(instance)}/players`);

			available = data.available !== false;
			problem = available ? '' : (data.error ?? t('web.instancePlayers.lunacoreUnreachable'));
			savedProblem = data.savedProblem ?? '';
			instState = data.state ?? 'stopped';
			rows = data.players ?? [];
			count = available ? rows.length : null;
		} catch (err) {
			available = false;
			problem = (err as Error).message;
		}

		loaded = true;
	}

	/** A verb settled: the roster may have changed, and so may the lists. */
	async function settled(): Promise<void> {
		onchanged?.();

		await refresh();
	}

	onMount(() => {
		void refresh();

		void api('/instances').then((data) => {
			servers = [
				...data.instances
					.filter((inst: any) => inst.name !== 'proxy' && inst.name !== instance)
					.map((inst: any) => inst.name),
				...data.externals.map((inst: any) => inst.name)
			].sort();
		});
	});

	// the first read is onMount's, so the key the table mounted with is not a tick
	let seenKey = untrack(() => refreshKey);

	$effect(() => {
		if (refreshKey === seenKey) {
			return;
		}

		seenKey = refreshKey;
		untrack(() => void refresh());
	});


	// the game facts lead: who, where they stand, how they are doing and where
	// they are. The connection facts and the counters wait in the preferences.
	const columns: Column[] = $derived([
		{ id: 'username', label: t('web.instancePlayers.colPlayer'), sortable: true, minWidth: 180 },
		{ id: 'access', label: t('web.playerActions.colAccess'), minWidth: 170 },
		{ id: 'gamemode', label: t('web.instancePlayers.colGameMode'), sortable: true, width: 130 },
		{ id: 'health', label: t('web.instancePlayers.colHealth'), sortable: true, width: 160 },
		{ id: 'food', label: t('web.instancePlayers.colFood'), sortable: true, width: 160 },
		{ id: 'xp', label: t('web.instancePlayers.colXp'), sortable: true, width: 160 },
		{ id: 'location', label: t('web.instancePlayers.colLocation'), sortable: true, minWidth: 200 },
		{ id: 'stint', label: t('web.instancePlayers.colStint'), sortable: true, width: 130 },
		{ id: 'ping', label: t('web.instancePlayers.colPing'), sortable: true, width: 110, align: 'right' },
		{ id: 'client', label: t('web.instancePlayers.colClient'), sortable: true, width: 130, hidden: true },
		{ id: 'score', label: t('web.instancePlayers.colScore'), sortable: true, width: 120, align: 'right', hidden: true },
		{ id: 'balance', label: t('web.instancePlayers.colBalance'), sortable: true, width: 130, align: 'right', hidden: true },
		{ id: 'advancements', label: t('web.instancePlayers.colAdvancements'), sortable: true, width: 140, hidden: true },
		{ id: 'uuid', label: 'UUID', width: 320, hidden: true },
		{ id: 'session', label: t('web.instancePlayers.colNetworkSession'), sortable: true, hidden: true },
		{ id: 'saved', label: t('web.instancePlayers.colSavedAt'), sortable: true, hidden: true },
		{ id: 'address', label: t('web.instancePlayers.colAddress'), hidden: true }
	]);

	const filters: TableFilterGroup<Row>[] = $derived([
		{
			id: 'gamemode',
			label: t('web.instancePlayers.filterGameMode'),
			options: [
				{ value: 'any', label: t('web.instancePlayers.anyGameMode') },
				...GAME_MODES.map((mode) => ({
					value: mode,
					label: t(`web.instancePlayers.mode.${mode}`),
					match: (row: Row) => row.vitals?.gameMode === mode
				}))
			]
		},
		{
			id: 'ping',
			label: t('web.instancePlayers.filterLatency'),
			options: [
				{ value: 'any', label: t('web.instancePlayers.anyLatency') },
				{
					value: 'good',
					label: t('web.instancePlayers.under', { ms: PING_FAIR }),
					match: (row: Row) => row.pingMillis < PING_FAIR
				},
				{
					value: 'poor',
					label: t('web.instancePlayers.over', { ms: PING_POOR }),
					match: (row: Row) => row.pingMillis >= PING_POOR
				}
			]
		}
	]);

	function sortValue(row: Row, col: string): string | number | null {
		switch (col) {
			case 'username':
				return row.username.toLowerCase();

			case 'client':
				return row.protocolVersion;

			case 'ping':
				return row.pingMillis;

			case 'health':
				return row.vitals?.health ?? -1;

			case 'food':
				return row.vitals?.food ?? -1;

			case 'xp':
				return row.vitals ? row.vitals.xpLevel + row.vitals.xpProgress : -1;

			case 'score':
				return row.vitals?.score ?? -1;

			case 'location':
				return row.vitals ? `${row.vitals.position.dimension} ${row.vitals.position.y}` : '';

			case 'stint':
				return row.stintMillis ?? -1;

			case 'balance':
				return row.balance?.amount ?? -1;

			case 'gamemode':
				return row.vitals?.gameMode ?? '';

			case 'advancements':
				return row.advancements?.done ?? -1;

			case 'session':
				return row.sessionMillis;

			case 'saved':
				return row.vitals?.savedAt ?? 0;

			default:
				return null;
		}
	}

	function detailPath(row: Row): string {
		return `/instances/${encodeURIComponent(instance)}/players/${row.uuid}`;
	}

	// -- verbs --------------------------------------------------------------------

	function targetsOf(list: Row[]): PlayerActionTarget[] {
		return list.map((row) => ({
			uuid: row.uuid,
			username: row.username,
			online: true,
			server: instance,
			address: row.remoteAddress
		}));
	}

	/** The verbs over a set of rows, in the shared order and wording. */
	function verbs(list: Row[]): ReturnType<typeof playerVerbGroups> {
		const single = list.length === 1
			? list[0]
			: undefined;

		return playerVerbGroups({
			targets: targetsOf(list),
			instance,
			running: instState === 'running',
			servers,
			gameModes: GAME_MODES,
			flags: single ? accessFlagsOf(access, { uuid: single.uuid, name: single.username }) : null,
			open: (kind: PlayerDialogKind, targets) => dialogs?.open(kind, targets),
			setGameMode: (targets, mode) => dialogs?.setGameMode(targets, mode)
		});
	}

	/** Verbs over a selection; the panel's Actions dropdown and each row's menu share these. */
	function selectionActions(list: Row[]): ContextMenuItem[] {
		const groups = verbs(list);

		return menuGroups(groups.live, groups.access, groups.remove);
	}

	/** A row's menu: the row's own links and copies around the verbs over the selection it is in. */
	function rowActions(row: Row): ContextMenuItem[] {
		const list = selected.has(row.uuid) && selection.length > 1 ? selection : [row];
		const groups = verbs(list);

		return menuGroups(
			[
				{
					label: t('web.instancePlayers.viewOnThisServer'),
					icon: 'userPortrait',
					action: () => goto(detailPath(row))
				},
				{
					label: t('web.instancePlayers.viewNetworkProfile'),
					icon: 'user',
					action: () => goto(`/players/${row.uuid}`)
				},
				{
					label: t('web.instancePlayers.chatHistoryHere'),
					icon: 'comment',
					action: () => goto(`${detailPath(row)}?tab=chat`)
				}
			],
			groups.live,
			groups.access,
			[
				{
					id: 'copy-menu',
					label: t('web.common.copy'),
					icon: 'copy',
					submenu: [
						{
							id: 'copy-uuid',
							label: t('web.instancePlayers.copyUuid'),
							icon: 'copy',
							action: () => void copyText(row.uuid)
						},
						{
							id: 'copy-name',
							label: t('web.instancePlayers.copyName'),
							icon: 'copy',
							action: () => void copyText(row.username)
						}
					]
				}
			],
			groups.remove
		);
	}
</script>

<Panel
	title={t('web.instancePlayers.title')}
	count="{selected.size ? `${selected.size}/` : ''}{rows.length}"
	description={newestSave
		? t('web.instancePlayers.savedNote', { when: fmtDateTime(newestSave) })
		: t('web.instancePlayers.liveNote')}
	flush
>
	{#snippet actions()}
		<Dropdown label={t('web.common.actions')} disabled={selection.length === 0} menu={selectionActions(selection)} />
	{/snippet}

	{#if !available && loaded}
		<div class="pad">
			<Flash kind="warning">
				<b>{t('web.instancePlayers.lunacoreIsNotAnswering')}</b> {problem}
			</Flash>
		</div>
	{/if}

	{#if savedProblem}
		<div class="pad">
			<Flash kind="warning">
				<b>{t('web.instancePlayers.savesUnreadable')}</b> {savedProblem}
			</Flash>
		</div>
	{/if}

	<ResourceTable
		tableId="instance-online-players"
		{columns}
		rows={rows}
		loading={!loaded}
		getId={(row) => row.uuid}
		searchValue={(row) =>
			`${row.username} ${row.uuid} ${row.clientVersion} ${row.vitals?.gameMode ?? ''} ${row.vitals ? dimensionLabel(row.vitals.position.dimension) : ''}`}
		searchPlaceholder={t('web.instancePlayers.findPlayer')}
		searchWidth="20rem"
		selectable="multi"
		bind:selected
		{rowActions}
		rowLabel={(row) => row.username}
		resourceId={(row) => resourceId('player', row.username)}
		noun={t('web.instancePlayers.nounPlayer')}
		{sortValue}
		{filters}
		pageSize={25}
		defaultSort={{ col: 'username' }}
		emptyTitle={instState === 'running'
			? t('web.instancePlayers.nobodyOnline')
			: t('web.instancePlayers.notRunning')}
		emptyText={instState === 'running'
			? t('web.instancePlayers.nobodyOnlineHint')
			: t('web.instancePlayers.notRunningHint')}
	>
		{#snippet cell(row, col)}
			{#if col === 'username'}
				<PlayerName player={row.uuid} name={row.username} href={detailPath(row)} />
			{:else if col === 'access'}
				<PlayerAccessBadges
					flags={accessFlagsOf(access, { uuid: row.uuid, name: row.username })}
					whitelistEnabled={access?.whitelistEnabled ?? false}
					dash
				/>
			{:else if col === 'client'}
				<span title={t('web.instancePlayers.protocol', { protocol: row.protocolVersion })}>
					{row.clientVersion}
				</span>
			{:else if col === 'ping'}
				<CellStack align="right">
					{#snippet main()}
						<span class="ping {pingClass(row.pingMillis)}">{row.pingMillis} ms</span>
					{/snippet}
					{#snippet sub()}
						{row.clientVersion}
					{/snippet}
				</CellStack>
			{:else if col === 'health'}
				{#if row.vitals}
					<PlayerVitals kind="health" value={row.vitals.health} max={row.vitals.maxHealth} extra={row.vitals.absorption} compact />
				{:else}
					<span class="dim" title={t('web.instancePlayers.noSaveYet')}>–</span>
				{/if}
			{:else if col === 'food'}
				{#if row.vitals}
					<PlayerVitals kind="food" value={row.vitals.food} compact />
				{:else}
					<span class="dim">–</span>
				{/if}
			{:else if col === 'xp'}
				{#if row.vitals}
					<PlayerVitals kind="xp" value={row.vitals.xpProgress} level={row.vitals.xpLevel} compact />
				{:else}
					<span class="dim">–</span>
				{/if}
			{:else if col === 'score'}
				{#if row.vitals}
					<span class="num">{row.vitals.score.toLocaleString()}</span>
				{:else}
					<span class="dim">–</span>
				{/if}
			{:else if col === 'location'}
				{#if row.vitals}
					{@const position = row.vitals.position}
					<CellStack>
						{#snippet main()}
							<span class="mono">{blockCoords(position)}</span>
						{/snippet}
						{#snippet sub()}
							{dimensionLabel(position.dimension)}
						{/snippet}
					</CellStack>
				{:else}
					<span class="dim">–</span>
				{/if}
			{:else if col === 'stint'}
				{#if row.stintMillis !== null}
					<DateTime at={row.stintSince} text={fmtDuration(row.stintMillis)} empty={fmtDuration(row.stintMillis)} />
				{:else}
					<span class="dim" title={fmtDuration(row.sessionMillis)}>–</span>
				{/if}
			{:else if col === 'balance'}
				{#if row.balance}
					<span class="num">{row.balance.formatted}</span>
				{:else}
					<span class="dim">–</span>
				{/if}
			{:else if col === 'gamemode'}
				{#if row.vitals}
					<StatusBadge
						state={gameModeState(row.vitals.gameMode)}
						label={t(`web.instancePlayers.mode.${row.vitals.gameMode}`)}
					/>
				{:else}
					<span class="dim">–</span>
				{/if}
			{:else if col === 'advancements'}
				{#if row.advancements}
					<span class="num">{row.advancements.done} / {row.advancements.total}</span>
				{:else}
					<span class="dim">–</span>
				{/if}
			{:else if col === 'uuid'}
				<CopyValue value={row.uuid} label="UUID" />
			{:else if col === 'session'}
				<DateTime at={row.connectedAtEpochMillis} text={fmtDuration(row.sessionMillis)} />
			{:else if col === 'saved'}
				{#if row.vitals}
					<span class="dim"><DateTime at={row.vitals.savedAt} text={fmtDateTime(row.vitals.savedAt)} /></span>
				{:else}
					<span class="dim">–</span>
				{/if}
			{:else if col === 'address'}
				<span class="mono dim">{row.remoteAddress}</span>
			{/if}
		{/snippet}
	</ResourceTable>
</Panel>

<PlayerActionDialogs bind:this={dialogs} {instance} {servers} ondone={settled} />

<style lang="scss">
	.pad {
		padding: 1rem 1.25rem 0;
	}

	// latency bands, the same scale as the network-wide players page
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

	.num {
		font-variant-numeric: tabular-nums;
	}
</style>
