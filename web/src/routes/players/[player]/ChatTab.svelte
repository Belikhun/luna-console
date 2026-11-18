<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { untrack } from 'svelte';
	import { t } from '$lib/i18n.svelte';
	import { api } from '$lib/api';
	import { LOG_PAGE, loadWholeLog } from '$lib/log';
	import { fmtDateTime } from '$lib/format';
	import DateTime from '$lib/components/DateTime.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import Select from '$lib/components/Select.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import type { Column } from '$lib/components/table';
	import type { ChatEntry } from './player';

	/**
	 * What a player said and ran, across the network. The screen mounts this only
	 * for an account allowed `chat:ReadPlayer` on the player, and the route checks
	 * the same thing again and keeps the lines to servers the account may read.
	 */
	let {
		player,
		active,
		refreshKey
	}: {
		/** The uuid or name the profile was opened with */
		player: string;
		/** Whether this tab is the one on screen; a hidden tab waits for its turn to reload */
		active: boolean;
		/** Bumped by the screen on each refresh */
		refreshKey: number;
	} = $props();

	let entries: ChatEntry[] = $state([]);
	let total = $state(0);
	let type = $state('');
	let loaded = $state(false);
	let loadedKey = -1;

	async function load(): Promise<void> {
		const filter = type
			? `&type=${type}`
			: '';

		try {
			const result = await loadWholeLog<ChatEntry>(async (offset) => {
				const more = await api(
					`/players/${encodeURIComponent(player)}/chat?limit=${LOG_PAGE}&offset=${offset}${filter}`
				);

				return more.available === false
					? { total: 0, rows: [] }
					: { total: more.total ?? 0, rows: more.entries ?? [] };
			});

			total = result.total;
			entries = result.rows;
		} catch {
			// the rows already shown stay; a refused read leaves the table as it was
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

	const columns: Column[] = $derived([
		{ id: 'time', label: t('web.playerDetail.time'), width: 180, sortable: true },
		{ id: 'type', label: t('web.playerDetail.type'), width: 140 },
		{ id: 'server', label: t('web.playerDetail.backend'), width: 130 },
		{ id: 'content', label: t('web.playerDetail.content') }
	]);
</script>

<Panel title={t('web.playerDetail.chatCommands')} count={loaded ? total : undefined} flush>
	<ResourceTable
		tableId="player-chat"
		loading={!loaded}
		{columns}
		rows={entries}
		getId={(entry) => String(entry.id)}
		searchValue={(entry) => `${entry.content} ${entry.server} ${entry.type}`}
		searchPlaceholder={t('web.playerDetail.findInMessages')}
		noun={t('web.playerDetail.entry')}
		pageSize={50}
		sortValue={(entry, col) => (col === 'time' ? entry.atEpochMillis : null)}
		emptyTitle={t('web.playerDetail.nothingRecorded')}
		emptyText={t('web.playerDetail.chatAndCommandsAreRecorded')}
	>
		{#snippet toolbar()}
			<Select
				label={t('web.playerDetail.filterType')}
				bind:value={type}
				width="14rem"
				options={[
					{ value: '', label: t('web.playerDetail.chatAndCommands') },
					{ value: 'chat', label: t('web.playerDetail.chatOnly') },
					{ value: 'command', label: t('web.playerDetail.commandsOnly') }
				]}
				onchange={() => void load()}
			/>
		{/snippet}
		{#snippet cell(entry, col)}
			{#if col === 'time'}
				<span class="mono dim"><DateTime at={entry.atEpochMillis} text={fmtDateTime(entry.atEpochMillis)} /></span>
			{:else if col === 'type'}
				<StatusBadge
					state={entry.type === 'command' ? 'warning' : 'passed'}
					label={entry.type === 'command' ? t('web.playerDetail.typeCommand') : t('web.playerDetail.typeChat')}
				/>
			{:else if col === 'server'}
				{entry.server || '–'}
			{:else if col === 'content'}
				<span class="mono content">{entry.type === 'command' ? '/' : ''}{entry.content}</span>
			{/if}
		{/snippet}
	</ResourceTable>
	{#if entries.length < total}
		<p class="capped dim">
			{t('web.playerDetail.newestRecordsShown', { shown: entries.length, total })}
		</p>
	{/if}
</Panel>

<style lang="scss">
	.content {
		word-break: break-word;
	}

	// the cap is a fact about the table above it, not an invitation to click
	.capped {
		margin: 0;
		padding: 0.75rem 1.25rem;
		font-size: 0.8125rem;
		border-top: 0.1rem solid var(--border-divider);
	}
</style>
