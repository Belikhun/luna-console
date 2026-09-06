<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { api } from '$lib/api';
	import { copyText } from '$lib/clipboard';
	import {
		banAddressOnNetwork,
		bareAddress,
		kickPlayers,
		messagePlayers,
		moderatePlayers,
		resendPacks as resendPacksTo,
		setGameMode as setGameModeOn,
		targetNames,
		transferPlayers
	} from '$lib/playeractions';
	import type { ModerationAction } from '$lib/playeractions';
	import { fmtDuration, fmtDateTime, fmtTime } from '$lib/format';
	import { PING_FAIR, PING_POOR, pingClass } from '$lib/players';
	import { GAME_MODES, dimensionLabel } from '$core/playerdata';
	import type { GameMode, PlayerRosterEntry } from '$core/playerdata';
	import Panel from './Panel.svelte';
	import Btn from './Btn.svelte';
	import Dropdown from './Dropdown.svelte';
	import Select from './Select.svelte';
	import Modal from './Modal.svelte';
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
	let { instance }: { instance: string } = $props();

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
	let lastUpdated: number | null = $state(null);
	let servers: string[] = $state([]);

	let selected: Set<string> = $state(new Set());

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
			lastUpdated = Date.now();
		} catch (err) {
			available = false;
			problem = (err as Error).message;
		}

		loaded = true;
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

			transferTo = servers[0] ?? '';
		});

		const stream = new EventSource('/api/luna/stream?stream=players');

		stream.onmessage = () => void refresh();

		return () => stream.close();
	});

	const columns: Column[] = $derived([
		{ id: 'username', label: t('web.instancePlayers.colPlayer'), sortable: true, minWidth: 180 },
		{ id: 'client', label: t('web.instancePlayers.colClient'), sortable: true, width: 130 },
		{ id: 'ping', label: t('web.instancePlayers.colPing'), sortable: true, width: 100, align: 'right' },
		{ id: 'health', label: t('web.instancePlayers.colHealth'), sortable: true, width: 160 },
		{ id: 'food', label: t('web.instancePlayers.colFood'), sortable: true, width: 160 },
		{ id: 'xp', label: t('web.instancePlayers.colXp'), sortable: true, width: 160 },
		{ id: 'score', label: t('web.instancePlayers.colScore'), sortable: true, width: 120, align: 'right' },
		{ id: 'location', label: t('web.instancePlayers.colLocation'), sortable: true, minWidth: 200 },
		{ id: 'stint', label: t('web.instancePlayers.colStint'), sortable: true, width: 130 },
		{ id: 'balance', label: t('web.instancePlayers.colBalance'), sortable: true, width: 130, align: 'right' },
		{ id: 'gamemode', label: t('web.instancePlayers.colGameMode'), sortable: true, width: 130 },
		{ id: 'advancements', label: t('web.instancePlayers.colAdvancements'), sortable: true, width: 140 },
		{ id: 'uuid', label: 'UUID', width: 320 },
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

	let messageOpen = $state(false);
	let messageText = $state('');
	let transferOpen = $state(false);
	let transferTo = $state('');
	let kickOpen = $state(false);
	let kickReason = $state('');
	let banOpen = $state(false);
	let banReason = $state('');
	let ipBanOpen = $state(false);
	let ipBanReason = $state('');
	let pending: Row[] = $state([]);

	function names(targets: Row[]): string {
		return targetNames(targets);
	}

	/** Run an action and report it; failures name the verb they belong to. */
	async function act(work: () => Promise<string>, busy: string): Promise<void> {
		const note = Notify.loading(busy);

		try {
			const done = await work();

			note.set({ level: 'success', message: done, closeable: true });

			await refresh();
		} catch (err) {
			note.set({ level: 'error', message: busy, detail: (err as Error).message, closeable: true });
		}
	}

	/**
	 * Access-list verbs go through the moderation route, which fans one verb out
	 * over every target on this instance and records each in the player's
	 * moderation log; the same door the directory screen uses.
	 */
	async function moderate(action: ModerationAction, targets: Row[], reason = ''): Promise<string> {
		const summary = await moderatePlayers(action, targets, [instance], reason);

		if (summary.unconfirmed.length > 0) {
			Notify.warning(t('web.instancePlayers.unconfirmed', { targets: summary.unconfirmed.join(', ') }));
		}

		return t('web.instancePlayers.applied', { action: t(`web.instancePlayers.verb.${action}`), targets: names(targets) });
	}

	async function doMessage(): Promise<void> {
		const targets = pending;
		const text = messageText.trim();

		messageOpen = false;

		if (targets.length === 0 || !text) {
			return;
		}

		await act(async () => {
			await messagePlayers(targets, text);

			return t('web.instancePlayers.messageDelivered', { targets: names(targets) });
		}, t('web.instancePlayers.sendingMessage', { targets: names(targets) }));

		messageText = '';
	}

	async function doTransfer(): Promise<void> {
		const targets = pending;
		const to = transferTo;

		transferOpen = false;

		if (targets.length === 0 || !to) {
			return;
		}

		await act(async () => {
			await transferPlayers(targets, to);

			return t('web.instancePlayers.moved', { targets: names(targets), server: to });
		}, t('web.instancePlayers.moving', { targets: names(targets), server: to }));
	}

	async function doKick(): Promise<void> {
		const targets = pending;
		const reason = kickReason.trim();

		kickOpen = false;

		if (targets.length === 0) {
			return;
		}

		await act(async () => {
			await kickPlayers(targets, reason);

			return t('web.instancePlayers.disconnected', { targets: names(targets) });
		}, t('web.instancePlayers.disconnecting', { targets: names(targets) }));

		kickReason = '';
	}

	async function doBan(): Promise<void> {
		const targets = pending;
		const reason = banReason.trim();

		banOpen = false;

		if (targets.length === 0) {
			return;
		}

		await act(() => moderate('ban', targets, reason), t('web.instancePlayers.banning', { targets: names(targets) }));

		banReason = '';
	}

	/**
	 * A network-level ban of the player's address: the proxy refuses it at
	 * pre-login, so the same connection cannot come back as another account.
	 */
	async function doIpBan(): Promise<void> {
		const targets = pending;
		const reason = ipBanReason.trim();

		ipBanOpen = false;

		if (targets.length === 0) {
			return;
		}

		await act(async () => {
			for (const row of targets) {
				await banAddressOnNetwork(bareAddress(row.remoteAddress), reason);
			}

			return t('web.instancePlayers.ipBanned', { targets: names(targets) });
		}, t('web.instancePlayers.ipBanning', { targets: names(targets) }));

		ipBanReason = '';
	}

	async function setGameMode(targets: Row[], mode: GameMode): Promise<void> {
		await act(async () => {
			await setGameModeOn(instance, targets, mode);

			return t('web.instancePlayers.gameModeSet', { targets: names(targets), mode: t(`web.instancePlayers.mode.${mode}`) });
		}, t('web.instancePlayers.settingGameMode', { targets: names(targets) }));
	}

	async function resendPacks(targets: Row[]): Promise<void> {
		await act(async () => {
			await resendPacksTo(targets);

			return t('web.instancePlayers.resentPacks', { targets: names(targets) });
		}, t('web.instancePlayers.resendingPacks', { targets: names(targets) }));
	}

	function open(dialog: 'message' | 'transfer' | 'kick' | 'ban' | 'ipban', targets: Row[]): void {
		pending = targets;

		if (dialog === 'message') {
			messageOpen = true;
		} else if (dialog === 'transfer') {
			transferOpen = true;
		} else if (dialog === 'kick') {
			kickOpen = true;
		} else if (dialog === 'ban') {
			banOpen = true;
		} else {
			ipBanOpen = true;
		}
	}

	/** Verbs over a selection; the panel's Actions dropdown and each row's menu share these. */
	function selectionActions(targets: Row[]): ContextMenuItem[] {
		const none = targets.length === 0;
		const noneHint = none ? t('web.instancePlayers.selectFirst') : undefined;
		const running = instState === 'running';

		return [
			{
				label: t('web.instancePlayers.sendAMessage'),
				icon: 'paperPlane',
				disabled: none,
				hint: noneHint,
				action: () => open('message', targets)
			},
			{
				label: t('web.instancePlayers.moveToAnotherBackend'),
				icon: 'rightLeft',
				disabled: none || servers.length === 0,
				hint: noneHint ?? (servers.length === 0 ? t('web.instancePlayers.noOtherBackend') : undefined),
				action: () => open('transfer', targets)
			},
			{
				label: t('web.instancePlayers.resendPacks'),
				icon: 'image',
				disabled: none,
				hint: noneHint,
				action: () => void resendPacks(targets)
			},
			{
				label: t('web.instancePlayers.setGameMode'),
				icon: 'joystick',
				disabled: none || !running,
				hint: noneHint ?? (running ? undefined : t('web.instancePlayers.needsRunning')),
				submenu: GAME_MODES.map((mode) => ({
					label: t(`web.instancePlayers.mode.${mode}`),
					action: () => void setGameMode(targets, mode)
				}))
			},
			{ separator: true },
			{
				label: t('web.instancePlayers.addToWhitelist'),
				icon: 'userTick',
				disabled: none,
				hint: noneHint,
				action: () => void act(() => moderate('whitelist-add', targets), t('web.instancePlayers.updatingLists'))
			},
			{
				label: t('web.instancePlayers.removeFromWhitelist'),
				icon: 'userMinus',
				disabled: none,
				hint: noneHint,
				action: () => void act(() => moderate('whitelist-remove', targets), t('web.instancePlayers.updatingLists'))
			},
			{
				label: t('web.instancePlayers.grantOperator'),
				icon: 'userCog',
				disabled: none,
				hint: noneHint,
				action: () => void act(() => moderate('op', targets), t('web.instancePlayers.updatingLists'))
			},
			{
				label: t('web.instancePlayers.revokeOperator'),
				icon: 'userLock',
				disabled: none,
				hint: noneHint,
				action: () => void act(() => moderate('deop', targets), t('web.instancePlayers.updatingLists'))
			},
			{ separator: true },
			{
				label: t('web.instancePlayers.disconnect'),
				icon: 'userSlash',
				color: 'danger',
				disabled: none,
				hint: noneHint,
				action: () => open('kick', targets)
			},
			{
				label: t('web.instancePlayers.banHere'),
				icon: 'gavel',
				color: 'danger',
				disabled: none,
				hint: noneHint,
				action: () => open('ban', targets)
			},
			{
				label: t('web.instancePlayers.banAddressOnNetwork'),
				icon: 'ban',
				color: 'danger',
				disabled: none,
				hint: noneHint,
				action: () => open('ipban', targets)
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
				action: () => void copyText(row.username)
			},
			{ separator: true },
			...selectionActions(targets)
		];
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
		<Btn icon="rotate" onclick={refresh} title={lastUpdated ? fmtTime(lastUpdated) : ''}>
			{t('web.common.refresh')}
		</Btn>
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
		getId={(row) => row.uuid}
		searchValue={(row) =>
			`${row.username} ${row.uuid} ${row.clientVersion} ${row.vitals?.gameMode ?? ''} ${row.vitals ? dimensionLabel(row.vitals.position.dimension) : ''}`}
		searchPlaceholder={t('web.instancePlayers.findPlayer')}
		searchWidth="20rem"
		selectable="multi"
		bind:selected
		{rowActions}
		rowLabel={(row) => row.username}
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
			{:else if col === 'client'}
				<span title={t('web.instancePlayers.protocol', { protocol: row.protocolVersion })}>
					{row.clientVersion}
				</span>
			{:else if col === 'ping'}
				<span class="ping {pingClass(row.pingMillis)}">{row.pingMillis} ms</span>
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
					<span class="loc">
						<span class="dim-label">{dimensionLabel(row.vitals.position.dimension)}</span>
						<span class="mono">{coords(row)}</span>
					</span>
				{:else}
					<span class="dim">–</span>
				{/if}
			{:else if col === 'stint'}
				{#if row.stintMillis !== null}
					<span title={row.stintSince ? fmtDateTime(row.stintSince) : ''}>{fmtDuration(row.stintMillis)}</span>
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
			{:else if col === 'advancements'}
				{#if row.advancements}
					<span class="num">{row.advancements.done} / {row.advancements.total}</span>
				{:else}
					<span class="dim">–</span>
				{/if}
			{:else if col === 'uuid'}
				<CopyValue value={row.uuid} label="UUID" />
			{:else if col === 'session'}
				<span title={fmtDateTime(row.connectedAtEpochMillis)}>{fmtDuration(row.sessionMillis)}</span>
			{:else if col === 'saved'}
				{#if row.vitals}
					<span class="dim">{fmtDateTime(row.vitals.savedAt)}</span>
				{:else}
					<span class="dim">–</span>
				{/if}
			{:else if col === 'address'}
				<span class="mono dim">{row.remoteAddress}</span>
			{/if}
		{/snippet}
	</ResourceTable>
</Panel>

<Modal title={t('web.instancePlayers.messageTitle', { targets: names(pending) })} bind:open={messageOpen}>
	<label class="field">
		<span class="lbl">{t('web.instancePlayers.message')}</span>
		<span class="hint">{t('web.instancePlayers.messageHint')}</span>
		<input class="input" bind:value={messageText} placeholder={t('web.instancePlayers.typeAMessage')} />
	</label>
	{#snippet footer()}
		<Btn onclick={() => (messageOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="primary" disabled={!messageText.trim()} onclick={doMessage}>{t('web.instancePlayers.send')}</Btn>
	{/snippet}
</Modal>

<Modal title={t('web.instancePlayers.moveTitle', { targets: names(pending) })} bind:open={transferOpen}>
	<p>{t('web.instancePlayers.moveHint')}</p>
	<div class="field">
		<span class="lbl">{t('web.instancePlayers.destination')}</span>
		<Select bind:value={transferTo} width="100%" options={servers.map((name) => ({ value: name, label: name }))} />
	</div>
	{#snippet footer()}
		<Btn onclick={() => (transferOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="primary" disabled={!transferTo} onclick={doTransfer}>{t('web.instancePlayers.move')}</Btn>
	{/snippet}
</Modal>

<Modal title={t('web.instancePlayers.disconnectTitle', { targets: names(pending) })} bind:open={kickOpen}>
	<p>{t('web.instancePlayers.disconnectHint')}</p>
	<label class="field">
		<span class="lbl">{t('web.instancePlayers.reasonShown')}</span>
		<input class="input" bind:value={kickReason} placeholder={t('web.instancePlayers.reasonOptional')} />
	</label>
	{#snippet footer()}
		<Btn onclick={() => (kickOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="danger" onclick={doKick}>{t('web.instancePlayers.disconnect')}</Btn>
	{/snippet}
</Modal>

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

<ConfirmModal
	bind:open={ipBanOpen}
	title={t('web.instancePlayers.ipBanTitle', { targets: names(pending) })}
	lead={t('web.instancePlayers.ipBanLead', { addresses: pending.map((row) => row.remoteAddress).join(', ') })}
	notes={[t('web.instancePlayers.ipBanNote')]}
	confirmLabel={t('web.instancePlayers.banAddress')}
	onconfirm={doIpBan}
>
	<label class="field">
		<span class="lbl">{t('web.instancePlayers.reason')}</span>
		<input class="input" bind:value={ipBanReason} placeholder={t('web.instancePlayers.reasonOptional')} />
	</label>
</ConfirmModal>

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
