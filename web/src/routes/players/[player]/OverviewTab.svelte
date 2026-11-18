<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { resourceId } from '$shared/iam/resources';
	import { fmtDuration, fmtDateTime } from '$lib/format';
	import { blockCoords, gameModeState, pingClass } from '$lib/players';
	import { dimensionLabel } from '$core/playerdata';
	import ScreenLink from '$lib/components/ScreenLink.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import PlayerVitals from '$lib/components/PlayerVitals.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import DateTime from '$lib/components/DateTime.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import type { InfoCell } from '$lib/components/grid';
	import Panel from '$lib/components/Panel.svelte';
	import PlayerSkin3D from '$lib/components/PlayerSkin3D.svelte';
	import RankedList from '$lib/components/RankedList.svelte';
	import type { RankedRow } from '$lib/components/ranked';
	import ResourceIdValue from '$lib/components/ResourceIdValue.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ChatChannel from '$lib/components/ChatChannel.svelte';
	import type { PlayerChatChannel } from '$core/services/luna';
	import type { Column } from '$lib/components/table';
	import { moderationState } from './player';
	import type { AccessStanding, Detail, LiveOnInstance, ModEntry, PlayerTab, Session } from './player';

	/**
	 * The profile at a glance: who the player is, where they play, where they
	 * stand on the servers' access lists, and the newest of their sessions and
	 * moderation record, each with the way to the full list.
	 */
	let {
		detail,
		skinEpoch,
		standing,
		here,
		chatChannel,
		sessions,
		moderation,
		tabHref
	}: {
		detail: Detail;
		/** Bumped after a skin change so the viewer fetches the new one */
		skinEpoch: number;
		/** Null when the lists could not be read, or the account may not list them */
		standing: AccessStanding | null;
		/** The player on the backend they are on right now; null when offline or out of the account's sight */
		here: LiveOnInstance | null;
		/** The channel their next chat line goes to; null when the proxy cannot say */
		chatChannel: PlayerChatChannel | null;
		/** The newest few sessions */
		sessions: Session[];
		/** The newest few moderation entries */
		moderation: ModEntry[];
		tabHref: (tab: PlayerTab) => string;
	} = $props();

	const backend = $derived(detail.online ? detail.server : detail.lastServer);

	// the profile is a new object on every refresh; the skin viewer rebuilds
	// when its player changes, so it is handed the id alone, which does not
	const uuid = $derived(detail.uuid);

	const identityCells: InfoCell[] = $derived([
		// no `id`: an identified cell is handed to the `custom` snippet below
		{ label: t('web.playerDetail.uuid'), value: detail.uuid, style: 'mono', copyable: true, colSpan: 2 },
		{ id: 'resourceId', label: t('web.resourceId.label') },
		{
			label: t('web.playerDetail.accountType'),
			value: detail.onlineMode
				? t('web.playerDetail.accountPremium')
				: t('web.playerDetail.accountOffline')
		},
		{
			label: t('web.playerDetail.firstSeen'),
			value: detail.firstSeenAtEpochMillis ? fmtDateTime(detail.firstSeenAtEpochMillis) : null,
			time: detail.firstSeenAtEpochMillis || null
		},
		{
			label: t('web.playerDetail.lastSeen'),
			value: detail.online
				? t('web.playerDetail.onlineNow')
				: detail.lastSeenAtEpochMillis
					? fmtDateTime(detail.lastSeenAtEpochMillis)
					: null,
			time: detail.online
				? undefined
				: detail.lastSeenAtEpochMillis || null
		},
		{
			label: detail.online ? t('web.playerDetail.currentBackend') : t('web.playerDetail.lastBackend'),
			value: backend || null,
			href: backend ? `/instances/${backend}/players/${detail.uuid}` : undefined,
			leaves: true
		},
		{ label: t('web.playerDetail.lastAddress'), value: detail.lastAddress || null, style: 'mono', copyable: !!detail.lastAddress },
		{ label: t('web.playerDetail.clientVersion'), value: detail.lastClientVersion || null },
		{
			label: t('web.playerDetail.permissionGroup'),
			value: detail.permissions.available
				? detail.permissions.primaryGroupDisplay || detail.permissions.primaryGroup || null
				: t('web.playerDetail.luckpermsUnavailable'),
			// the display name is what LuckPerms shows; the group's own name
			// is what its detail screen is keyed by
			href: detail.permissions.available && detail.permissions.primaryGroup
				? `/permissions/${encodeURIComponent(detail.permissions.primaryGroup)}`
				: undefined,
			leaves: true
		},
		{ label: t('web.playerDetail.chatMessages'), value: detail.chatTotal.toLocaleString() },
		{ label: t('web.playerDetail.commands'), value: detail.commandTotal.toLocaleString() }
	]);

	const saved = $derived(here?.detail.snapshot ?? null);

	const hereCells: InfoCell[] = $derived.by(() => {
		if (!here) {
			return [];
		}

		return [
			{ id: 'gamemode', label: t('web.instancePlayer.gameMode') },
			{ id: 'position', label: t('web.instancePlayer.position') },
			{ id: 'ping', label: t('web.instancePlayer.ping') },
			{ id: 'channel', label: t('web.chatChannel.label') },
			{
				label: t('web.playerDetail.thisSession'),
				value: here.live ? fmtDuration(here.live.sessionMillis) : null
			},
			{
				label: t('web.instancePlayer.advancements'),
				value: here.detail.advancements
					? `${here.detail.advancements.done} / ${here.detail.advancements.total}`
					: null
			},
			{ label: t('web.instancePlayer.client'), value: here.live?.clientVersion ?? null }
		];
	});

	// each backend's row opens the player as that server saved them
	const playtimeRows: RankedRow[] = $derived(
		detail.playtimeByServer.map((entry) => ({
			key: entry.server || 'unknown',
			label: entry.server || t('web.common.unknown'),
			count: entry.playMillis,
			secondary: t('web.playerDetail.sessionCount', { count: entry.stints }),
			...(entry.server ? { href: `/instances/${entry.server}/players/${detail.uuid}` } : {})
		}))
	);

	const standingCells: InfoCell[] = $derived([
		{ id: 'banned', label: t('web.playerDetail.bannedOn') },
		{ id: 'operator', label: t('web.playerDetail.operatorOn') },
		{ id: 'whitelisted', label: t('web.playerDetail.whitelistedOn') }
	]);

	const sessionCols: Column[] = $derived([
		{ id: 'connected', label: t('web.playerDetail.connected') },
		{ id: 'server', label: t('web.playerDetail.backend') },
		{ id: 'duration', label: t('web.playerDetail.duration'), align: 'right' }
	]);

	const modCols: Column[] = $derived([
		{ id: 'time', label: t('web.playerDetail.time') },
		{ id: 'action', label: t('web.playerDetail.action') },
		{ id: 'actor', label: t('web.playerDetail.by') },
		{ id: 'reason', label: t('web.playerDetail.reason') }
	]);
</script>

<div class="top">
	<Panel title={t('web.playerDetail.skin')} description={t('web.playerDetail.pickAPoseDragThe')}>
		<div class="skin">
			<PlayerSkin3D player={uuid} bust={skinEpoch} />
		</div>
	</Panel>

	<Panel title={t('web.playerDetail.identity')}>
		<InfoGrid cells={identityCells} columns={[3, 2, 1]}>
			{#snippet custom(cell)}
				{#if cell.id === 'resourceId'}
					<ResourceIdValue value={resourceId('player', detail.username)} label={cell.label} />
				{/if}
			{/snippet}
		</InfoGrid>
	</Panel>
</div>

{#if here}
	<Panel
		title={t('web.playerDetail.nowOn', { server: here.instance })}
		description={saved
			? t('web.instancePlayer.savedNote', { when: fmtDateTime(saved.savedAt) })
			: t('web.playerDetail.nowOnNoSave')}
	>
		{#snippet actions()}
			<Btn icon="userPortrait" href="/instances/{encodeURIComponent(here.instance)}/players/{detail.uuid}">
				{t('web.players.viewOnBackend', { server: here.instance })}
			</Btn>
		{/snippet}

		<div class="here">
			{#if saved}
				<div class="vitals">
					<PlayerVitals kind="health" value={saved.health} max={saved.maxHealth} extra={saved.absorption} />
					<PlayerVitals kind="food" value={saved.food} />
					<PlayerVitals kind="xp" value={saved.xpProgress} level={saved.xpLevel} />
				</div>
			{/if}

			<InfoGrid cells={hereCells} columns={[3, 2, 1]}>
				{#snippet custom(cell)}
					{#if cell.id === 'gamemode'}
						{#if saved}
							<StatusBadge state={gameModeState(saved.gameMode)} label={t(`web.instancePlayers.mode.${saved.gameMode}`)} />
						{:else}
							<span class="dim">–</span>
						{/if}
					{:else if cell.id === 'position'}
						{#if saved}
							<span class="mono">{blockCoords(saved.position)}</span>
							<span class="dim">{dimensionLabel(saved.position.dimension)}</span>
						{:else}
							<span class="dim">–</span>
						{/if}
					{:else if cell.id === 'channel'}
						<ChatChannel
							type={chatChannel?.type}
							targetName={chatChannel?.targetName}
							targetUuid={chatChannel?.targetUuid}
							isolated={chatChannel?.isolated}
						/>
					{:else if cell.id === 'ping'}
						{#if here.live}
							<span class="ping {pingClass(here.live.pingMillis)}">{here.live.pingMillis} ms</span>
						{:else}
							<span class="dim">–</span>
						{/if}
					{/if}
				{/snippet}
			</InfoGrid>
		</div>
	</Panel>
{/if}

<div class="pair">
	<Panel
		fill
		title={t('web.playerDetail.playtimeByBackend')}
		description={t('web.playerDetail.closedPlaySessionsOnlyThe')}
	>
		<RankedList
			rows={playtimeRows}
			label={t('web.playerDetail.playtimeByBackend')}
			total={detail.playtimeByServer.reduce((sum, entry) => sum + entry.playMillis, 0)}
			formatValue={fmtDuration}
			empty={t('web.playerDetail.noCompletedPlaySessions')}
		/>
	</Panel>

	{#if standing}
		<Panel fill title={t('web.playerDetail.accessLists')} description={t('web.playerDetail.accessListsHint')}>
			{#snippet actions()}
				<Btn icon="arrowUpRightFromSquare" href="/players/moderation?q={encodeURIComponent(detail.username)}">
					{t('web.nav.moderation')}
				</Btn>
			{/snippet}

			<InfoGrid cells={standingCells} columns={1}>
				{#snippet custom(cell)}
					{@const servers = cell.id === 'banned'
						? standing.banned
						: cell.id === 'operator'
							? standing.operator
							: standing.whitelisted}
					{#if servers.length === 0}
						<span class="dim">{t('web.playerDetail.nowhere')}</span>
					{:else}
						<span class="servers">
							{#if cell.id === 'banned'}
								<StatusBadge state="failed" label={t('web.playerActions.banned')} />
							{/if}
							{#each servers as server (server)}
								<ScreenLink href="/instances/{server}/access">{server}</ScreenLink>
							{/each}
						</span>
					{/if}
				{/snippet}
			</InfoGrid>
		</Panel>
	{/if}
</div>

<div class="pair">
	<Panel fill title={t('web.playerDetail.recentSessions')} flush>
		{#snippet actions()}
			<Btn icon="clockRotateLeft" href={tabHref('sessions')}>{t('web.playerDetail.playHistory')}</Btn>
		{/snippet}

		<DataTable
			columns={sessionCols}
			rows={sessions}
			getId={(session) => String(session.id)}
			emptyTitle={t('web.playerDetail.noSessionsRecorded')}
		>
			{#snippet cell(session, col)}
				{#if col === 'connected'}
					<DateTime at={session.connectedAtEpochMillis} text={fmtDateTime(session.connectedAtEpochMillis)} />
				{:else if col === 'server'}
					<ScreenLink href="/instances/{session.server}/players/{detail.uuid}">{session.server}</ScreenLink>
				{:else if col === 'duration'}
					{#if session.open}
						<StatusBadge state="ok" label={t('web.playerDetail.ongoing')} />
					{:else}
						{fmtDuration(session.durationMillis)}
					{/if}
				{/if}
			{/snippet}
		</DataTable>
	</Panel>

	<Panel fill title={t('web.playerDetail.recentModeration')} flush>
		{#snippet actions()}
			<Btn icon="gavel" href={tabHref('moderation')}>{t('web.playerDetail.moderation')}</Btn>
		{/snippet}

		<DataTable
			columns={modCols}
			rows={moderation}
			getId={(entry) => String(entry.id)}
			emptyTitle={t('web.playerDetail.aCleanRecord')}
		>
			{#snippet cell(entry, col)}
				{#if col === 'time'}
					<span class="dim"><DateTime at={entry.atEpochMillis} text={fmtDateTime(entry.atEpochMillis)} /></span>
				{:else if col === 'action'}
					<StatusBadge state={moderationState(entry.action)} label={entry.action} />
				{:else if col === 'actor'}
					{entry.actor || '–'}
				{:else if col === 'reason'}
					{entry.reason || entry.details || '–'}
				{/if}
			{/snippet}
		</DataTable>
	</Panel>
</div>

<style lang="scss">
	// the skin keeps its own width; the facts fill the rest
	.top {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 1rem;
		align-items: stretch;

		@include below($bp-medium) {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	// two across, level with each other; a panel left alone on its row takes the row
	.pair {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem;
		align-items: stretch;

		> :global(:only-child) {
			grid-column: 1 / -1;
		}

		@include below($bp-medium) {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.skin {
		display: flex;
		justify-content: center;
		padding: 0.5rem 1.5rem;
	}

	// the bars beside the facts; under them once the panel is too narrow for both
	.here {
		display: grid;
		grid-template-columns: minmax(16rem, 26rem) minmax(0, 1fr);
		gap: 1.5rem;
		align-items: start;

		@include below($bp-medium) {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.vitals {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
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

	.servers {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.75rem;
	}
</style>
