<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api } from '$lib/api';
	import { copyText } from '$lib/clipboard';
	import { fmtDuration, fmtDateTime } from '$lib/format';
	import { LOG_PAGE, loadWholeLog } from '$lib/log';
	import { pingClass } from '$lib/players';
	import {
		kickPlayers,
		messagePlayers,
		moderatePlayers,
		resendPacks,
		setGameMode,
		transferPlayers
	} from '$lib/playeractions';
	import type { ModerationAction } from '$lib/playeractions';
	import {
		GAME_MODES,
		advancementGroup,
		dimensionLabel,
		idLabel,
		ticksToMillis
	} from '$core/playerdata';
	import type { GameMode, PlayerAdvancement, PlayerDetail, PlayerPosition } from '$core/playerdata';
	import type { LunaPlayer, RegisteredPlayerDetail, VaultAccountInfo } from '$core/services/luna';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Select from '$lib/components/Select.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import Tabs from '$lib/components/Tabs.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import type { InfoCell } from '$lib/components/grid';
	import OverviewBar from '$lib/components/OverviewBar.svelte';
	import OverviewCell from '$lib/components/OverviewCell.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import PlayerSkin3D from '$lib/components/PlayerSkin3D.svelte';
	import PlayerVitals from '$lib/components/PlayerVitals.svelte';
	import PlayerInventory from '$lib/components/PlayerInventory.svelte';
	import InstanceChatLog from '$lib/components/InstanceChatLog.svelte';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * One player on one backend: what the backend last saved about them (vitals,
	 * position, inventory, ender chest, advancements, statistics) beside what the
	 * proxy knows (presence, ping, profile, balance), with their play history, chat
	 * and moderation record narrowed to this server.
	 *
	 * The network-wide profile at `/players/<uuid>` stays the place for the account,
	 * permissions, skin and wallet; this screen is the instance's view, and links
	 * there for the rest.
	 */

	interface Payload {
		instance: string;
		uuid: string;
		username: string;
		online: boolean;
		live: LunaPlayer | null;
		lunaAvailable: boolean;
		lunaError?: string;
		profile: RegisteredPlayerDetail | null;
		vault: VaultAccountInfo | null;
		detail: PlayerDetail;
	}

	interface Session {
		id: number;
		server: string;
		connectedAtEpochMillis: number;
		disconnectedAtEpochMillis: number;
		durationMillis: number;
		open: boolean;
	}

	interface ModEntry {
		id: number;
		action: string;
		actor: string;
		reason: string;
		server: string;
		details: string;
		atEpochMillis: number;
	}

	interface StatRow {
		section: string;
		key: string;
		value: number;
	}

	const instance = $derived(page.params.name ?? '');
	const ref = $derived(page.params.player ?? '');

	const TABS = ['overview', 'inventory', 'advancements', 'stats', 'sessions', 'chat', 'moderation'] as const;

	type Tab = (typeof TABS)[number];

	let data = $state<Payload | null>(null);
	let notFound = $state(false);
	let problem = $state('');
	let loading = $state(true);
	let lastUpdated: number | null = $state(null);
	let tab: string = $state(pickInitialTab());

	let sessions: Session[] = $state([]);
	let sessionsTotal = $state(0);
	let moderation: ModEntry[] = $state([]);
	let servers: string[] = $state([]);

	function pickInitialTab(): Tab {
		const wanted = page.url.searchParams.get('tab');

		return (TABS as readonly string[]).includes(wanted ?? '') ? (wanted as Tab) : 'overview';
	}

	const snapshot = $derived(data?.detail.snapshot ?? null);
	const target = $derived(data ? { username: data.username, uuid: data.uuid } : null);

	async function refresh(): Promise<void> {
		loading = true;

		try {
			data = await api(`/instances/${encodeURIComponent(instance)}/players/${encodeURIComponent(ref)}`);
			notFound = false;
			problem = '';
			lastUpdated = Date.now();
		} catch (err) {
			notFound = true;
			problem = (err as Error).message;
		}

		loading = false;

		if (data) {
			void loadTab(tab);
		}
	}

	async function loadSessions(): Promise<void> {
		if (!data) {
			return;
		}

		const uuid = data.uuid;
		const result = await loadWholeLog<Session>(async (offset) => {
			const more = await api(
				`/players/${uuid}/sessions?server=${encodeURIComponent(instance)}&limit=${LOG_PAGE}&offset=${offset}`
			);

			return more.available === false ? { total: 0, rows: [] } : { total: more.total ?? 0, rows: more.sessions ?? [] };
		});

		sessionsTotal = result.total;
		// an older proxy ignores the server filter; hold the rows to it again
		sessions = result.rows.filter((session) => session.server.toLowerCase() === instance.toLowerCase());
	}

	async function loadModeration(): Promise<void> {
		if (!data) {
			return;
		}

		const uuid = data.uuid;
		const result = await loadWholeLog<ModEntry>(async (offset) => {
			const more = await api(`/players/${uuid}/moderation?limit=${LOG_PAGE}&offset=${offset}`);

			return more.available === false ? { total: 0, rows: [] } : { total: more.total ?? 0, rows: more.entries ?? [] };
		});

		// an entry's server is the list of backends the action landed on
		moderation = result.rows.filter((entry) =>
			entry.server
				.split(',')
				.map((name) => name.trim().toLowerCase())
				.includes(instance.toLowerCase())
		);
	}

	function loadTab(id: string): void {
		if (id === 'sessions') {
			void loadSessions();
		} else if (id === 'moderation') {
			void loadModeration();
		}
	}

	$effect(() => {
		loadTab(tab);
	});

	onMount(() => {
		void refresh();

		void api('/instances').then((list) => {
			servers = [
				...list.instances
					.filter((inst: any) => inst.name !== 'proxy' && inst.name !== instance)
					.map((inst: any) => inst.name),
				...list.externals.map((inst: any) => inst.name)
			].sort();

			transferTo = servers[0] ?? '';
		});
	});

	// -- overview -----------------------------------------------------------------

	function place(position: PlayerPosition | undefined): string {
		if (!position) {
			return '–';
		}

		return `${dimensionLabel(position.dimension)} · ${Math.round(position.x)}, ${Math.round(position.y)}, ${Math.round(position.z)}`;
	}

	const playtimeHere = $derived(
		data?.profile?.playtimeByServer.find((entry) => entry.server.toLowerCase() === instance.toLowerCase())
	);

	const identityCells: InfoCell[] = $derived.by(() => {
		if (!data) {
			return [];
		}

		const live = data.live;
		const saved = snapshot;

		return [
			{ label: 'UUID', value: data.uuid, style: 'mono', copyable: true, colSpan: 2 },
			{ label: t('web.instancePlayer.username'), value: data.username, copyable: true },
			{
				label: t('web.instancePlayer.accountType'),
				value: live
					? live.onlineMode
						? t('web.instancePlayer.premium')
						: t('web.instancePlayer.offlineAccount')
					: data.profile
						? data.profile.onlineMode
							? t('web.instancePlayer.premium')
							: t('web.instancePlayer.offlineAccount')
						: null
			},
			{ label: t('web.instancePlayer.client'), value: live?.clientVersion ?? data.profile?.lastClientVersion ?? null },
			{ label: t('web.instancePlayer.address'), value: live?.remoteAddress ?? null, style: 'mono' },
			{ label: t('web.instancePlayer.savedAt'), value: saved ? fmtDateTime(saved.savedAt) : null },
			{ label: t('web.instancePlayer.firstPlayedHere'), value: saved?.firstPlayed ? fmtDateTime(saved.firstPlayed) : null },
			{ label: t('web.instancePlayer.lastPlayedHere'), value: saved?.lastPlayed ? fmtDateTime(saved.lastPlayed) : null },
			{ label: t('web.instancePlayer.lastLoginHere'), value: saved?.lastLogin ? fmtDateTime(saved.lastLogin) : null },
			{
				label: t('web.instancePlayer.playtimeHere'),
				value: playtimeHere ? fmtDuration(playtimeHere.playMillis) : null,
				help: t('web.instancePlayer.playtimeHereHint')
			},
			{ label: t('web.instancePlayer.stints'), value: playtimeHere?.stints ?? null },
			{ label: t('web.instancePlayer.dataVersion'), value: saved?.dataVersion ?? null, style: 'mono' }
		];
	});

	const stateCells: InfoCell[] = $derived.by(() => {
		if (!snapshot) {
			return [];
		}

		return [
			{ label: t('web.instancePlayer.position'), value: place(snapshot.position), style: 'mono', colSpan: 2 },
			{ label: t('web.instancePlayer.respawnPoint'), value: place(snapshot.respawn), style: 'mono', colSpan: 2 },
			{ label: t('web.instancePlayer.lastDeath'), value: place(snapshot.lastDeath), style: 'mono', colSpan: 2 },
			{ label: t('web.instancePlayer.facing'), value: snapshot.position.yaw !== undefined ? `${Math.round(snapshot.position.yaw)}° / ${Math.round(snapshot.position.pitch ?? 0)}°` : null, style: 'mono' },
			{ label: t('web.instancePlayer.score'), value: snapshot.score.toLocaleString() },
			{ label: t('web.instancePlayer.totalXp'), value: snapshot.xpTotal.toLocaleString() },
			{ label: t('web.instancePlayer.saturation'), value: Math.round(snapshot.saturation * 10) / 10 },
			{ label: t('web.instancePlayer.air'), value: `${snapshot.air} / 300` },
			{ label: t('web.instancePlayer.onFire'), value: snapshot.fire > 0 ? t('web.common.yes') : t('web.common.no') },
			{ label: t('web.instancePlayer.flying'), value: snapshot.flying ? t('web.common.yes') : snapshot.mayFly ? t('web.instancePlayer.allowed') : t('web.common.no') },
			{ label: t('web.instancePlayer.invulnerable'), value: snapshot.invulnerable ? t('web.common.yes') : t('web.common.no') },
			{ label: t('web.instancePlayer.walkSpeed'), value: Math.round(snapshot.walkSpeed * 1000) / 1000, style: 'mono' },
			{ label: t('web.instancePlayer.flySpeed'), value: Math.round(snapshot.flySpeed * 1000) / 1000, style: 'mono' },
			{ label: t('web.instancePlayer.selectedSlot'), value: snapshot.selectedSlot + 1 },
			{ label: t('web.instancePlayer.seenCredits'), value: snapshot.seenCredits ? t('web.common.yes') : t('web.common.no') },
			{ label: t('web.instancePlayer.portalCooldown'), value: snapshot.portalCooldown },
			{ label: t('web.instancePlayer.ticksLived'), value: snapshot.ticksLived !== undefined ? fmtDuration(ticksToMillis(snapshot.ticksLived)) : null }
		];
	});

	const effectCols: Column[] = $derived([
		{ id: 'effect', label: t('web.instancePlayer.colEffect'), sortable: true },
		{ id: 'amplifier', label: t('web.instancePlayer.colAmplifier'), width: 110, align: 'right' },
		{ id: 'duration', label: t('web.instancePlayer.colDuration'), width: 140 },
		{ id: 'ambient', label: t('web.instancePlayer.colAmbient'), width: 100 }
	]);

	const attributeRows = $derived(
		Object.entries(snapshot?.attributes ?? {})
			.map(([id, base]) => ({ id, base: Number(base) }))
			.sort((left, right) => left.id.localeCompare(right.id))
	);

	const attributeCols: Column[] = $derived([
		{ id: 'attribute', label: t('web.instancePlayer.colAttribute'), sortable: true },
		{ id: 'base', label: t('web.instancePlayer.colBase'), width: 140, align: 'right' }
	]);

	// -- advancements -------------------------------------------------------------

	const advancementCols: Column[] = $derived([
		{ id: 'id', label: t('web.instancePlayer.colAdvancement'), sortable: true, minWidth: 280 },
		{ id: 'group', label: t('web.instancePlayer.colGroup'), sortable: true, width: 130 },
		{ id: 'state', label: t('web.instancePlayer.colState'), sortable: true, width: 140 },
		{ id: 'criteria', label: t('web.instancePlayer.colCriteria'), width: 120, align: 'right' },
		{ id: 'at', label: t('web.instancePlayer.colCompleted'), sortable: true, width: 170 }
	]);

	const advancementFilters: TableFilterGroup<PlayerAdvancement>[] = $derived([
		{
			id: 'kind',
			label: t('web.instancePlayer.filterKind'),
			options: [
				{ value: 'real', label: t('web.instancePlayer.advancementsOnly'), match: (entry) => !entry.recipe },
				{ value: 'recipes', label: t('web.instancePlayer.recipesOnly'), match: (entry) => entry.recipe },
				{ value: 'any', label: t('web.instancePlayer.everything') }
			]
		},
		{
			id: 'state',
			label: t('web.instancePlayer.filterState'),
			options: [
				{ value: 'any', label: t('web.instancePlayer.anyState') },
				{ value: 'done', label: t('web.instancePlayer.completed'), match: (entry) => entry.done },
				{ value: 'progress', label: t('web.instancePlayer.inProgress'), match: (entry) => !entry.done }
			]
		}
	]);

	// -- stats --------------------------------------------------------------------

	/** The `minecraft:custom` counters worth a cell of their own, in ticks or cm as the game keeps them. */
	const custom = $derived(data?.detail.stats?.sections['minecraft:custom'] ?? {});

	function statValue(key: string): number | undefined {
		return custom[`minecraft:${key}`];
	}

	function distance(key: string): string | null {
		const cm = statValue(key);

		if (cm === undefined) {
			return null;
		}

		return cm >= 100_000 ? `${(cm / 100_000).toFixed(1)} km` : `${Math.round(cm / 100)} m`;
	}

	function ticks(key: string): string | null {
		const value = statValue(key);

		return value === undefined ? null : fmtDuration(ticksToMillis(value));
	}

	function count(key: string): number | null {
		return statValue(key) ?? null;
	}

	const statCells: InfoCell[] = $derived.by(() => {
		if (!data?.detail.stats) {
			return [];
		}

		return [
			{ label: t('web.instancePlayer.statPlayTime'), value: ticks('play_time') ?? ticks('play_one_minute') },
			{ label: t('web.instancePlayer.statDeaths'), value: count('deaths') },
			{ label: t('web.instancePlayer.statTimeSinceDeath'), value: ticks('time_since_death') },
			{ label: t('web.instancePlayer.statTimeSinceRest'), value: ticks('time_since_rest') },
			{ label: t('web.instancePlayer.statMobKills'), value: count('mob_kills') },
			{ label: t('web.instancePlayer.statPlayerKills'), value: count('player_kills') },
			{ label: t('web.instancePlayer.statDamageDealt'), value: count('damage_dealt') },
			{ label: t('web.instancePlayer.statDamageTaken'), value: count('damage_taken') },
			{ label: t('web.instancePlayer.statWalked'), value: distance('walk_one_cm') },
			{ label: t('web.instancePlayer.statSprinted'), value: distance('sprint_one_cm') },
			{ label: t('web.instancePlayer.statFlown'), value: distance('fly_one_cm') },
			{ label: t('web.instancePlayer.statSwum'), value: distance('swim_one_cm') },
			{ label: t('web.instancePlayer.statJumps'), value: count('jump') },
			{ label: t('web.instancePlayer.statSleeps'), value: count('sleep_in_bed') },
			{ label: t('web.instancePlayer.statLeaves'), value: count('leave_game') },
			{ label: t('web.instancePlayer.statDropped'), value: count('drop') }
		];
	});

	const statRows: StatRow[] = $derived.by(() => {
		const out: StatRow[] = [];

		for (const [section, values] of Object.entries(data?.detail.stats?.sections ?? {})) {
			for (const [key, value] of Object.entries(values)) {
				out.push({ section, key, value });
			}
		}

		return out;
	});

	const statCols: Column[] = $derived([
		{ id: 'section', label: t('web.instancePlayer.colSection'), sortable: true, width: 160 },
		{ id: 'key', label: t('web.instancePlayer.colStat'), sortable: true, minWidth: 260 },
		{ id: 'value', label: t('web.instancePlayer.colValue'), sortable: true, width: 140, align: 'right' }
	]);

	const statFilters: TableFilterGroup<StatRow>[] = $derived([
		{
			id: 'section',
			label: t('web.instancePlayer.filterSection'),
			options: [
				{ value: 'any', label: t('web.instancePlayer.anySection') },
				...Object.keys(data?.detail.stats?.sections ?? {})
					.sort()
					.map((section) => ({
						value: section,
						label: idLabel(section),
						match: (row: StatRow) => row.section === section
					}))
			]
		}
	]);

	// -- sessions, moderation -----------------------------------------------------

	const sessionCols: Column[] = $derived([
		{ id: 'connected', label: t('web.instancePlayer.colConnected'), sortable: true, width: 180 },
		{ id: 'duration', label: t('web.instancePlayer.colDuration'), sortable: true, width: 140 },
		{ id: 'ended', label: t('web.instancePlayer.colDisconnected'), width: 180 }
	]);

	const modCols: Column[] = $derived([
		{ id: 'time', label: t('web.instancePlayer.colTime'), width: 170, sortable: true },
		{ id: 'action', label: t('web.instancePlayer.colAction'), width: 160 },
		{ id: 'actor', label: t('web.instancePlayer.colBy'), width: 140 },
		{ id: 'reason', label: t('web.instancePlayer.colReason') }
	]);

	// -- verbs --------------------------------------------------------------------

	let messageOpen = $state(false);
	let messageText = $state('');
	let transferOpen = $state(false);
	let transferTo = $state('');
	let kickOpen = $state(false);
	let kickReason = $state('');
	let banOpen = $state(false);
	let banReason = $state('');

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

	async function moderate(action: ModerationAction, reason = ''): Promise<void> {
		if (!target) {
			return;
		}

		const who = target;

		await act(async () => {
			const summary = await moderatePlayers(action, [who], [instance], reason);

			if (summary.unconfirmed.length > 0) {
				Notify.warning(t('web.instancePlayers.unconfirmed', { targets: summary.unconfirmed.join(', ') }));
			}

			return t('web.instancePlayers.applied', { action: t(`web.instancePlayers.verb.${action}`), targets: who.username });
		}, t('web.instancePlayers.updatingLists'));
	}

	async function doMessage(): Promise<void> {
		const text = messageText.trim();

		messageOpen = false;

		if (!target || !text) {
			return;
		}

		const who = target;

		await act(async () => {
			await messagePlayers([who], text);

			return t('web.instancePlayers.messageDelivered', { targets: who.username });
		}, t('web.instancePlayers.sendingMessage', { targets: who.username }));

		messageText = '';
	}

	async function doTransfer(): Promise<void> {
		const to = transferTo;

		transferOpen = false;

		if (!target || !to) {
			return;
		}

		const who = target;

		await act(async () => {
			await transferPlayers([who], to);

			return t('web.instancePlayers.moved', { targets: who.username, server: to });
		}, t('web.instancePlayers.moving', { targets: who.username, server: to }));
	}

	async function doKick(): Promise<void> {
		const reason = kickReason.trim();

		kickOpen = false;

		if (!target) {
			return;
		}

		const who = target;

		await act(async () => {
			await kickPlayers([who], reason);

			return t('web.instancePlayers.disconnected', { targets: who.username });
		}, t('web.instancePlayers.disconnecting', { targets: who.username }));

		kickReason = '';
	}

	async function doBan(): Promise<void> {
		const reason = banReason.trim();

		banOpen = false;
		await moderate('ban', reason);
		banReason = '';
	}

	async function doGameMode(mode: GameMode): Promise<void> {
		if (!target) {
			return;
		}

		const who = target;

		await act(async () => {
			await setGameMode(instance, [who], mode);

			return t('web.instancePlayers.gameModeSet', { targets: who.username, mode: t(`web.instancePlayers.mode.${mode}`) });
		}, t('web.instancePlayers.settingGameMode', { targets: who.username }));
	}

	async function doResend(): Promise<void> {
		if (!target) {
			return;
		}

		const who = target;

		await act(async () => {
			await resendPacks([who]);

			return t('web.instancePlayers.resentPacks', { targets: who.username });
		}, t('web.instancePlayers.resendingPacks', { targets: who.username }));
	}

	function headerActions(): ContextMenuItem[] {
		if (!data) {
			return [];
		}

		const online = data.online;
		const offlineHint = online ? undefined : t('web.instancePlayer.notOnlineHere');

		return [
			{
				label: t('web.instancePlayers.viewNetworkProfile'),
				icon: 'user',
				action: () => goto(`/players/${data?.uuid}`)
			},
			{
				label: t('web.instancePlayers.copyUuid'),
				icon: 'copy',
				action: () => void copyText(data?.uuid ?? '')
			},
			{ separator: true },
			{
				label: t('web.instancePlayers.sendAMessage'),
				icon: 'paperPlane',
				disabled: !online,
				hint: offlineHint,
				action: () => {
					messageOpen = true;
				}
			},
			{
				label: t('web.instancePlayers.moveToAnotherBackend'),
				icon: 'rightLeft',
				disabled: !online || servers.length === 0,
				hint: offlineHint ?? (servers.length === 0 ? t('web.instancePlayers.noOtherBackend') : undefined),
				action: () => {
					transferOpen = true;
				}
			},
			{
				label: t('web.instancePlayers.resendPacks'),
				icon: 'image',
				disabled: !online,
				hint: offlineHint,
				action: () => void doResend()
			},
			{
				label: t('web.instancePlayers.setGameMode'),
				icon: 'joystick',
				disabled: !online,
				hint: offlineHint,
				submenu: GAME_MODES.map((mode) => ({
					label: t(`web.instancePlayers.mode.${mode}`),
					action: () => void doGameMode(mode)
				}))
			},
			{ separator: true },
			{ label: t('web.instancePlayers.addToWhitelist'), icon: 'userTick', action: () => void moderate('whitelist-add') },
			{ label: t('web.instancePlayers.removeFromWhitelist'), icon: 'userMinus', action: () => void moderate('whitelist-remove') },
			{ label: t('web.instancePlayers.grantOperator'), icon: 'userCog', action: () => void moderate('op') },
			{ label: t('web.instancePlayers.revokeOperator'), icon: 'userLock', action: () => void moderate('deop') },
			{ separator: true },
			{
				label: t('web.instancePlayers.disconnect'),
				icon: 'userSlash',
				color: 'danger',
				disabled: !online,
				hint: offlineHint,
				action: () => {
					kickOpen = true;
				}
			},
			{
				label: t('web.instancePlayers.banHere'),
				icon: 'gavel',
				color: 'danger',
				action: () => {
					banOpen = true;
				}
			},
			{ label: t('web.instancePlayer.pardonHere'), icon: 'handshake', action: () => void moderate('pardon') }
		];
	}

	const gameModeState = $derived(
		snapshot?.gameMode === 'survival'
			? 'ok'
			: snapshot?.gameMode === 'creative'
				? 'warning'
				: snapshot?.gameMode === 'spectator'
					? 'stopped'
					: 'info'
	);
</script>

<svelte:head><title>{data?.username ?? ref} · {instance} | Luna Console</title></svelte:head>

<PageHeader title={data?.username ?? ref} info description={data ? `${data.uuid} · ${instance}` : instance}>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="instance-player" />
		<Dropdown label={t('web.common.actions')} disabled={!data} menu={headerActions()} />
	{/snippet}
</PageHeader>

{#if notFound}
	<Flash kind="error">
		<b>{t('web.instancePlayer.unknownPlayer')}</b> {problem}
	</Flash>
{:else if data}
	{#if !data.lunaAvailable}
		<Flash kind="warning">
			<b>{t('web.instancePlayer.lunacoreIsNotAnswering')}</b> {data.lunaError ?? ''} {t('web.instancePlayer.savedOnlyHint')}
		</Flash>
	{/if}

	{#each data.detail.problems as line}
		<Flash kind="warning">{line}</Flash>
	{/each}

	<OverviewBar title={t('web.instancePlayer.overviewTitle', { instance })}>
		<OverviewCell label={t('web.instancePlayer.status')}>
			{#if data.online}
				<StatusBadge state="ok" label={t('web.instancePlayer.onlineHere')} />
			{:else if data.live}
				<StatusBadge state="warning" label={t('web.instancePlayer.onlineElsewhere', { server: data.live.server })} />
			{:else}
				<StatusBadge state="stopped" label={t('web.instancePlayer.offline')} />
			{/if}
		</OverviewCell>
		<OverviewCell label={t('web.instancePlayer.gameMode')}>
			{#if snapshot}
				<StatusBadge state={gameModeState} label={t(`web.instancePlayers.mode.${snapshot.gameMode}`)} />
			{:else}
				<span class="dim">–</span>
			{/if}
		</OverviewCell>
		<OverviewCell label={t('web.vitals.health')}>
			{#if snapshot}
				{Math.round(snapshot.health * 10) / 10} / {snapshot.maxHealth}
			{:else}
				<span class="dim">–</span>
			{/if}
		</OverviewCell>
		<OverviewCell label={t('web.vitals.food')}>
			{#if snapshot}
				{snapshot.food} / 20
			{:else}
				<span class="dim">–</span>
			{/if}
		</OverviewCell>
		<OverviewCell label={t('web.instancePlayer.level')}>
			{#if snapshot}
				{snapshot.xpLevel}
			{:else}
				<span class="dim">–</span>
			{/if}
		</OverviewCell>
		<OverviewCell label={t('web.instancePlayer.balance')}>
			{#if data.vault}
				<span class="balance">{data.vault.balanceFormatted}</span>
			{:else}
				<span class="dim">–</span>
			{/if}
		</OverviewCell>
		<OverviewCell label={t('web.instancePlayer.advancements')}>
			{#if data.detail.advancements}
				{data.detail.advancements.done} / {data.detail.advancements.total}
			{:else}
				<span class="dim">–</span>
			{/if}
		</OverviewCell>
		<OverviewCell label={t('web.instancePlayer.ping')}>
			{#if data.online && data.live}
				<span class="ping {pingClass(data.live.pingMillis)}">{data.live.pingMillis} ms</span>
			{:else}
				<span class="dim">–</span>
			{/if}
		</OverviewCell>
	</OverviewBar>

	<div class="columns">
		<Panel title={t('web.instancePlayer.skin')} description={t('web.instancePlayer.skinHint')}>
			<div class="skin">
				<PlayerSkin3D player={data.uuid} />
			</div>
		</Panel>

		<Panel title={t('web.instancePlayer.identity')}>
			<InfoGrid cells={identityCells} columns={[2, 2, 1]} />
		</Panel>
	</div>

	<Tabs
		tabs={[
			{ id: 'overview', label: t('web.instancePlayer.tabOverview') },
			{ id: 'inventory', label: t('web.instancePlayer.tabInventory') },
			{ id: 'advancements', label: t('web.instancePlayer.tabAdvancements') },
			{ id: 'stats', label: t('web.instancePlayer.tabStats') },
			{ id: 'sessions', label: t('web.instancePlayer.tabSessions') },
			{ id: 'chat', label: t('web.instancePlayer.tabChat') },
			{ id: 'moderation', label: t('web.instancePlayer.tabModeration') }
		]}
		bind:active={tab}
	/>

	<div class="tabbody">
		{#if tab === 'overview'}
			{#if snapshot}
				<Panel title={t('web.instancePlayer.vitals')} description={t('web.instancePlayer.savedNote', { when: fmtDateTime(snapshot.savedAt) })}>
					<div class="vitals">
						<PlayerVitals kind="health" value={snapshot.health} max={snapshot.maxHealth} extra={snapshot.absorption} />
						<PlayerVitals kind="food" value={snapshot.food} />
						<PlayerVitals kind="xp" value={snapshot.xpProgress} level={snapshot.xpLevel} />
					</div>
				</Panel>
				<div class="gap"></div>
				<Panel title={t('web.instancePlayer.state')}>
					<InfoGrid cells={stateCells} columns={[4, 2, 1]} />
				</Panel>
				<div class="gap"></div>
				<Panel title={t('web.instancePlayer.effects')} count={snapshot.effects.length} flush>
					<ResourceTable
						tableId="instance-player-effects"
						columns={effectCols}
						rows={snapshot.effects}
						getId={(effect) => effect.id}
						searchValue={(effect) => effect.id}
						searchPlaceholder={t('web.instancePlayer.findEffect')}
						searchWidth="18rem"
						noun={t('web.instancePlayer.nounEffect')}
						paging={false}
						emptyTitle={t('web.instancePlayer.noEffects')}
						emptyText={t('web.instancePlayer.noEffectsHint')}
					>
						{#snippet cell(effect, col)}
							{#if col === 'effect'}
								{idLabel(effect.id)}
							{:else if col === 'amplifier'}
								{effect.amplifier + 1}
							{:else if col === 'duration'}
								{effect.duration < 0 ? t('web.instancePlayer.infinite') : fmtDuration(ticksToMillis(effect.duration))}
							{:else if col === 'ambient'}
								{effect.ambient ? t('web.common.yes') : t('web.common.no')}
							{/if}
						{/snippet}
					</ResourceTable>
				</Panel>
				<div class="gap"></div>
				<Panel title={t('web.instancePlayer.attributes')} count={attributeRows.length} flush>
					<ResourceTable
						tableId="instance-player-attributes"
						columns={attributeCols}
						rows={attributeRows}
						getId={(row) => row.id}
						searchValue={(row) => row.id}
						searchPlaceholder={t('web.instancePlayer.findAttribute')}
						searchWidth="18rem"
						noun={t('web.instancePlayer.nounAttribute')}
						pageSize={15}
						sortValue={(row, col) => (col === 'attribute' ? row.id : row.base)}
						emptyTitle={t('web.instancePlayer.noAttributes')}
					>
						{#snippet cell(row, col)}
							{#if col === 'attribute'}
								<span class="mono">{row.id}</span>
							{:else if col === 'base'}
								<span class="mono">{Math.round(row.base * 1000) / 1000}</span>
							{/if}
						{/snippet}
					</ResourceTable>
				</Panel>
			{:else}
				<Flash kind="info">
					<b>{t('web.instancePlayer.noSave')}</b> {t('web.instancePlayer.noSaveHint', { instance })}
				</Flash>
			{/if}
		{:else if tab === 'inventory'}
			{#if snapshot}
				<Panel title={t('web.instancePlayer.inventory')} description={t('web.instancePlayer.inventoryHint', { when: fmtDateTime(snapshot.savedAt) })}>
					<PlayerInventory
						inventory={snapshot.inventory}
						equipment={snapshot.equipment}
						enderChest={snapshot.enderChest}
						selectedSlot={snapshot.selectedSlot}
					/>
				</Panel>
			{:else}
				<Flash kind="info">
					<b>{t('web.instancePlayer.noSave')}</b> {t('web.instancePlayer.noSaveHint', { instance })}
				</Flash>
			{/if}
		{:else if tab === 'advancements'}
			{#if data.detail.advancements}
				<Panel
					flush
					title={t('web.instancePlayer.advancements')}
					count="{data.detail.advancements.done} / {data.detail.advancements.total}"
					description={t('web.instancePlayer.advancementsHint', { recipes: data.detail.advancements.recipes })}
				>
					<ResourceTable
						tableId="instance-player-advancements"
						columns={advancementCols}
						rows={data.detail.advancements.entries}
						getId={(entry) => entry.id}
						searchValue={(entry) => `${entry.id} ${advancementGroup(entry.id)}`}
						searchPlaceholder={t('web.instancePlayer.findAdvancement')}
						noun={t('web.instancePlayer.nounAdvancement')}
						filters={advancementFilters}
						pageSize={25}
						sortValue={(entry, col) =>
							col === 'id'
								? entry.id
								: col === 'group'
									? advancementGroup(entry.id)
									: col === 'state'
										? (entry.done ? 1 : 0)
										: col === 'at'
											? entry.at
											: null}
						defaultSort={{ col: 'at', dir: 'desc' }}
						emptyTitle={t('web.instancePlayer.noAdvancements')}
					>
						{#snippet cell(entry, col)}
							{#if col === 'id'}
								<span class="adv">
									<b>{idLabel(entry.id.slice(entry.id.lastIndexOf('/') + 1))}</b>
									<span class="mono dim">{entry.id}</span>
								</span>
							{:else if col === 'group'}
								{advancementGroup(entry.id)}
							{:else if col === 'state'}
								<StatusBadge
									state={entry.done ? 'passed' : 'pending'}
									label={entry.done ? t('web.instancePlayer.completed') : t('web.instancePlayer.inProgress')}
									detail={entry.criteria.map((criterion) => `${criterion.name}: ${criterion.at ? fmtDateTime(criterion.at) : '–'}`)}
								/>
							{:else if col === 'criteria'}
								{entry.criteria.length}
							{:else if col === 'at'}
								<span class="dim">{entry.at ? fmtDateTime(entry.at) : '–'}</span>
							{/if}
						{/snippet}
					</ResourceTable>
				</Panel>
			{:else}
				<Flash kind="info">
					<b>{t('web.instancePlayer.noAdvancementsFile')}</b> {t('web.instancePlayer.noSaveHint', { instance })}
				</Flash>
			{/if}
		{:else if tab === 'stats'}
			{#if data.detail.stats}
				<Panel title={t('web.instancePlayer.statsOverview')}>
					<InfoGrid cells={statCells} columns={[4, 2, 1]} />
				</Panel>
				<div class="gap"></div>
				<Panel flush title={t('web.instancePlayer.allStats')} count={statRows.length}>
					<ResourceTable
						tableId="instance-player-stats"
						columns={statCols}
						rows={statRows}
						getId={(row) => `${row.section}/${row.key}`}
						searchValue={(row) => `${row.section} ${row.key}`}
						searchPlaceholder={t('web.instancePlayer.findStat')}
						noun={t('web.instancePlayer.nounStat')}
						filters={statFilters}
						pageSize={25}
						sortValue={(row, col) => (col === 'section' ? row.section : col === 'key' ? row.key : row.value)}
						defaultSort={{ col: 'value', dir: 'desc' }}
						emptyTitle={t('web.instancePlayer.noStats')}
					>
						{#snippet cell(row, col)}
							{#if col === 'section'}
								{idLabel(row.section)}
							{:else if col === 'key'}
								<span class="adv">
									<b>{idLabel(row.key)}</b>
									<span class="mono dim">{row.key}</span>
								</span>
							{:else if col === 'value'}
								<span class="mono">{row.value.toLocaleString()}</span>
							{/if}
						{/snippet}
					</ResourceTable>
				</Panel>
			{:else}
				<Flash kind="info">
					<b>{t('web.instancePlayer.noStatsFile')}</b> {t('web.instancePlayer.noSaveHint', { instance })}
				</Flash>
			{/if}
		{:else if tab === 'sessions'}
			<Panel flush title={t('web.instancePlayer.sessionsHere')} count={sessions.length}>
				<ResourceTable
					tableId="instance-player-sessions"
					columns={sessionCols}
					rows={sessions}
					getId={(session) => String(session.id)}
					noun={t('web.instancePlayer.nounSession')}
					pageSize={25}
					sortValue={(session, col) =>
						col === 'connected' ? session.connectedAtEpochMillis : col === 'duration' ? session.durationMillis : null}
					defaultSort={{ col: 'connected', dir: 'desc' }}
					emptyTitle={t('web.instancePlayer.noSessions')}
					emptyText={t('web.instancePlayer.noSessionsHint')}
				>
					{#snippet cell(session, col)}
						{#if col === 'connected'}
							{fmtDateTime(session.connectedAtEpochMillis)}
						{:else if col === 'duration'}
							{#if session.open}
								<StatusBadge state="ok" label={t('web.instancePlayer.ongoing')} />
							{:else}
								{fmtDuration(session.durationMillis)}
							{/if}
						{:else if col === 'ended'}
							{session.open ? '–' : fmtDateTime(session.disconnectedAtEpochMillis)}
						{/if}
					{/snippet}
				</ResourceTable>
				{#if sessions.length < sessionsTotal}
					<p class="capped dim">{t('web.instancePlayer.newestShown', { shown: sessions.length, total: sessionsTotal })}</p>
				{/if}
			</Panel>
		{:else if tab === 'chat'}
			<Panel flush title={t('web.instancePlayer.chatHere')} description={t('web.instancePlayer.chatHereHint')}>
				{#key data.uuid}
					<InstanceChatLog {instance} player={data.uuid} compact />
				{/key}
			</Panel>
		{:else if tab === 'moderation'}
			<Panel flush title={t('web.instancePlayer.moderationHere')} count={moderation.length}>
				<ResourceTable
					tableId="instance-player-moderation"
					columns={modCols}
					rows={moderation}
					getId={(entry) => String(entry.id)}
					searchValue={(entry) => `${entry.action} ${entry.actor} ${entry.reason}`}
					searchPlaceholder={t('web.instancePlayer.findEntry')}
					noun={t('web.instancePlayer.nounEntry')}
					pageSize={25}
					sortValue={(entry, col) => (col === 'time' ? entry.atEpochMillis : null)}
					defaultSort={{ col: 'time', dir: 'desc' }}
					emptyTitle={t('web.instancePlayer.cleanRecord')}
					emptyText={t('web.instancePlayer.cleanRecordHint')}
				>
					{#snippet cell(entry, col)}
						{#if col === 'time'}
							<span class="mono dim">{fmtDateTime(entry.atEpochMillis)}</span>
						{:else if col === 'action'}
							<StatusBadge
								state={/ban|kick/.test(entry.action) ? 'failed' : /pardon|remove|deop/.test(entry.action) ? 'warning' : 'info'}
								label={entry.action}
							/>
						{:else if col === 'actor'}
							{entry.actor || '–'}
						{:else if col === 'reason'}
							{entry.reason || entry.details || '–'}
						{/if}
					{/snippet}
				</ResourceTable>
			</Panel>
		{/if}
	</div>
{/if}

<Modal title={t('web.instancePlayers.messageTitle', { targets: data?.username ?? '' })} bind:open={messageOpen}>
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

<Modal title={t('web.instancePlayers.moveTitle', { targets: data?.username ?? '' })} bind:open={transferOpen}>
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

<Modal title={t('web.instancePlayers.disconnectTitle', { targets: data?.username ?? '' })} bind:open={kickOpen}>
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
	title={t('web.instancePlayers.banTitle', { targets: data?.username ?? '' })}
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
	.columns {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 1rem;
		margin: 1rem 0;
		align-items: stretch;

		@include below($bp-medium) {
			grid-template-columns: 1fr;
		}
	}

	.skin {
		display: flex;
		justify-content: center;
		padding: 0.5rem 1.5rem;
	}

	.tabbody {
		margin-top: 1rem;
	}

	.gap {
		height: 1rem;
	}

	.vitals {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		max-width: 40rem;
	}

	.balance {
		font-weight: 700;
		color: var(--text-heading);
	}

	// latency bands, the same scale as the players pages
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

	.adv {
		display: inline-flex;
		flex-direction: column;
		line-height: 1.25;

		.mono {
			font-size: 0.75rem;
		}
	}

	// the cap is a fact about the table above it, not an invitation to click
	.capped {
		margin: 0;
		padding: 0.75rem 1.25rem;
		font-size: 0.8125rem;
		border-top: 0.1rem solid var(--border-divider);
	}

	.field {
		margin-top: 0.75rem;
	}
</style>
