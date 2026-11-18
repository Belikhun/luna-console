<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { untrack } from 'svelte';
	import { t } from '$lib/i18n.svelte';
	import { api } from '$lib/api';
	import { LOG_LIMIT, LOG_PAGE } from '$lib/log';
	import { fmtDateTime } from '$lib/format';
	import DateTime from '$lib/components/DateTime.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import type { InfoCell } from '$lib/components/grid';
	import Panel from '$lib/components/Panel.svelte';
	import PlayerName from '$lib/components/PlayerName.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import type { VaultInfo, VaultTx } from './player';

	/** A player's wallet and every transaction on it, held by LunaVault on the proxy. */
	let {
		player,
		active,
		refreshKey,
		vault,
		available,
		problem
	}: {
		/** The uuid or name the profile was opened with */
		player: string;
		/** Whether this tab is the one on screen; a hidden tab waits for its turn to reload */
		active: boolean;
		/** Bumped by the screen on each refresh */
		refreshKey: number;
		/** The account summary; the screen reads it for its overview bar too */
		vault: VaultInfo | undefined;
		available: boolean;
		problem: string;
	} = $props();

	let entries: VaultTx[] = $state([]);
	let total = $state(0);
	let loaded = $state(false);
	let loadedKey = -1;

	async function page(index: number): Promise<{ entries: VaultTx[]; total: number; maxPage: number }> {
		const data = await api(
			`/players/${encodeURIComponent(player)}/vault/transactions?page=${index}&pageSize=${LOG_PAGE}`
		);

		if (data.available === false) {
			return { entries: [], total: 0, maxPage: 0 };
		}

		return { entries: data.entries ?? [], total: data.totalCount ?? 0, maxPage: data.maxPage ?? 0 };
	}

	async function load(): Promise<void> {
		try {
			const first = await page(0);

			// LunaVault pages this log by page index rather than by row offset
			const lastPage = Math.min(first.maxPage, Math.ceil(LOG_LIMIT / LOG_PAGE) - 1);
			const indexes: number[] = [];

			for (let index = 1; index <= lastPage; index++) {
				indexes.push(index);
			}

			const rest = await Promise.all(indexes.map(async (index) => (await page(index)).entries));

			total = first.total;
			entries = [...first.entries, ...rest.flat()];
		} catch {
			// the rows already shown stay; the notice above says the vault is down
		} finally {
			loaded = true;
		}
	}

	$effect(() => {
		if (active && loadedKey !== refreshKey) {
			loadedKey = refreshKey;
			untrack(() => void load());
		}
	});

	const cells: InfoCell[] = $derived(
		vault
			? [
					{ label: t('web.playerDetail.balance'), value: vault.balanceFormatted, style: 'heading' },
					{
						label: t('web.playerDetail.leaderboardRank'),
						value: vault.rank
							? t('web.playerDetail.rankOf', { rank: vault.rank, total: vault.accountCount })
							: null
					},
					{ label: t('web.playerDetail.transactions'), value: vault.summary.transactionCount },
					{ label: t('web.playerDetail.totalReceived'), value: vault.summary.receivedFormatted },
					{ label: t('web.playerDetail.totalSpent'), value: vault.summary.sentFormatted },
					{
						label: t('web.playerDetail.firstTransaction'),
						value: vault.summary.firstAtEpochMillis
							? fmtDateTime(vault.summary.firstAtEpochMillis)
							: null,
						time: vault.summary.firstAtEpochMillis || null
					},
					{
						label: t('web.playerDetail.lastTransaction'),
						value: vault.summary.lastAtEpochMillis
							? fmtDateTime(vault.summary.lastAtEpochMillis)
							: null,
						time: vault.summary.lastAtEpochMillis || null
					}
				]
			: []
	);

	const columns: Column[] = $derived([
		{ id: 'time', label: t('web.playerDetail.time'), width: 180, sortable: true },
		{ id: 'direction', label: t('web.playerDetail.direction'), width: 130 },
		{ id: 'amount', label: t('web.playerDetail.amount'), width: 150, sortable: true, align: 'right' },
		{ id: 'counterparty', label: t('web.playerDetail.counterparty'), minWidth: 160 },
		{ id: 'source', label: t('web.playerDetail.source'), width: 140 },
		{ id: 'details', label: t('web.playerDetail.details') }
	]);

	const DIRECTIONS: Record<VaultTx['direction'], { state: string; label: string; sign: string }> = {
		in: { state: 'passed', label: 'web.playerDetail.txReceived', sign: '+' },
		out: { state: 'warning', label: 'web.playerDetail.txPaid', sign: '−' },
		self: { state: 'stopped', label: 'web.playerDetail.txAdjusted', sign: '±' }
	};

	const filters: TableFilterGroup<VaultTx>[] = $derived([
		{
			id: 'direction',
			label: t('web.playerDetail.direction'),
			options: [
				{ value: 'any', label: t('web.playerDetail.anyDirection') },
				...(['in', 'out', 'self'] as const).map((direction) => ({
					value: direction,
					label: t(DIRECTIONS[direction].label),
					match: (entry: VaultTx) => entry.direction === direction
				}))
			]
		}
	]);
</script>

{#if !available}
	<Flash kind="warning">
		<b>{t('web.playerDetail.lunavaultIsNotAnswering')}</b>
		{t('web.playerDetail.vaultDownDetail', { problem })}
	</Flash>
{:else}
	{#if vault && !vault.hasAccount}
		<Flash kind="info">
			{t('web.playerDetail.thisPlayerHasNo')}
		</Flash>
	{/if}

	<Panel
		title={t('web.playerDetail.wallet')}
		description={t('web.playerDetail.heldByLunavaultOnThe')}
	>
		<InfoGrid {cells} columns={[4, 2, 1]} />
	</Panel>

	<Panel title={t('web.playerDetail.transactions')} count={loaded ? total : undefined} flush>
		<ResourceTable
			tableId="player-transactions"
			loading={!loaded}
			{columns}
			{filters}
			rows={entries}
			getId={(entry) => entry.id}
			searchValue={(entry) => `${entry.counterpartyName} ${entry.source} ${entry.details}`}
			searchPlaceholder={t('web.playerDetail.findInTransactions')}
			noun={t('web.playerDetail.transaction')}
			pageSize={25}
			sortValue={(entry, col) =>
				col === 'time'
					? entry.atEpochMillis
					: col === 'amount'
						? entry.amountMinor
						: null}
			emptyTitle={t('web.playerDetail.noTransactions')}
			emptyText={t('web.playerDetail.everyPaymentRewardAndAdmin')}
		>
			{#snippet cell(entry, col)}
				{#if col === 'time'}
					<span class="mono dim"><DateTime at={entry.atEpochMillis} text={fmtDateTime(entry.atEpochMillis)} /></span>
				{:else if col === 'direction'}
					<StatusBadge state={DIRECTIONS[entry.direction].state} label={t(DIRECTIONS[entry.direction].label)} />
				{:else if col === 'amount'}
					<span class="amount {entry.direction}">
						{DIRECTIONS[entry.direction].sign}{entry.amountFormatted}
					</span>
				{:else if col === 'counterparty'}
					{#if entry.system}
						<span class="dim">{t('web.playerDetail.system')}</span>
					{:else if entry.counterpartyUuid}
						<PlayerName player={entry.counterpartyUuid} name={entry.counterpartyName} />
					{:else}
						{entry.counterpartyName || '–'}
					{/if}
				{:else if col === 'source'}
					<span class="mono">{entry.source || '–'}</span>
				{:else if col === 'details'}
					{entry.details || '–'}
				{/if}
			{/snippet}
		</ResourceTable>
		{#if entries.length < total}
			<p class="capped dim">
				{t('web.playerDetail.newestRecordsShown', { shown: entries.length, total })}
			</p>
		{/if}
	</Panel>
{/if}

<style lang="scss">
	// the sign already says which way the money went; the colour is there so a
	// column of transactions reads at a glance, not to carry the meaning alone
	.amount {
		font-variant-numeric: tabular-nums;
		white-space: nowrap;

		&.in {
			color: var(--success);
		}

		&.out {
			color: var(--warning);
		}

		// an admin adjusting their own balance: no direction to colour
		&.self {
			color: var(--text-secondary);
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
