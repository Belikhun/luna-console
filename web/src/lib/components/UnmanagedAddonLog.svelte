<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { api } from '$lib/api';
	import type { UnmanagedAddonRow } from '$core/pluginstate';
	import Modal from './Modal.svelte';
	import Alerts from './Alerts.svelte';
	import Spinner from './Spinner.svelte';
	import StatusBadge from './StatusBadge.svelte';

	/**
	 * The boot-session log of one addon jar that luna does not manage.
	 *
	 * A modal rather than a page, which is what a managed addon gets: that page
	 * exists to carry the things a *managed* addon has - a provider, a channel, a
	 * version pin, per-instance targeting - and an unmanaged jar has none of them.
	 * What it has is a descriptor and a set of log lines, which is this.
	 *
	 * The lines are fetched on open rather than carried in the addons snapshot: a
	 * modpack has several hundred of these rows, and their line sets together are
	 * far larger than everything else the tab streams.
	 */
	let {
		instance,
		row = null,
		open = $bindable(false),
		stateBadge
	}: {
		instance: string;
		row?: UnmanagedAddonRow | null;
		open: boolean;
		/** The same state vocabulary the tables use, so one row reads alike in both */
		stateBadge?: Record<string, { state: string; label: string }>;
	} = $props();

	let loading = $state(false);
	let failure = $state('');
	let log = $state<{ lines: string[]; warnings: number; errors: number } | null>(null);
	let sessionComplete = $state(true);

	/** Which row the currently held log belongs to, so a reopen refetches. */
	let loadedFor = $state('');

	const rowId = $derived(row ? `${row.dir}/${row.file}` : '');
	const badge = $derived(row && stateBadge ? stateBadge[row.state] : undefined);

	$effect(() => {
		if (!open || !row || rowId === loadedFor) {
			return;
		}

		void load(row.file, row.dir, rowId);
	});

	async function load(file: string, dir: string, id: string): Promise<void> {
		loading = true;
		failure = '';
		log = null;

		try {
			const data = await api(
				`/instances/${instance}/unmanaged/${encodeURIComponent(file)}?dir=${encodeURIComponent(dir)}`
			);

			log = data.log;
			sessionComplete = data.sessionComplete;
			loadedFor = id;
		} catch (err) {
			failure = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	/**
	 * Colour one line by its own level. FATAL is read as an error, matching what
	 * the report's tallies count, so a line the console coloured plainly cannot be
	 * the one behind an error badge.
	 */
	function lineSeverity(line: string): 'warn' | 'error' | '' {
		if (/\[[^\]]*\/(?:ERROR|FATAL)\]|\[(?:ERROR|FATAL)\]:/.test(line)) {
			return 'error';
		}

		if (/\[[^\]]*\/WARN\]|\[WARN\]:/.test(line)) {
			return 'warn';
		}

		return '';
	}
</script>

<Modal title={row ? row.displayName : t('web.unmanagedLog.title')} bind:open wide>
	{#if row}
		<div class="head">
			<div class="ids">
				<span class="mono file">{row.file}</span>
				<span class="dim">{row.dir}/</span>
				{#if badge}
					<StatusBadge state={badge.state} label={badge.label} />
				{/if}
			</div>
			{#if log}
				<Alerts warnings={log.warnings} errors={log.errors} />
			{/if}
		</div>

		{#if row.meta?.description}
			<p class="desc">{row.meta.description}</p>
		{/if}

		<dl class="facts">
			{#if row.meta?.version}
				<dt>{t('web.unmanagedLog.version')}</dt>
				<dd class="mono">{row.meta.version}</dd>
			{/if}
			{#if row.meta?.id}
				<dt>{t('web.unmanagedLog.modId')}</dt>
				<dd class="mono">{row.meta.id}</dd>
			{/if}
			{#if row.meta?.authors?.length}
				<dt>{t('web.unmanagedLog.authors')}</dt>
				<dd>{row.meta.authors.join(', ')}</dd>
			{/if}
			<!-- absent when the report came from a daemon on a build that predates the
			     field; the dialog still has everything else it needs -->
			{#if row.aliases?.length}
				<dt>{t('web.unmanagedLog.logsUnder')}</dt>
				<dd class="mono">{row.aliases.join(', ')}</dd>
			{/if}
		</dl>

		{#if loading}
			<p class="state"><Spinner size="0.875rem" /> {t('web.unmanagedLog.reading')}</p>
		{:else if failure}
			<p class="state error">{failure}</p>
		{:else if log && log.lines.length}
			<pre class="logview mono">{#each log.lines as line, index (index)}<span
						class="line {lineSeverity(line)}">{line}
</span>{/each}</pre>
			{#if !sessionComplete}
				<p class="dim note">{t('web.unmanagedLog.bootLinesRotated')}</p>
			{/if}
		{:else if log}
			<p class="state dim">{t('web.unmanagedLog.nothingLogged')}</p>
		{/if}
	{/if}
</Modal>

<style lang="scss">
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
		margin-bottom: 0.75rem;
	}

	.ids {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.file {
		font-size: 0.8125rem;
	}

	.desc {
		margin: 0 0 0.75rem;
		color: var(--text-secondary);
	}

	.facts {
		display: grid;
		grid-template-columns: minmax(6rem, auto) 1fr;
		gap: 0.25rem 1rem;
		margin: 0 0 1rem;
		font-size: 0.8125rem;

		dt {
			color: var(--text-secondary);
		}

		dd {
			margin: 0;
			// a long alias list must wrap rather than widen the dialog
			word-break: break-word;
		}
	}

	.logview {
		margin: 0;
		padding: 0.75rem 1rem;
		max-height: 45vh;
		overflow: auto;
		font-size: 0.75rem;
		line-height: 1.5;
		background: var(--bg-terminal);
		border-radius: 0.375rem;
		white-space: pre-wrap;
		word-break: break-all;

		.line.warn {
			color: var(--warning);
		}

		.line.error {
			color: var(--error);
		}
	}

	.state {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0;

		&.error {
			color: var(--error);
		}
	}

	.note {
		margin: 0.625rem 0 0;
		font-size: 0.8125rem;
	}
</style>
