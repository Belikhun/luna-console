<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { api } from '$lib/api';
	import { copyText } from '$lib/clipboard';
	import { moderatePlayers, targetNames } from '$lib/playeractions';
	import type { ModerationAction, PlayerTarget } from '$lib/playeractions';
	import { fmtDuration, fmtDateTime, fmtTime } from '$lib/format';
	import { GAME_MODES, dimensionLabel } from '$core/playerdata';
	import type { KnownPlayer } from '$core/playerdata';
	import Panel from './Panel.svelte';
	import Btn from './Btn.svelte';
	import Dropdown from './Dropdown.svelte';
	import ConfirmModal from './ConfirmModal.svelte';
	import Flash from './Flash.svelte';
	import StatusBadge from './StatusBadge.svelte';
	import CopyValue from './CopyValue.svelte';
	import PlayerName from './PlayerName.svelte';
	import PlayerVitals from './PlayerVitals.svelte';
	import ResourceTable from './ResourceTable.svelte';
	import type { Column, TableFilterGroup } from './table';
	import type { ContextMenuItem } from './contextmenu';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * Everyone who has ever played on this backend, online or not.
	 *
	 * The instance's own player saves are the record, because every server
	 * software writes one for every player who joins; the proxy only says which of
	 * them are here now. Each row is as of that player's last save, and the verbs
	 * are the ones that work on somebody who is not connected: access lists and a
	 * ban on this server. Disconnecting, messaging and moving belong to the online
	 * table above.
	 */
	let { instance }: { instance: string } = $props();

	interface Row extends KnownPlayer {
		online: boolean;
	}

	/** 20 ticks a second; the stats file counts play time in ticks */
	const TICK_MS = 50;

	let rows: Row[] = $state([]);
	let problem = $state('');
	let loaded = $state(false);
	let lastUpdated: number | null = $state(null);

	let selected: Set<string> = $state(new Set());

	const selection = $derived(rows.filter((row) => selected.has(row.uuid)));
	const onlineCount = $derived(rows.filter((row) => row.online).length);

	async function refresh(): Promise<void> {
		try {
			const data = await api(`/instances/${encodeURIComponent(instance)}/players?known=1`);

			problem = data.problem ?? '';
			rows = data.players ?? [];
			lastUpdated = Date.now();
		} catch (err) {
			problem = (err as Error).message;
		}

		loaded = true;
	}

	onMount(() => {
		void refresh();

		// a join is what moves somebody to "online", and a first join is what adds a row
		const stream = new EventSource('/api/luna/stream?stream=players');

		stream.onmessage = () => void refresh();

		return () => stream.close();
	});

	const columns: Column[] = $derived([
		{ id: 'username', label: t('web.instancePlayers.colPlayer'), sortable: true, minWidth: 180 },
		{ id: 'status', label: t('web.instanceKnownPlayers.colStatus'), sortable: true, width: 120 },
		{ id: 'lastSeen', label: t('web.instanceKnownPlayers.colLastSeen'), sortable: true, width: 180 },
		{ id: 'firstJoined', label: t('web.instanceKnownPlayers.colFirstJoined'), sortable: true, width: 180 },
		{ id: 'playTime', label: t('web.instanceKnownPlayers.colPlayTime'), sortable: true, width: 140, align: 'right' },
		{ id: 'health', label: t('web.instancePlayers.colHealth'), sortable: true, width: 160 },
		{ id: 'xp', label: t('web.instancePlayers.colXp'), sortable: true, width: 160 },
		{ id: 'gamemode', label: t('web.instancePlayers.colGameMode'), sortable: true, width: 130 },
		{ id: 'location', label: t('web.instancePlayers.colLocation'), sortable: true, minWidth: 200 },
		{ id: 'advancements', label: t('web.instancePlayers.colAdvancements'), sortable: true, width: 140 },
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

			case 'status':
				return row.online ? 1 : 0;

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

	function coords(row: Row): string {
		const pos = row.vitals?.position;

		if (!pos) {
			return '';
		}

		return `${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)}`;
	}

	function detailPath(row: Row): string {
		return `/instances/${encodeURIComponent(instance)}/players/${row.uuid}`;
	}

	// -- verbs --------------------------------------------------------------------

	let banOpen = $state(false);
	let banReason = $state('');
	let pending: Row[] = $state([]);

	function targetsOf(rows: Row[]): PlayerTarget[] {
		return rows.map((row) => ({ uuid: row.uuid, username: displayName(row) }));
	}

	function names(targets: Row[]): string {
		return targetNames(targetsOf(targets));
	}

	/**
	 * Access-list verbs go through the moderation route, the same door the online
	 * table and the directory screen use, so each lands in the player's
	 * moderation log whether or not they are connected.
	 */
	async function moderate(action: ModerationAction, targets: Row[], reason = ''): Promise<void> {
		const busy = t('web.instancePlayers.updatingLists');
		const note = Notify.loading(busy);

		try {
			const summary = await moderatePlayers(action, targetsOf(targets), [instance], reason);

			if (summary.unconfirmed.length > 0) {
				Notify.warning(t('web.instancePlayers.unconfirmed', { targets: summary.unconfirmed.join(', ') }));
			}

			note.set({
				level: 'success',
				message: t('web.instancePlayers.applied', {
					action: t(`web.instancePlayers.verb.${action}`),
					targets: names(targets)
				}),
				closeable: true
			});
		} catch (err) {
			note.set({ level: 'error', message: busy, detail: (err as Error).message, closeable: true });
		}
	}

	async function doBan(): Promise<void> {
		const targets = pending;
		const reason = banReason.trim();

		banOpen = false;

		if (targets.length === 0) {
			return;
		}

		await moderate('ban', targets, reason);

		banReason = '';
	}

	/** Verbs over a selection; the panel's Actions dropdown and each row's menu share these. */
	function selectionActions(targets: Row[]): ContextMenuItem[] {
		const none = targets.length === 0;
		const noneHint = none ? t('web.instancePlayers.selectFirst') : undefined;

		return [
			{
				label: t('web.instancePlayers.addToWhitelist'),
				icon: 'userTick',
				disabled: none,
				hint: noneHint,
				action: () => void moderate('whitelist-add', targets)
			},
			{
				label: t('web.instancePlayers.removeFromWhitelist'),
				icon: 'userMinus',
				disabled: none,
				hint: noneHint,
				action: () => void moderate('whitelist-remove', targets)
			},
			{
				label: t('web.instancePlayers.grantOperator'),
				icon: 'userCog',
				disabled: none,
				hint: noneHint,
				action: () => void moderate('op', targets)
			},
			{
				label: t('web.instancePlayers.revokeOperator'),
				icon: 'userLock',
				disabled: none,
				hint: noneHint,
				action: () => void moderate('deop', targets)
			},
			{ separator: true },
			{
				label: t('web.instancePlayers.banHere'),
				icon: 'gavel',
				color: 'danger',
				disabled: none,
				hint: noneHint,
				action: () => {
					pending = targets;
					banOpen = true;
				}
			}
		];
	}

	/** A row's menu: the row's own links first, then the verbs over the selection it is in. */
	function rowActions(row: Row): ContextMenuItem[] {
		const targets = selected.has(row.uuid) && selection.length > 1 ? selection : [row];

		return [
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
			},
			{
				label: t('web.instancePlayers.copyUuid'),
				icon: 'copy',
				action: () => void copyText(row.uuid)
			},
			{
				label: t('web.instancePlayers.copyName'),
				icon: 'copy',
				disabled: !row.name,
				action: () => void copyText(displayName(row))
			},
			{ separator: true },
			...selectionActions(targets)
		];
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
		<Btn icon="rotate" onclick={refresh} title={lastUpdated ? fmtTime(lastUpdated) : ''}>
			{t('web.common.refresh')}
		</Btn>
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
		getId={(row) => row.uuid}
		searchValue={(row) =>
			`${row.name ?? ''} ${row.uuid} ${row.vitals?.gameMode ?? ''} ${row.vitals ? dimensionLabel(row.vitals.position.dimension) : ''}`}
		searchPlaceholder={t('web.instancePlayers.findPlayer')}
		searchWidth="20rem"
		selectable="multi"
		bind:selected
		{rowActions}
		rowLabel={displayName}
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
			{:else if col === 'status'}
				<StatusBadge
					state={row.online ? 'ok' : 'stopped'}
					label={row.online ? t('web.instanceKnownPlayers.online') : t('web.instanceKnownPlayers.offline')}
				/>
			{:else if col === 'lastSeen'}
				{#if row.online}
					{t('web.instanceKnownPlayers.now')}
				{:else}
					<span class="dim">{fmtDateTime(lastSeen(row))}</span>
				{/if}
			{:else if col === 'firstJoined'}
				{#if row.vitals?.firstPlayed}
					<span class="dim">{fmtDateTime(row.vitals.firstPlayed)}</span>
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
						state={row.vitals.gameMode === 'survival'
							? 'ok'
							: row.vitals.gameMode === 'creative'
								? 'warning'
								: row.vitals.gameMode === 'spectator'
									? 'stopped'
									: 'info'}
						label={t(`web.instancePlayers.mode.${row.vitals.gameMode}`)}
					/>
				{:else}
					<span class="dim">–</span>
				{/if}
			{:else if col === 'location'}
				{#if row.vitals}
					<span class="loc">
						<span class="dim-label">{dimensionLabel(row.vitals.position.dimension)}</span>
						<span class="mono">{coords(row)}</span>
					</span>
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
				<span class="dim">{fmtDateTime(row.savedAt)}</span>
			{/if}
		{/snippet}
	</ResourceTable>
</Panel>

<ConfirmModal
	bind:open={banOpen}
	title={t('web.instancePlayers.banTitle', { targets: names(pending) })}
	lead={t('web.instancePlayers.banLead', { instance })}
	notes={[t('web.instancePlayers.banNote')]}
	confirmLabel={t('web.instancePlayers.ban')}
	onconfirm={doBan}
>
	<label class="field">
		<span class="lbl">{t('web.instancePlayers.reason')}</span>
		<input class="input" bind:value={banReason} placeholder={t('web.instancePlayers.reasonOptional')} />
	</label>
</ConfirmModal>

<style lang="scss">
	.pad {
		padding: 1rem 1.25rem 0;
	}

	.num {
		font-variant-numeric: tabular-nums;
	}

	.loc {
		display: inline-flex;
		flex-direction: column;
		line-height: 1.25;
	}

	.dim-label {
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.field {
		margin-top: 0.75rem;
	}
</style>
