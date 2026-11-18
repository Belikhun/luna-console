<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { untrack } from 'svelte';
	import { t } from '$lib/i18n.svelte';
	import { api, post } from '$lib/api';
	import { LOG_PAGE, loadWholeLog } from '$lib/log';
	import { fmtDateTime } from '$lib/format';
	import { Notify } from '$lib/notifications.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import DateTime from '$lib/components/DateTime.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import type { Column } from '$lib/components/table';
	import { moderationState, type ModEntry } from './player';

	/**
	 * What moderation has recorded about a player, and the note an operator can
	 * add to that record. The note dialog lives here but stays mounted with the
	 * screen, since the header's Actions menu opens it from any tab.
	 */
	let {
		player,
		active,
		refreshKey,
		onchanged
	}: {
		/** The uuid or name the profile was opened with */
		player: string;
		/** Whether this tab is the one on screen; a hidden tab waits for its turn to reload */
		active: boolean;
		/** Bumped by the screen on each refresh */
		refreshKey: number;
		/** A note was recorded; the screen re-reads its counts */
		onchanged?: () => void | Promise<void>;
	} = $props();

	let entries: ModEntry[] = $state([]);
	let total = $state(0);
	let loaded = $state(false);
	let loadedKey = -1;

	let noteOpen = $state(false);
	let noteText = $state('');

	/** Open the note dialog; the header's Actions menu calls this. */
	export function openNote(): void {
		noteText = '';
		noteOpen = true;
	}

	async function load(): Promise<void> {
		try {
			const result = await loadWholeLog<ModEntry>(async (offset) => {
				const more = await api(
					`/players/${encodeURIComponent(player)}/moderation?limit=${LOG_PAGE}&offset=${offset}`
				);

				return more.available === false
					? { total: 0, rows: [] }
					: { total: more.total ?? 0, rows: more.entries ?? [] };
			});

			total = result.total;
			entries = result.rows;
		} catch {
			// the rows already shown stay; the profile's own notice says the directory is down
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

	async function recordNote(): Promise<void> {
		const text = noteText.trim();

		noteOpen = false;

		if (!text) {
			return;
		}

		const busy = t('web.playerDetail.recordingNote');
		const note = Notify.loading(busy);

		try {
			const result = await post(`/players/${encodeURIComponent(player)}/moderation`, {
				action: 'note',
				reason: text
			});

			if (result?.ok === false) {
				throw new Error(result.error ?? '');
			}

			note.set({ level: 'success', message: t('web.playerDetail.noteRecorded'), closeable: true });

			await onchanged?.();
		} catch (err) {
			note.set({ level: 'error', message: busy, detail: (err as Error).message, closeable: true });
		}
	}

	const columns: Column[] = $derived([
		{ id: 'time', label: t('web.playerDetail.time'), width: 180, sortable: true },
		{ id: 'action', label: t('web.playerDetail.action'), width: 170 },
		{ id: 'actor', label: t('web.playerDetail.by'), width: 130 },
		{ id: 'server', label: t('web.playerDetail.where'), width: 160 },
		{ id: 'reason', label: t('web.playerDetail.reason') }
	]);
</script>

<div class:off={!active}>
	<Panel title={t('web.playerDetail.moderation')} count={loaded ? total : undefined} flush>
		{#snippet actions()}
			<Btn icon="note" onclick={openNote}>{t('web.playerDetail.recordANote')}</Btn>
		{/snippet}

		<ResourceTable
			tableId="player-moderation"
			loading={!loaded}
			{columns}
			rows={entries}
			getId={(entry) => String(entry.id)}
			searchValue={(entry) => `${entry.action} ${entry.actor} ${entry.reason} ${entry.server}`}
			searchPlaceholder={t('web.playerDetail.findEntry')}
			noun={t('web.playerDetail.entry')}
			pageSize={25}
			sortValue={(entry, col) => (col === 'time' ? entry.atEpochMillis : null)}
			emptyTitle={t('web.playerDetail.aCleanRecord')}
			emptyText={t('web.playerDetail.kicksBansWhitelistAndOperator')}
		>
			{#snippet cell(entry, col)}
				{#if col === 'time'}
					<span class="mono dim"><DateTime at={entry.atEpochMillis} text={fmtDateTime(entry.atEpochMillis)} /></span>
				{:else if col === 'action'}
					<StatusBadge state={moderationState(entry.action)} label={entry.action} />
				{:else if col === 'actor'}
					{entry.actor || '–'}
				{:else if col === 'server'}
					{entry.server || t('web.playerDetail.wholeNetwork')}
				{:else if col === 'reason'}
					{entry.reason || entry.details || '–'}
				{/if}
			{/snippet}
		</ResourceTable>
		{#if entries.length < total}
			<p class="capped dim">
				{t('web.playerDetail.newestRecordsShown', { shown: entries.length, total })}
			</p>
		{/if}
	</Panel>
</div>

<Modal title={t('web.playerDetail.recordAModerationNote')} bind:open={noteOpen}>
	<label class="field">
		<span class="lbl">{t('web.playerDetail.note')}</span>
		<span class="hint">{t('web.playerDetail.storedInThePlayer')}</span>
		<input class="input" bind:value={noteText} placeholder={t('web.playerDetail.eGWarnedAboutChat')} />
	</label>
	{#snippet footer()}
		<Btn onclick={() => (noteOpen = false)}>{t('web.playerDetail.cancel')}</Btn>
		<Btn variant="primary" disabled={!noteText.trim()} onclick={recordNote}>{t('web.playerDetail.record')}</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.off {
		display: none;
	}

	// the cap is a fact about the table above it, not an invitation to click
	.capped {
		margin: 0;
		padding: 0.75rem 1.25rem;
		font-size: 0.8125rem;
		border-top: 0.1rem solid var(--border-divider);
	}
</style>
