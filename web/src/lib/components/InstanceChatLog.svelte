<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { api } from '$lib/api';
	import { fmtDateTime } from '$lib/format';
	import { LOG_PAGE, loadWholeLog } from '$lib/log';
	import Panel from './Panel.svelte';
	import Btn from './Btn.svelte';
	import Select from './Select.svelte';
	import Flash from './Flash.svelte';
	import StatusBadge from './StatusBadge.svelte';
	import PlayerName from './PlayerName.svelte';
	import ResourceTable from './ResourceTable.svelte';
	import type { Column } from './table';
	import type { ContextMenuItem } from './contextmenu';
	import { goto } from '$app/navigation';

	/**
	 * Everything said and every command run on one backend, newest first, as the
	 * proxy recorded it. On the proxy itself the log is the whole network's, with
	 * the backend named per line.
	 *
	 * The proxy records chat as it passes through, so this covers external
	 * backends too and needs nothing from the server. A LunaCore build without the
	 * per-server route answers 404, which is shown as "needs a newer build" rather
	 * than as an empty log, because an empty log is a claim about the players.
	 */
	let {
		instance,
		player,
		compact = false
	}: {
		instance: string;
		/** Narrow to one player's lines, by uuid; the instance-scoped player screen */
		player?: string;
		/** Skip the panel chrome; the caller provides it */
		compact?: boolean;
	} = $props();

	interface Entry {
		id: number;
		uuid?: string;
		username?: string;
		server: string;
		type: string;
		content: string;
		atEpochMillis: number;
	}

	let entries: Entry[] = $state([]);
	let total = $state(0);
	let available = $state(true);
	let supported = $state(true);
	let problem = $state('');
	let loading = $state(true);
	let type = $state('');

	const network = $derived(instance === 'proxy');

	async function refresh(): Promise<void> {
		loading = true;

		const typeParam = type ? `&type=${type}` : '';

		try {
			const result = await loadWholeLog<Entry>(async (offset) => {
				const data = player
					? await api(
							`/players/${encodeURIComponent(player)}/chat?server=${encodeURIComponent(instance)}&limit=${LOG_PAGE}&offset=${offset}${typeParam}`
						)
					: await api(
							`/instances/${encodeURIComponent(instance)}/chat?limit=${LOG_PAGE}&offset=${offset}${typeParam}`
						);

				if (data.available === false) {
					available = false;
					supported = data.supported !== false;
					problem = data.error ?? '';

					return { total: 0, rows: [] };
				}

				available = true;
				supported = true;
				problem = '';

				return { total: data.total ?? 0, rows: data.entries ?? [] };
			});

			total = result.total;
			// a per-player log from an older proxy ignores the server filter, so the
			// rows are held to it again here
			entries = player
				? result.rows.filter((entry) => entry.server.toLowerCase() === instance.toLowerCase())
				: result.rows;
		} catch (err) {
			available = false;
			problem = (err as Error).message;
		}

		loading = false;
	}

	onMount(() => {
		void refresh();
	});

	const columns: Column[] = $derived([
		{ id: 'time', label: t('web.instanceChat.colTime'), width: 190, sortable: true },
		...(player ? [] : [{ id: 'player', label: t('web.instanceChat.colPlayer'), sortable: true, minWidth: 160 }]),
		{ id: 'type', label: t('web.instanceChat.colType'), width: 130 },
		...(network ? [{ id: 'server', label: t('web.instanceChat.colBackend'), width: 120, sortable: true }] : []),
		{ id: 'content', label: t('web.instanceChat.colContent'), minWidth: 320 }
	]);

	function sortValue(entry: Entry, col: string): string | number | null {
		switch (col) {
			case 'time':
				return entry.atEpochMillis;

			case 'player':
				return (entry.username ?? '').toLowerCase();

			case 'server':
				return entry.server;

			default:
				return null;
		}
	}

	function rowActions(entry: Entry): ContextMenuItem[] {
		if (!entry.uuid) {
			return [];
		}

		const uuid = entry.uuid;

		return [
			{
				label: t('web.instanceChat.viewOnThisServer'),
				icon: 'userPortrait',
				action: () => goto(`/instances/${encodeURIComponent(entry.server || instance)}/players/${uuid}`)
			},
			{
				label: t('web.instanceChat.viewNetworkProfile'),
				icon: 'user',
				action: () => goto(`/players/${uuid}`)
			}
		];
	}
</script>

{#snippet body()}
	{#if !available && !loading}
		<div class="pad">
			{#if !supported}
				<Flash kind="warning">
					<b>{t('web.instanceChat.needsNewerBuild')}</b> {t('web.instanceChat.needsNewerBuildHint')}
				</Flash>
			{:else}
				<Flash kind="warning">
					<b>{t('web.instanceChat.lunacoreIsNotAnswering')}</b> {problem}
				</Flash>
			{/if}
		</div>
	{/if}

	<ResourceTable
		tableId={player ? 'instance-player-chat' : 'instance-chat'}
		{columns}
		rows={entries}
		getId={(entry) => String(entry.id)}
		searchValue={(entry) => `${entry.username ?? ''} ${entry.content} ${entry.server}`}
		searchPlaceholder={t('web.instanceChat.findInMessages')}
		noun={t('web.instanceChat.nounEntry')}
		pageSize={50}
		{sortValue}
		{rowActions}
		rowLabel={(entry) => entry.username ?? entry.content}
		defaultSort={{ col: 'time', dir: 'desc' }}
		emptyTitle={t('web.instanceChat.nothingRecorded')}
		emptyText={t('web.instanceChat.nothingRecordedHint')}
	>
		{#snippet toolbar()}
			<Select
				label={t('web.instanceChat.filterType')}
				bind:value={type}
				width="14rem"
				options={[
					{ value: '', label: t('web.instanceChat.chatAndCommands') },
					{ value: 'chat', label: t('web.instanceChat.chatOnly') },
					{ value: 'command', label: t('web.instanceChat.commandsOnly') }
				]}
				onchange={() => void refresh()}
			/>
		{/snippet}
		{#snippet cell(entry, col)}
			{#if col === 'time'}
				<span class="mono dim">{fmtDateTime(entry.atEpochMillis)}</span>
			{:else if col === 'player'}
				{#if entry.uuid}
					<PlayerName player={entry.uuid} name={entry.username} href="/instances/{encodeURIComponent(entry.server || instance)}/players/{entry.uuid}" />
				{:else}
					{entry.username ?? '–'}
				{/if}
			{:else if col === 'type'}
				<StatusBadge state={entry.type === 'command' ? 'warning' : 'passed'} label={t(`web.instanceChat.type.${entry.type}`)} />
			{:else if col === 'server'}
				<a href="/instances/{entry.server}">{entry.server || '–'}</a>
			{:else if col === 'content'}
				<span class="mono content">{entry.type === 'command' ? '/' : ''}{entry.content}</span>
			{/if}
		{/snippet}
	</ResourceTable>

	{#if entries.length < total}
		<p class="capped dim">{t('web.instanceChat.newestShown', { shown: entries.length, total })}</p>
	{/if}
{/snippet}

{#if compact}
	{@render body()}
{:else}
	<Panel
		title={network ? t('web.instanceChat.networkTitle') : t('web.instanceChat.title')}
		count={total}
		description={t('web.instanceChat.description')}
		flush
	>
		{#snippet actions()}
			<Btn icon="rotate" onclick={refresh}>{t('web.common.refresh')}</Btn>
		{/snippet}
		{@render body()}
	</Panel>
{/if}

<style lang="scss">
	.pad {
		padding: 1rem 1.25rem 0;
	}

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
