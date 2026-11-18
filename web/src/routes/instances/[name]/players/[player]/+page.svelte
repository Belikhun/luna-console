<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount, untrack } from 'svelte';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import { copyText } from '$lib/clipboard';
	import { fmtDuration, fmtDateTime } from '$lib/format';
	import { LOG_PAGE, loadWholeLog } from '$lib/log';
	import {
		accessFlagsOf,
		accessIndexOf,
		blockCoords,
		gameModeState,
		pingClass,
		playPointsOf
	} from '$lib/players';
	import type { AccessIndex, PlaySessionRow } from '$lib/players';
	import { playerVerbGroups } from '$lib/playeractions';
	import type { PlayerActionTarget } from '$lib/playeractions';
	import {
		GAME_MODES,
		advancementGroup,
		dimensionLabel,
		idLabel,
		ticksToMillis
	} from '$core/playerdata';
	import type { PlayerAdvancement, PlayerDetail, PlayerPosition } from '$core/playerdata';
	import type { LunaPlayer, RegisteredPlayerDetail, VaultAccountInfo } from '$core/services/luna';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import CalendarGraph from '$lib/components/CalendarGraph.svelte';
	import type { CalendarDay } from '$lib/components/calendargraph';
	import type { OverviewDetail } from '$lib/components/nodeoverview';
	import PlayerAccessBadges from '$lib/components/PlayerAccessBadges.svelte';
	import PlayerActionDialogs from '$lib/components/PlayerActionDialogs.svelte';
	import DateTime from '$lib/components/DateTime.svelte';
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
	import { menuGroups, type ContextMenuItem } from '$lib/components/contextmenu';
	import PlayerSkin3D from '$lib/components/PlayerSkin3D.svelte';
	import PlayerInventory from '$lib/components/PlayerInventory.svelte';
	import InstanceChatLog from '$lib/components/InstanceChatLog.svelte';

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

	type Session = PlaySessionRow;

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

	// the tab lives in the address, so a reload, a shared link and the back button all land on it
	const tab = $derived.by((): Tab => {
		const wanted = page.url.searchParams.get('tab');

		return (TABS as readonly string[]).includes(wanted ?? '')
			? (wanted as Tab)
			: 'overview';
	});

	let sessions: Session[] = $state([]);
	let sessionsTotal = $state(0);
	let sessionsLoaded = $state(false);
	let moderation: ModEntry[] = $state([]);
	let moderationLoaded = $state(false);
	let servers: string[] = $state([]);

	const snapshot = $derived(data?.detail.snapshot ?? null);

	// the payload is a new object on every refresh; the skin viewer rebuilds
	// when its player changes, so it is handed the id alone, which does not
	const skinOf = $derived(data?.uuid ?? '');

	/** This server's access lists; where the player stands on them rides in the header */
	let access = $state<AccessIndex | null>(null);
	let dialogs: PlayerActionDialogs | undefined = $state();

	const flags = $derived(data ? accessFlagsOf(access, { uuid: data.uuid, name: data.username }) : null);

	function tabHref(id: Tab): string {
		const url = new URL(page.url);

		if (id === 'overview') {
			url.searchParams.delete('tab');
		} else {
			url.searchParams.set('tab', id);
		}

		return `${url.pathname}${url.search}`;
	}

	/** Bumped per refresh while the chat tab is open, which re-reads its log */
	let chatRefreshKey = $state(0);

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

		void loadAccess();

		if (data) {
			void loadTab(tab);

			// the chat tab reads its own log; a refresh only has to tell it to
			if (tab === 'chat') {
				chatRefreshKey++;
			}
		}
	}

	/** Best-effort: without the lists the header simply says nothing about them. */
	async function loadAccess(): Promise<void> {
		try {
			access = accessIndexOf(await api(`/instances/${encodeURIComponent(instance)}/access`));
		} catch {
			access = null;
		}
	}

	async function loadSessions(): Promise<void> {
		if (!data) {
			return;
		}

		const uuid = data.uuid;

		try {
			const result = await loadWholeLog<Session>(async (offset) => {
				const more = await api(
					`/players/${uuid}/sessions?server=${encodeURIComponent(instance)}&limit=${LOG_PAGE}&offset=${offset}`
				);

				return more.available === false ? { total: 0, rows: [] } : { total: more.total ?? 0, rows: more.sessions ?? [] };
			});

			sessionsTotal = result.total;
			// an older proxy ignores the server filter; hold the rows to it again
			sessions = result.rows.filter((session) => session.server.toLowerCase() === instance.toLowerCase());
		} finally {
			sessionsLoaded = true;
		}
	}

	async function loadModeration(): Promise<void> {
		if (!data) {
			return;
		}

		const uuid = data.uuid;

		try {
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
		} finally {
			moderationLoaded = true;
		}
	}

	function loadTab(id: string): void {
		if (id === 'sessions') {
			void loadSessions();
		} else if (id === 'moderation') {
			void loadModeration();
		}
	}

	// a tab's table is read when the tab opens; the refresh reads it again itself,
	// so the profile arriving must not count as a second reason to
	$effect(() => {
		const id = tab;

		untrack(() => loadTab(id));
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
		});
	});

	// -- overview -----------------------------------------------------------------

	function place(position: PlayerPosition | undefined): string {
		if (!position) {
			return '–';
		}

		return `${dimensionLabel(position.dimension)} · ${blockCoords(position)}`;
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
			{ label: t('web.instancePlayer.savedAt'), value: saved ? fmtDateTime(saved.savedAt) : null, time: saved?.savedAt || null },
			{ label: t('web.instancePlayer.firstPlayedHere'), value: saved?.firstPlayed ? fmtDateTime(saved.firstPlayed) : null, time: saved?.firstPlayed || null },
			{ label: t('web.instancePlayer.lastPlayedHere'), value: saved?.lastPlayed ? fmtDateTime(saved.lastPlayed) : null, time: saved?.lastPlayed || null },
			{ label: t('web.instancePlayer.lastLoginHere'), value: saved?.lastLogin ? fmtDateTime(saved.lastLogin) : null, time: saved?.lastLogin || null },
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

	const target = $derived.by((): PlayerActionTarget | null => {
		if (!data) {
			return null;
		}

		return {
			username: data.username,
			uuid: data.uuid,
			online: data.online,
			server: instance,
			...(data.live?.remoteAddress ? { address: data.live.remoteAddress } : {})
		};
	});

	function headerActions(): ContextMenuItem[] {
		if (!data || !target) {
			return [];
		}

		const groups = playerVerbGroups({
			targets: [target],
			instance,
			servers,
			gameModes: GAME_MODES,
			flags,
			open: (kind, targets) => dialogs?.open(kind, targets),
			setGameMode: (targets, mode) => dialogs?.setGameMode(targets, mode)
		});

		return menuGroups(
			groups.live,
			groups.access,
			[
				{
					id: 'copy-uuid',
					label: t('web.instancePlayers.copyUuid'),
					icon: 'copy',
					action: () => void copyText(data?.uuid ?? '')
				},
				{
					id: 'copy-name',
					label: t('web.instancePlayers.copyName'),
					icon: 'copy',
					action: () => void copyText(data?.username ?? '')
				}
			],
			groups.remove
		);
	}

	// GitHub-style ramp for the play calendar: an empty day has to read as empty
	const PLAY_RAMP = ['var(--bg-hover)', 'var(--success)'];

	const playPoints = $derived(playPointsOf(sessions));

	const playDayDetails = $derived((day: CalendarDay): OverviewDetail[] => [
		{ key: t('web.playerDetail.sessions'), value: String(day.count), mono: true }
	]);

</script>

<svelte:head><title>{data?.username ?? ref} · {instance} | Luna Console</title></svelte:head>

<PageHeader
	title={data?.username ?? ref}
	info={t('web.guide.instancePlayer')}
	description={data ? t('web.instancePlayer.subtitle', { instance, uuid: data.uuid }) : instance}
>
	{#snippet extra()}
		{#if data}
			{#if data.online}
				<StatusBadge state="ok" label={t('web.instancePlayer.onlineHere')} />
			{:else if data.live}
				<StatusBadge state="warning" label={t('web.instancePlayer.onlineElsewhere', { server: data.live.server })} />
			{:else}
				<StatusBadge state="stopped" label={t('web.instancePlayer.offline')} />
			{/if}
			<PlayerAccessBadges {flags} whitelistEnabled={access?.whitelistEnabled ?? false} />
		{/if}
	{/snippet}
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="instance-player" />
		<Dropdown label={t('web.common.actions')} disabled={!data} menu={headerActions()} />
		<Btn icon="user" href="/players/{data?.uuid ?? ref}">{t('web.instancePlayer.networkProfile')}</Btn>
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
		<OverviewCell label={t('web.instancePlayer.gameMode')}>
			{#if snapshot}
				<StatusBadge state={gameModeState(snapshot.gameMode)} label={t(`web.instancePlayers.mode.${snapshot.gameMode}`)} />
			{:else}
				<span class="dim">–</span>
			{/if}
		</OverviewCell>
		<OverviewCell
			label={t('web.vitals.health')}
			progress={snapshot ? Math.min(1, snapshot.health / (snapshot.maxHealth || 20)) : undefined}
			progressColor="var(--error)"
		>
			{#if snapshot}
				{#if snapshot.absorption > 0}
					{t('web.vitals.healthWithAbsorption', {
						base: `${Math.round(snapshot.health * 10) / 10} / ${snapshot.maxHealth}`,
						extra: Math.round(snapshot.absorption * 10) / 10
					})}
				{:else}
					{Math.round(snapshot.health * 10) / 10} / {snapshot.maxHealth}
				{/if}
			{:else}
				<span class="dim">–</span>
			{/if}
		</OverviewCell>
		<OverviewCell
			label={t('web.vitals.food')}
			progress={snapshot ? Math.min(1, snapshot.food / 20) : undefined}
			progressColor="var(--warning)"
		>
			{#if snapshot}
				{snapshot.food} / 20
			{:else}
				<span class="dim">–</span>
			{/if}
		</OverviewCell>
		<OverviewCell label={t('web.instancePlayer.level')} progress={snapshot ? snapshot.xpProgress : undefined}>
			{#if snapshot}
				{snapshot.xpLevel}
				<span class="dim">{snapshot.xpTotal.toLocaleString()} xp</span>
			{:else}
				<span class="dim">–</span>
			{/if}
		</OverviewCell>
		<OverviewCell label={t('web.instancePlayer.position')} wide>
			{#if snapshot}
				<span class="mono">{blockCoords(snapshot.position)}</span>
				<span class="dim">{dimensionLabel(snapshot.position.dimension)}</span>
			{:else}
				<span class="dim">–</span>
			{/if}
		</OverviewCell>
		<OverviewCell label={t('web.instancePlayer.playtimeHere')}>
			{#if playtimeHere}
				{fmtDuration(playtimeHere.playMillis)}
			{:else}
				<span class="dim">–</span>
			{/if}
		</OverviewCell>
		<OverviewCell
			label={t('web.instancePlayer.advancements')}
			progress={data.detail.advancements && data.detail.advancements.total > 0
				? data.detail.advancements.done / data.detail.advancements.total
				: undefined}
			progressColor="var(--link)"
		>
			{#if data.detail.advancements}
				{data.detail.advancements.done} / {data.detail.advancements.total}
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
		<OverviewCell label={t('web.instancePlayer.ping')}>
			{#if data.online && data.live}
				<span class="ping {pingClass(data.live.pingMillis)}">{data.live.pingMillis} ms</span>
			{:else}
				<span class="dim">–</span>
			{/if}
		</OverviewCell>
	</OverviewBar>

	<Tabs
		tabs={[
			{ id: 'overview', label: t('web.instancePlayer.tabOverview'), href: tabHref('overview') },
			{ id: 'inventory', label: t('web.instancePlayer.tabInventory'), href: tabHref('inventory') },
			{ id: 'advancements', label: t('web.instancePlayer.tabAdvancements'), href: tabHref('advancements') },
			{ id: 'stats', label: t('web.instancePlayer.tabStats'), href: tabHref('stats') },
			{ id: 'sessions', label: t('web.instancePlayer.tabSessions'), href: tabHref('sessions') },
			{ id: 'chat', label: t('web.instancePlayer.tabChat'), href: tabHref('chat') },
			{ id: 'moderation', label: t('web.instancePlayer.tabModeration'), href: tabHref('moderation') }
		]}
		active={tab}
	/>

	<div class="tabbody">
		{#if tab === 'overview'}
			<div class="top">
				<Panel title={t('web.instancePlayer.skin')} description={t('web.instancePlayer.skinHint')}>
					<div class="skin">
						<PlayerSkin3D player={skinOf} />
					</div>
				</Panel>

				<Panel
					title={t('web.instancePlayer.identity')}
					description={snapshot ? t('web.instancePlayer.savedNote', { when: fmtDateTime(snapshot.savedAt) }) : undefined}
				>
					<InfoGrid cells={identityCells} columns={[3, 2, 1]} />
				</Panel>
			</div>

			{#if !snapshot}
				<Flash kind="info">
					<b>{t('web.instancePlayer.noSave')}</b> {t('web.instancePlayer.noSaveHint', { instance })}
				</Flash>
			{/if}

			{#if snapshot}
				<Panel title={t('web.instancePlayer.state')}>
					<InfoGrid cells={stateCells} columns={[4, 2, 1]} />
				</Panel>

				<div class="pair">
					<Panel title={t('web.instancePlayer.effects')} count={snapshot.effects.length} flush>
						{#snippet actions()}
							<Btn
								icon="flaskVial"
								disabled={!data?.online || !target}
								title={data?.online ? undefined : t('web.playerActions.playerOffline')}
								onclick={() => target && dialogs?.open('effect', [target])}
							>
								{t('web.instancePlayers.giveEffect')}
							</Btn>
						{/snippet}

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
				</div>
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
								<span class="dim"><DateTime at={entry.at || null} text={entry.at ? fmtDateTime(entry.at) : undefined} /></span>
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
			<Panel
				title={t('web.playerDetail.playCalendar')}
				description={t('web.instancePlayer.playCalendarHint', { instance })}
			>
				<CalendarGraph
					points={playPoints}
					to={sessions.length > 0 ? Date.now() : null}
					ramp={PLAY_RAMP}
					valueFormat={(value) => (value > 0 ? fmtDuration(value) : '0s')}
					dayDetails={playDayDetails}
					empty={t('web.playerDetail.noPlayDays')}
				/>
			</Panel>
			<Panel flush title={t('web.instancePlayer.sessionsHere')} count={sessions.length}>
				<ResourceTable
					tableId="instance-player-sessions"
					columns={sessionCols}
					rows={sessions}
					loading={!sessionsLoaded}
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
							<DateTime at={session.connectedAtEpochMillis} text={fmtDateTime(session.connectedAtEpochMillis)} />
						{:else if col === 'duration'}
							{#if session.open}
								<StatusBadge state="ok" label={t('web.instancePlayer.ongoing')} />
							{:else}
								{fmtDuration(session.durationMillis)}
							{/if}
						{:else if col === 'ended'}
							{#if session.open}
								–
							{:else}
								<DateTime at={session.disconnectedAtEpochMillis} text={fmtDateTime(session.disconnectedAtEpochMillis)} />
							{/if}
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
					<InstanceChatLog {instance} player={data.uuid} compact refreshKey={chatRefreshKey} />
				{/key}
			</Panel>
		{:else if tab === 'moderation'}
			<Panel flush title={t('web.instancePlayer.moderationHere')} count={moderation.length}>
				<ResourceTable
					tableId="instance-player-moderation"
					columns={modCols}
					rows={moderation}
					loading={!moderationLoaded}
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
							<span class="mono dim"><DateTime at={entry.atEpochMillis} text={fmtDateTime(entry.atEpochMillis)} /></span>
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

<PlayerActionDialogs bind:this={dialogs} {instance} {servers} ondone={refresh} />

<style lang="scss">
	// one column of panels; the gap is the only spacing between them
	.tabbody {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		margin-top: 1rem;

		:global(.flash) {
			margin-bottom: 0;
		}
	}

	// the skin keeps its own width; what the server saved fills the rest
	.top {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 1rem;
		align-items: stretch;

		@include below($bp-medium) {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.pair {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem;
		align-items: start;

		@include below($bp-medium) {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.skin {
		display: flex;
		justify-content: center;
		padding: 0.5rem 1.5rem;
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

</style>
