<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import { copyText } from '$lib/clipboard';
	import { fmtBytes, fmtDateTime } from '$lib/format';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Select from '$lib/components/Select.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import OverviewBar from '$lib/components/OverviewBar.svelte';
	import OverviewCell from '$lib/components/OverviewCell.svelte';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * The console journal: what luna itself has been doing, as opposed to what a
	 * Minecraft server has been doing.
	 *
	 * The daemon's own log lines, the console's API routes, the CLI and the
	 * sign-in path all append here, so this is the one screen that answers "what
	 * happened to luna" without an ssh session and a screen pane. An instance's
	 * own log is on that instance's Console tab, and the live cluster event feed is
	 * on the instances screen; neither is this.
	 *
	 * The journal is **per machine**: a follower daemon writes its own cluster root,
	 * and this reads the machine the console is attached to. Filters narrow the
	 * fetched tail in the browser, which is why the depth control exists; the same
	 * filters run server-side for `luna logs`, over the whole month.
	 */

	interface LogRow {
		/** the entry's own position in the fetched page; the journal has no ids */
		key: string;
		t: number;
		source: string;
		level: string;
		machine: string;
		message: string;
		detail?: string;
		actor?: string;
	}

	interface LogFile {
		file: string;
		sizeBytes: number;
	}

	/** How deep a read goes. A journal is read from the end, so this is a tail length. */
	const DEPTHS = ['300', '1000', '2500', '5000'];

	let rows: LogRow[] = $state([]);
	let files: LogFile[] = $state([]);
	let truncated = $state(false);
	let depth = $state('300');
	let loading = $state(false);
	let lastUpdated = $state<number | null>(null);
	let selected: Set<string> = $state(new Set());

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const data = await api(`/console/logs?limit=${encodeURIComponent(depth)}`);

			rows = (data.entries as Omit<LogRow, 'key'>[]).map((entry, index) => ({
				...entry,
				key: `${entry.t}:${index}`
			}));
			files = data.files;
			truncated = data.truncated;
			lastUpdated = Date.now();
		} catch (err) {
			Notify.error(t('web.consoleLogs.loadFailed'), { detail: (err as Error).message });
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void refresh();
	});

	const counts = $derived({
		errors: rows.filter((row) => row.level === 'error').length,
		warnings: rows.filter((row) => row.level === 'warn').length,
		bytes: files.reduce((total, file) => total + file.sizeBytes, 0)
	});

	/** One StatusBadge state per level; the same mapping the CLI colours with. */
	function levelState(level: string): string {
		if (level === 'error') {
			return 'failed';
		}

		if (level === 'warn') {
			return 'warning';
		}

		if (level === 'debug') {
			return 'unknown';
		}

		return 'info';
	}

	const columns: Column[] = $derived([
		{ id: 'when', label: t('web.consoleLogs.colWhen'), sortable: true, width: 180 },
		{ id: 'level', label: t('web.consoleLogs.colLevel'), sortable: true, width: 120 },
		{ id: 'source', label: t('web.consoleLogs.colSource'), sortable: true, width: 120 },
		{ id: 'message', label: t('web.consoleLogs.colMessage') },
		{ id: 'actor', label: t('web.consoleLogs.colActor'), sortable: true, width: 150 },
		{ id: 'machine', label: t('web.consoleLogs.colMachine'), sortable: true, width: 140, hidden: true }
	]);

	const filters: TableFilterGroup<LogRow>[] = $derived([
		{
			id: 'source',
			label: t('web.consoleLogs.filterSource'),
			options: [
				{ value: 'any', label: t('web.consoleLogs.anySource') },
				{ value: 'daemon', label: t('web.consoleLogs.sourceDaemon'), match: (row) => row.source === 'daemon' },
				{ value: 'web', label: t('web.consoleLogs.sourceWeb'), match: (row) => row.source === 'web' },
				{ value: 'cli', label: t('web.consoleLogs.sourceCli'), match: (row) => row.source === 'cli' },
				{ value: 'auth', label: t('web.consoleLogs.sourceAuth'), match: (row) => row.source === 'auth' },
				{ value: 'job', label: t('web.consoleLogs.sourceJob'), match: (row) => row.source === 'job' },
				{
					value: 'scheduler',
					label: t('web.consoleLogs.sourceScheduler'),
					match: (row) => row.source === 'scheduler'
				}
			]
		},
		{
			id: 'level',
			label: t('web.consoleLogs.filterLevel'),
			options: [
				{ value: 'any', label: t('web.consoleLogs.anyLevel') },
				{
					value: 'problems',
					label: t('web.consoleLogs.problemsOnly'),
					match: (row) => row.level === 'error' || row.level === 'warn'
				},
				{ value: 'error', label: t('web.consoleLogs.errorsOnly'), match: (row) => row.level === 'error' },
				{ value: 'info', label: t('web.consoleLogs.infoAndAbove'), match: (row) => row.level !== 'debug' }
			]
		}
	]);

	/** The selection as plain text: what an operator pastes into an issue. */
	async function copySelected(): Promise<void> {
		const picked = rows.filter((row) => selected.has(row.key));
		const text = picked
			.map(
				(row) =>
					`${new Date(row.t).toISOString()} ${row.level} ${row.source} ${row.message}${row.detail ? `\n  ${row.detail}` : ''}`
			)
			.join('\n');

		if (await copyText(text)) {
			Notify.success(t('web.consoleLogs.copied', { count: picked.length }));
		}
	}

	const logVerbs: ContextMenuItem[] = $derived([
		{
			label: t('web.consoleLogs.copySelected', { count: selected.size }),
			icon: 'copy',
			disabled: selected.size === 0,
			hint: selected.size ? undefined : t('web.consoleLogs.pickEntries'),
			action: copySelected
		}
	]);

	function rowActions(row: LogRow): ContextMenuItem[] {
		return [
			{
				label: t('web.consoleLogs.copyEntry'),
				icon: 'copy',
				action: async () => {
					await copyText(
						`${new Date(row.t).toISOString()} ${row.level} ${row.source} ${row.message}`
					);
				}
			},
			{
				label: t('web.consoleLogs.copyMessage'),
				icon: 'copy',
				action: async () => {
					await copyText(row.message);
				}
			}
		];
	}
</script>

<svelte:head><title>{t('web.nav.consoleLogs')} | Luna Console</title></svelte:head>

<PageHeader
	title={t('web.nav.consoleLogs')}
	count={rows.length}
	description={t('web.consoleLogs.pageDescription')}
	info
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="console-logs" />
		<Dropdown label={t('web.common.actions')} disabled={selected.size === 0} menu={logVerbs} />
	{/snippet}
</PageHeader>

<OverviewBar title={t('web.consoleLogs.overview')}>
	<OverviewCell label={t('web.consoleLogs.overviewShown')}>{rows.length}</OverviewCell>
	<OverviewCell label={t('web.consoleLogs.overviewErrors')}>{counts.errors}</OverviewCell>
	<OverviewCell label={t('web.consoleLogs.overviewWarnings')}>{counts.warnings}</OverviewCell>
	<OverviewCell label={t('web.consoleLogs.overviewArchives')}>
		{files.length}
		<span class="dim">({fmtBytes(counts.bytes)})</span>
	</OverviewCell>
</OverviewBar>

{#if truncated}
	<Flash kind="info">{t('web.consoleLogs.truncatedNotice', { count: rows.length })}</Flash>
{/if}

<!-- the search box is narrowed from the default 26rem: the depth picker and two
     filter groups share this bar, and at full width the last group wraps -->
<Panel flush>
	<ResourceTable
		tableId="console-logs"
		initialSearch={page.url.searchParams.get('q') ?? ''}
		{columns}
		{filters}
		{rows}
		getId={(row) => row.key}
		searchValue={(row) =>
			`${row.source} ${row.level} ${row.message} ${row.detail ?? ''} ${row.actor ?? ''}`}
		searchPlaceholder={t('web.consoleLogs.searchPlaceholder')}
		searchWidth="18rem"
		selectable="multi"
		bind:selected
		{rowActions}
		rowLabel={(row) => row.message}
		rowDim={(row) => row.level === 'debug'}
		noun={t('web.consoleLogs.noun')}
		sortValue={(row, col) => (col === 'when' ? row.t : null)}
		emptyTitle={t('web.consoleLogs.emptyTitle')}
		emptyText={t('web.consoleLogs.emptyText')}
		toolbar={depthPicker}
	>
		{#snippet cell(row, col)}
			{#if col === 'when'}
				<span class="dim nowrap">{fmtDateTime(row.t)}</span>
			{:else if col === 'level'}
				<StatusBadge state={levelState(row.level)} label={row.level} />
			{:else if col === 'source'}
				<span class="source {row.source}">{row.source}</span>
			{:else if col === 'message'}
				<span class="msg">{row.message}</span>
				{#if row.detail}
					<span class="detail dim">{row.detail}</span>
				{/if}
			{:else if col === 'actor'}
				<span class:dim={!row.actor}>{row.actor || '–'}</span>
			{:else if col === 'machine'}
				<span class="dim">{row.machine || '–'}</span>
			{/if}
		{/snippet}
	</ResourceTable>
</Panel>

{#snippet depthPicker()}
	<Select
		label={t('web.consoleLogs.depth')}
		value={depth}
		width="11rem"
		searchable={false}
		options={DEPTHS.map((value) => ({
			value,
			label: t('web.consoleLogs.newestN', { count: value })
		}))}
		onchange={(value) => {
			depth = value;
			void refresh();
		}}
	/>
{/snippet}

<style lang="scss">
	// the source vocabulary keeps one colour per writer everywhere it appears
	.source {
		font-size: 0.75rem;

		&.daemon {
			color: var(--link);
		}

		&.web {
			color: var(--success);
		}

		&.cli {
			color: var(--warning);
		}

		&.auth {
			color: var(--src-luna);
		}

		&.job,
		&.scheduler {
			color: var(--text-secondary);
		}
	}

	.msg {
		display: block;
	}

	// the second line of a message: a stack, a path, the address behind a sign-in
	.detail {
		display: block;
		font-size: 0.75rem;
		margin-top: 0.125rem;
	}
</style>
