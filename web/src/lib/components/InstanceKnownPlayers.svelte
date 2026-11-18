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
	import { WEEK_MS, accessFlagsOf, blockCoords, gameModeState } from '$lib/players';
	import type { AccessIndex } from '$lib/players';
	import { GAME_MODES, dimensionLabel } from '$core/playerdata';
	import type { KnownPlayer } from '$core/playerdata';
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
	 * Everyone who has ever played on this backend, online or not.
	 *
	 * The instance's own player saves are the record, because every server
	 * software writes one for every player who joins; the proxy only says which of
	 * them are here now. Each row is as of that player's last save. The verbs are
	 * the same as the online table's: the access lists and a ban work on anybody,
	 * and the ones that need a connection act on whoever of the selection is here.
	 */
	let {
		instance,
		access = null,
		refreshKey = 0,
		count = $bindable(null),
		recent = $bindable(null),
		onchanged
	}: {
		instance: string;
		/** This server's access lists, which the Access column reads */
		access?: AccessIndex | null;
		/** How many players the server holds a save for, once known */
		count?: number | null;
		/** How many of them were here within the last week */
		recent?: number | null;
		/** Bumped by the screen on each refresh tick and each roster change it follows */
		refreshKey?: number;
		/** A verb here changed an access list */
		onchanged?: () => void;
	} = $props();

	interface Row extends KnownPlayer {
		online: boolean;
	}

	/** 20 ticks a second; the stats file counts play time in ticks */
	const TICK_MS = 50;

	let rows: Row[] = $state([]);
	let problem = $state('');
	let instState = $state('unknown');
	let loaded = $state(false);
	let servers: string[] = $state([]);

	let selected: Set<string> = $state(new Set());
	let dialogs: PlayerActionDialogs | undefined = $state();

	const selection = $derived(rows.filter((row) => selected.has(row.uuid)));
	const onlineCount = $derived(rows.filter((row) => row.online).length);

	async function refresh(): Promise<void> {
		try {
			const data = await api(`/instances/${encodeURIComponent(instance)}/players?known=1`);

			problem = data.problem ?? '';
			rows = data.players ?? [];
			count = rows.length;
			recent = rows.filter((row) => Date.now() - lastSeen(row) < WEEK_MS).length;
		} catch (err) {
			problem = (err as Error).message;
		}

		loaded = true;
	}

	/** A verb settled: presence may have changed, and so may the lists. */
	async function settled(): Promise<void> {
		onchanged?.();

		await refresh();
	}

	onMount(() => {
		void refresh();

		void api('/instances').then((data) => {
			instState = data.instances.find((inst: any) => inst.name === instance)?.state ?? 'unknown';
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


	const columns: Column[] = $derived([
		{ id: 'username', label: t('web.instancePlayers.colPlayer'), sortable: true, minWidth: 180 },
		{ id: 'access', label: t('web.playerActions.colAccess'), minWidth: 170 },
		{ id: 'lastSeen', label: t('web.instanceKnownPlayers.colLastSeen'), sortable: true, width: 190 },
		{ id: 'firstJoined', label: t('web.instanceKnownPlayers.colFirstJoined'), sortable: true, width: 180 },
		{ id: 'playTime', label: t('web.instanceKnownPlayers.colPlayTime'), sortable: true, width: 140, align: 'right' },
		{ id: 'gamemode', label: t('web.instancePlayers.colGameMode'), sortable: true, width: 130 },
		{ id: 'location', label: t('web.instancePlayers.colLocation'), sortable: true, minWidth: 200 },
		{ id: 'advancements', label: t('web.instancePlayers.colAdvancements'), sortable: true, width: 140 },
		{ id: 'health', label: t('web.instancePlayers.colHealth'), sortable: true, width: 160, hidden: true },
		{ id: 'xp', label: t('web.instancePlayers.colXp'), sortable: true, width: 160, hidden: true },
		{ id: 'uuid', label: 'UUID', width: 320, hidden: true },
		{ id: 'saved', label: t('web.instancePlayers.colSavedAt'), sortable: true, hidden: true }
	]);

	const filters: TableFilterGroup<Row>[] = $derived([
		{
			id: 'status',
			label: t('web.instanceKnownPlayers.filterStatus'),
			options: [
				{ value: 'any', label: t('web.instanceKnownPlayers.anyStatus') },
				{
					value: 'online',
					label: t('web.instanceKnownPlayers.online'),
					match: (row: Row) => row.online
				},
				{
					value: 'offline',
					label: t('web.instanceKnownPlayers.offline'),
					match: (row: Row) => !row.online
				},
				{
					value: 'week',
					label: t('web.players.seenThisWeek'),
					match: (row: Row) => Date.now() - lastSeen(row) < WEEK_MS
				}
			]
		},
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
		}
	]);

	function displayName(row: Row): string {
		return row.name ?? row.uuid;
	}

	/**
	 * When the player was last here: now while connected, else Paper's own
	 * last-played stamp, else the save's write time, which every software
	 * refreshes on disconnect.
	 */
	function lastSeen(row: Row): number {
		if (row.online) {
			return Date.now();
		}

		return row.vitals?.lastPlayed ?? row.savedAt;
	}

	function sortValue(row: Row, col: string): string | number | null {
		switch (col) {
			case 'username':
				return displayName(row).toLowerCase();

			case 'lastSeen':
				return lastSeen(row);

			case 'firstJoined':
				return row.vitals?.firstPlayed ?? -1;

			case 'playTime':
				return row.playTicks ?? -1;

			case 'health':
				return row.vitals?.health ?? -1;

			case 'xp':
				return row.vitals ? row.vitals.xpLevel + row.vitals.xpProgress : -1;

			case 'gamemode':
				return row.vitals?.gameMode ?? '';

			case 'location':
				return row.vitals ? `${row.vitals.position.dimension} ${row.vitals.position.y}` : '';

			case 'advancements':
				return row.advancements?.done ?? -1;

			case 'saved':
				return row.savedAt;

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
			username: displayName(row),
			online: row.online,
			server: instance
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
			flags: single ? accessFlagsOf(access, { uuid: single.uuid, name: single.name }) : null,
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
							disabled: !row.name,
							hint: row.name ? undefined : t('web.playerActions.noNameOnRecord'),
							action: () => void copyText(displayName(row))
						}
					]
				}
			],
			groups.remove
		);
	}
</script>

<Panel
	title={t('web.instanceKnownPlayers.title')}
	count="{selected.size ? `${selected.size}/` : ''}{rows.length}"
	description={t('web.instanceKnownPlayers.description', { online: onlineCount })}
	flush
>
	{#snippet actions()}
		<Dropdown label={t('web.common.actions')} disabled={selection.length === 0} menu={selectionActions(selection)} />
	{/snippet}

	{#if problem && loaded}
		<div class="pad">
			<Flash kind="warning">
				<b>{t('web.instancePlayers.savesUnreadable')}</b> {problem}
			</Flash>
		</div>
	{/if}

	<ResourceTable
		tableId="instance-known-players"
		{columns}
		{rows}
		loading={!loaded}
		getId={(row) => row.uuid}
		searchValue={(row) =>
			`${row.name ?? ''} ${row.uuid} ${row.vitals?.gameMode ?? ''} ${row.vitals ? dimensionLabel(row.vitals.position.dimension) : ''}`}
		searchPlaceholder={t('web.instancePlayers.findPlayer')}
		searchWidth="20rem"
		selectable="multi"
		bind:selected
		{rowActions}
		rowLabel={displayName}
		resourceId={(row) =>
			row.name
				? resourceId('player', row.name)
				: null}
		rowDim={(row) => !row.online}
		noun={t('web.instancePlayers.nounPlayer')}
		{sortValue}
		{filters}
		pageSize={25}
		defaultSort={{ col: 'lastSeen', dir: 'desc' }}
		emptyTitle={t('web.instanceKnownPlayers.empty')}
		emptyText={t('web.instanceKnownPlayers.emptyHint')}
	>
		{#snippet cell(row, col)}
			{#if col === 'username'}
				<PlayerName player={row.uuid} name={displayName(row)} href={detailPath(row)} />
			{:else if col === 'access'}
				<PlayerAccessBadges
					flags={accessFlagsOf(access, { uuid: row.uuid, name: row.name })}
					whitelistEnabled={access?.whitelistEnabled ?? false}
					dash
				/>
			{:else if col === 'lastSeen'}
				{#if row.online}
					<StatusBadge state="ok" label={t('web.instanceKnownPlayers.online')} />
				{:else}
					<span class="dim"><DateTime at={lastSeen(row)} text={fmtDateTime(lastSeen(row))} /></span>
				{/if}
			{:else if col === 'firstJoined'}
				{#if row.vitals?.firstPlayed}
					<span class="dim"><DateTime at={row.vitals.firstPlayed} text={fmtDateTime(row.vitals.firstPlayed)} /></span>
				{:else}
					<span class="dim" title={t('web.instanceKnownPlayers.firstJoinedUnknown')}>–</span>
				{/if}
			{:else if col === 'playTime'}
				{#if row.playTicks !== null}
					<span class="num">{fmtDuration(row.playTicks * TICK_MS)}</span>
				{:else}
					<span class="dim">–</span>
				{/if}
			{:else if col === 'health'}
				{#if row.vitals}
					<PlayerVitals kind="health" value={row.vitals.health} max={row.vitals.maxHealth} extra={row.vitals.absorption} compact />
				{:else}
					<span class="dim" title={t('web.instancePlayers.noSaveYet')}>–</span>
				{/if}
			{:else if col === 'xp'}
				{#if row.vitals}
					<PlayerVitals kind="xp" value={row.vitals.xpProgress} level={row.vitals.xpLevel} compact />
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
			{:else if col === 'advancements'}
				{#if row.advancements}
					<span class="num">{row.advancements.done} / {row.advancements.total}</span>
				{:else}
					<span class="dim">–</span>
				{/if}
			{:else if col === 'uuid'}
				<CopyValue value={row.uuid} label="UUID" />
			{:else if col === 'saved'}
				<span class="dim"><DateTime at={row.savedAt} text={fmtDateTime(row.savedAt)} /></span>
			{/if}
		{/snippet}
	</ResourceTable>
</Panel>

<PlayerActionDialogs bind:this={dialogs} {instance} {servers} ondone={settled} />

<style lang="scss">
	.pad {
		padding: 1rem 1.25rem 0;
	}

	.num {
		font-variant-numeric: tabular-nums;
	}
</style>
