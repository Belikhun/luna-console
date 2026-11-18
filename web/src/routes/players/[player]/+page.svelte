<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { t } from '$lib/i18n.svelte';
	import { Authz } from '$lib/authz.svelte';
	import { resourceId } from '$shared/iam/resources';
	import { traitsOf } from '$core/software';
	import { api } from '$lib/api';
	import { copyText } from '$lib/clipboard';
	import { fmtDuration, fmtDateTime } from '$lib/format';
	import { playerVerbGroups } from '$lib/playeractions';
	import type { PlayerActionTarget } from '$lib/playeractions';
	import ScreenLink from '$lib/components/ScreenLink.svelte';
	import DateTime from '$lib/components/DateTime.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import OverviewBar from '$lib/components/OverviewBar.svelte';
	import OverviewCell from '$lib/components/OverviewCell.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import PlayerActionDialogs from '$lib/components/PlayerActionDialogs.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import Tabs from '$lib/components/Tabs.svelte';
	import { menuGroups, type ContextMenuItem } from '$lib/components/contextmenu';
	import AccountSecurity from './AccountSecurity.svelte';
	import ChatTab from './ChatTab.svelte';
	import EconomyTab from './EconomyTab.svelte';
	import HistoryTab from './HistoryTab.svelte';
	import ModerationTab from './ModerationTab.svelte';
	import OverviewTab from './OverviewTab.svelte';
	import PermissionsTab from './PermissionsTab.svelte';
	import SkinDialog from './SkinDialog.svelte';
	import { PLAYER_TABS } from './player';
	import type {
		AccessStanding,
		AuthInfo,
		Detail,
		LiveOnInstance,
		ModEntry,
		PlayerTab,
		Session,
		VaultInfo
	} from './player';

	/**
	 * One player, in full: identity, skin, play history and statistics,
	 * permissions, chat/command log and moderation history; everything LunaCore
	 * has recorded about them, with the administration verbs in the header.
	 *
	 * The screen owns what its header and overview bar read (the profile, the
	 * account and the wallet). Each tab reads its own table, the first time it is
	 * opened and again on every refresh while it is the one on screen; a tab left
	 * behind keeps its rows, search and page, and catches up when it is reopened.
	 */

	/** How many of the newest sessions and moderation entries the overview shows. */
	const GLANCE_ROWS = 5;

	const ref = $derived(page.params.player ?? '');

	let detail: Detail | undefined = $state();
	let available = $state(true);
	let notFound = $state(false);
	let problem = $state('');
	let loading = $state(true);
	let lastUpdated: number | null = $state(null);

	/** Bumped on every refresh; the tabs reload on it */
	let refreshKey = $state(0);

	let auth: AuthInfo | undefined = $state();
	let authAvailable = $state(true);
	let authProblem = $state('');

	let vault: VaultInfo | undefined = $state();
	let vaultAvailable = $state(true);
	let vaultProblem = $state('');

	let recentSessions: Session[] = $state([]);
	let recentModeration: ModEntry[] = $state([]);
	let standing = $state<AccessStanding | null>(null);

	/** The player on the backend they are connected to; null while offline, or when that backend is not the account's to see */
	let here = $state<LiveOnInstance | null>(null);

	let instances: string[] = $state([]);
	let servers: string[] = $state([]);

	/** Bumped after a skin change so the viewer fetches the new one. */
	let skinEpoch = $state(0);

	let dialogs: PlayerActionDialogs | undefined = $state();
	let account: AccountSecurity | undefined = $state();
	let moderationTab: ModerationTab | undefined = $state();
	let skinDialog: SkinDialog | undefined = $state();

	// chat is the most private thing the profile holds: the tab exists only for
	// an account allowed to read this player's, and the route checks it again
	const mayReadChat = $derived(Authz.can('chat:ReadPlayer', resourceId('player', ref)));

	// the tab lives in the address, so a reload, a shared link and the back button all land on it
	const tab = $derived.by((): PlayerTab => {
		const wanted = page.url.searchParams.get('tab') ?? '';

		if (!(PLAYER_TABS as readonly string[]).includes(wanted)) {
			return 'overview';
		}

		return wanted === 'chat' && !mayReadChat
			? 'overview'
			: (wanted as PlayerTab);
	});

	/** Tabs opened so far; each stays mounted so it keeps its rows, search and page. */
	let visited: Set<PlayerTab> = $state(new Set());

	$effect(() => {
		if (!visited.has(tab)) {
			visited = new Set([...visited, tab]);
		}
	});

	function tabHref(id: PlayerTab): string {
		const url = new URL(page.url);

		if (id === 'overview') {
			url.searchParams.delete('tab');
		} else {
			url.searchParams.set('tab', id);
		}

		return `${url.pathname}${url.search}`;
	}

	const TAB_LABELS: Record<PlayerTab, string> = {
		overview: 'web.playerDetail.overview',
		account: 'web.playerDetail.account',
		economy: 'web.playerDetail.economy',
		sessions: 'web.playerDetail.playHistory',
		chat: 'web.playerDetail.chatCommands',
		permissions: 'web.playerDetail.permissions',
		moderation: 'web.playerDetail.moderation'
	};

	const tabs = $derived(
		PLAYER_TABS.filter((id) => id !== 'chat' || mayReadChat).map((id) => ({
			id,
			label: t(TAB_LABELS[id]),
			href: tabHref(id)
		}))
	);

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const data = await api(`/players/${encodeURIComponent(ref)}`);

			if (data.available === false) {
				available = false;
				notFound = false;
				problem = data.error ?? t('web.playerDetail.noAnswer');
			} else {
				available = true;
				notFound = false;
				detail = data as Detail;
				lastUpdated = Date.now();
			}
		} catch (err) {
			// the route answers 404 for a player the directory has never seen
			notFound = true;
			problem = (err as Error).message;
		}

		loading = false;

		// the tabs follow the same tick: the one on screen reloads now, the others when reopened
		refreshKey++;

		// the account and the balance are read with the profile rather than with
		// their tabs: the header and the overview bar show them on every tab
		await Promise.all([loadAuth(), loadVault(), loadGlance(), loadStanding(), loadHere()]);
	}

	async function loadAuth(): Promise<void> {
		try {
			const data = await api(`/players/${encodeURIComponent(ref)}/auth`);

			if (data.available === false) {
				authAvailable = false;
				authProblem = data.error ?? t('web.playerDetail.noAnswer');
				return;
			}

			authAvailable = true;
			auth = data as AuthInfo;
		} catch (err) {
			authAvailable = false;
			authProblem = (err as Error).message;
		}
	}

	async function loadVault(): Promise<void> {
		try {
			const data = await api(`/players/${encodeURIComponent(ref)}/vault`);

			if (data.available === false) {
				vaultAvailable = false;
				vaultProblem = data.error ?? t('web.playerDetail.noAnswer');
				return;
			}

			vaultAvailable = true;
			vault = data as VaultInfo;
		} catch (err) {
			vaultAvailable = false;
			vaultProblem = (err as Error).message;
		}
	}

	/**
	 * The connected player as their backend sees them, which is what that
	 * backend's own player screen reads. Only asked for a backend the account may
	 * describe; an external server, which luna holds no saves for, answers nothing.
	 */
	async function loadHere(): Promise<void> {
		const server = detail?.online
			? detail.server
			: '';

		if (!detail || !server || !Authz.can('instance:Describe', resourceId('instance', server))) {
			here = null;
			return;
		}

		try {
			const data: LiveOnInstance = await api(
				`/instances/${encodeURIComponent(server)}/players/${encodeURIComponent(detail.uuid)}`
			);

			here = data.online ? data : null;
		} catch {
			here = null;
		}
	}

	/** The newest few sessions and moderation entries, for the overview. */
	async function loadGlance(): Promise<void> {
		try {
			const [sessions, moderation] = await Promise.all([
				api(`/players/${encodeURIComponent(ref)}/sessions?limit=${GLANCE_ROWS}&offset=0`),
				api(`/players/${encodeURIComponent(ref)}/moderation?limit=${GLANCE_ROWS}&offset=0`)
			]);

			recentSessions = (sessions.sessions ?? []).slice(0, GLANCE_ROWS);
			recentModeration = (moderation.entries ?? []).slice(0, GLANCE_ROWS);
		} catch {
			// the overview keeps what it had; the tabs report their own trouble
		}
	}

	/**
	 * Where the player stands on the backends' access lists. Best-effort: an
	 * account that may not list them simply does not get the panel.
	 */
	async function loadStanding(): Promise<void> {
		if (!detail) {
			return;
		}

		const uuid = detail.uuid.toLowerCase();
		const name = detail.username.toLowerCase();

		const mine = (rows: Array<{ uuid?: string; name?: string; instances: string[] }> | undefined): string[] =>
			(rows ?? [])
				.filter((row) => (row.uuid ? row.uuid.toLowerCase() === uuid : (row.name ?? '').toLowerCase() === name))
				.flatMap((row) => row.instances)
				.sort();

		try {
			const lists = await api('/moderation');

			standing = {
				banned: mine(lists.bans),
				operator: mine(lists.ops),
				whitelisted: mine(lists.whitelist)
			};
		} catch {
			standing = null;
		}
	}

	onMount(() => {
		void refresh();

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

	const target = $derived.by((): PlayerActionTarget | null => {
		if (!detail) {
			return null;
		}

		return {
			username: detail.username,
			uuid: detail.uuid,
			online: detail.online,
			server: detail.server,
			...(detail.lastAddress ? { address: detail.lastAddress } : {})
		};
	});

	/** The header's verbs: live ones, the lists, the account, then the removals. */
	function headerActions(): ContextMenuItem[] {
		if (!target) {
			return [];
		}

		const groups = playerVerbGroups({
			targets: [target],
			servers,
			open: (kind, targets) => dialogs?.open(kind, targets)
		});

		return menuGroups(
			groups.live,
			[
				...groups.access,
				{
					label: t('web.playerDetail.accountActions'),
					icon: 'key',
					submenu: account?.menu() ?? []
				},
				{
					label: t('web.playerDetail.changeSkin'),
					icon: 'wandMagicSparkles',
					action: () => skinDialog?.show()
				},
				{
					label: t('web.playerDetail.recordAModerationNote'),
					icon: 'note',
					action: () => moderationTab?.openNote()
				}
			],
			[
				{
					id: 'copy-uuid',
					label: t('web.players.copyUuid'),
					icon: 'copy',
					action: () => void copyText(detail?.uuid ?? '')
				},
				{
					id: 'copy-name',
					label: t('web.instancePlayers.copyName'),
					icon: 'copy',
					action: () => void copyText(detail?.username ?? '')
				}
			],
			groups.remove
		);
	}

	async function skinChanged(): Promise<void> {
		skinEpoch = Date.now();

		await refresh();
	}
</script>

<svelte:head><title>{detail?.username ?? ref} | Luna Console</title></svelte:head>

<PageHeader title={detail?.username ?? ref} info={t('web.guide.player')} description={detail?.uuid ?? ''}>
	{#snippet extra()}
		{#if detail}
			{#if detail.online}
				<StatusBadge state="ok" label={t('web.playerDetail.onlineOn', { server: detail.server })} />
			{:else}
				<StatusBadge state="stopped" label={t('web.playerDetail.offline')} />
			{/if}
			{#if standing && standing.banned.length > 0}
				<StatusBadge
					state="failed"
					label={t('web.playerDetail.bannedOnCount', { count: standing.banned.length })}
					detail={standing.banned}
				/>
			{/if}
			{#if auth?.locked}
				<StatusBadge state="warning" label={t('web.playerDetail.locked')} />
			{/if}
		{/if}
	{/snippet}
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="player-detail" />
		<Dropdown label={t('web.playerDetail.actions')} disabled={!detail} menu={headerActions()} />
	{/snippet}
</PageHeader>

{#if notFound}
	<Flash kind="error">
		<b>{t('web.playerDetail.unknownPlayer')}</b>
		{t('web.playerDetail.unknownPlayerDetail', { player: ref })}
	</Flash>
{:else if !available && !detail}
	<Flash kind="warning">
		<b>{t('web.playerDetail.lunacoreIsNotAnswering')}</b>
		{t('web.playerDetail.lunacoreDownDetail', { problem })}
	</Flash>
{:else if detail}
	{#if !available}
		<Flash kind="warning">
			<b>{t('web.playerDetail.lunacoreIsNotAnswering')}</b>
			{t('web.playerDetail.lunacoreDownDetail', { problem })}
		</Flash>
	{/if}

	<OverviewBar title={t('web.playerDetail.playerOverview')}>
		<OverviewCell label={t('web.playerDetail.status')}>
			{#if detail.online}
				<StatusBadge state="ok" label={t('web.players.online')} />
				<ScreenLink href="/instances/{detail.server}/players/{detail.uuid}">{detail.server}</ScreenLink>
			{:else}
				<StatusBadge state="stopped" label={t('web.playerDetail.offline')} />
			{/if}
		</OverviewCell>
		<OverviewCell label={detail.online ? t('web.playerDetail.thisSession') : t('web.playerDetail.lastSeen')}>
			{#if detail.online}
				{fmtDuration(detail.sessionMillis)}
			{:else if detail.lastSeenAtEpochMillis}
				<DateTime at={detail.lastSeenAtEpochMillis} text={fmtDateTime(detail.lastSeenAtEpochMillis)} />
			{:else}
				<span class="dim">–</span>
			{/if}
		</OverviewCell>
		<OverviewCell label={t('web.playerDetail.totalPlaytime')}>
			{detail.totalPlayMillis ? fmtDuration(detail.totalPlayMillis) : '–'}
		</OverviewCell>
		<OverviewCell label={t('web.playerDetail.sessions')}>
			<a href={tabHref('sessions')}>{detail.sessionCount.toLocaleString()}</a>
		</OverviewCell>
		<OverviewCell label={t('web.playerDetail.balance')}>
			{#if vaultAvailable && vault}
				<a class="balance" href={tabHref('economy')}>{vault.balanceFormatted}</a>
			{:else}
				<span class="dim">–</span>
			{/if}
		</OverviewCell>
		<OverviewCell label={t('web.playerDetail.permissionGroup')}>
			{#if detail.permissions.available && detail.permissions.primaryGroup}
				<a href={tabHref('permissions')}>
					{detail.permissions.primaryGroupDisplay || detail.permissions.primaryGroup}
				</a>
			{:else}
				<span class="dim">–</span>
			{/if}
		</OverviewCell>
		<OverviewCell label={t('web.playerDetail.moderationEntries')}>
			<a href={tabHref('moderation')}>{detail.moderationTotal.toLocaleString()}</a>
		</OverviewCell>
	</OverviewBar>

	<Tabs {tabs} active={tab} />

	<div class="tabbody" class:off={tab !== 'overview'}>
		<OverviewTab
			{detail}
			{skinEpoch}
			{standing}
			{here}
			sessions={recentSessions}
			moderation={recentModeration}
			{tabHref}
		/>
	</div>

	<div class="tabbody" class:bare={tab !== 'account'}>
		<AccountSecurity
			bind:this={account}
			player={ref}
			username={detail.username}
			show={tab === 'account'}
			{auth}
			available={authAvailable}
			problem={authProblem}
			onchanged={refresh}
		/>
	</div>

	{#if visited.has('economy')}
		<div class="tabbody" class:off={tab !== 'economy'}>
			<EconomyTab
				player={ref}
				active={tab === 'economy'}
				{refreshKey}
				{vault}
				available={vaultAvailable}
				problem={vaultProblem}
			/>
		</div>
	{/if}

	{#if visited.has('sessions')}
		<div class="tabbody" class:off={tab !== 'sessions'}>
			<HistoryTab player={ref} active={tab === 'sessions'} {refreshKey} />
		</div>
	{/if}

	{#if mayReadChat && visited.has('chat')}
		<div class="tabbody" class:off={tab !== 'chat'}>
			<ChatTab player={ref} active={tab === 'chat'} {refreshKey} />
		</div>
	{/if}

	{#if visited.has('permissions')}
		<div class="tabbody" class:off={tab !== 'permissions'}>
			<PermissionsTab player={ref} active={tab === 'permissions'} {refreshKey} {servers} />
		</div>
	{/if}

	<div class="tabbody" class:bare={tab !== 'moderation'}>
		<ModerationTab
			bind:this={moderationTab}
			player={ref}
			active={tab === 'moderation'}
			{refreshKey}
			onchanged={refresh}
		/>
	</div>

	<SkinDialog
		bind:this={skinDialog}
		player={ref}
		username={detail.username}
		online={detail.online}
		onchanged={skinChanged}
	/>
{/if}

<PlayerActionDialogs bind:this={dialogs} {servers} {instances} ondone={refresh} />

<style lang="scss">
	// one column of panels per tab; the gap is the only spacing between them
	.tabbody {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		margin-top: 1rem;

		&.off {
			display: none;
		}

		// a tab that owns dialogs the header opens: its panels are gone while
		// another tab shows, but the box must not hide the dialogs with them
		&.bare {
			display: contents;
		}

		:global(.flash) {
			margin-bottom: 0;
		}
	}

	.balance {
		font-weight: 700;
	}
</style>
