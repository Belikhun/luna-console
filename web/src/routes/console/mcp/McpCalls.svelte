<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { untrack } from 'svelte';
	import { api } from '$lib/api';
	import { copyText } from '$lib/clipboard';
	import { fmtDateTime } from '$lib/format';
	import { t } from '$lib/i18n.svelte';
	import { accountHref } from '$lib/iam';
	import { Notify } from '$lib/notifications.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import ButtonGroup from '$lib/components/ButtonGroup.svelte';
	import DateTime from '$lib/components/DateTime.svelte';
	import DetailPanel from '$lib/components/DetailPanel.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import Select from '$lib/components/Select.svelte';
	import StackedBars from '$lib/components/StackedBars.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import TimeRangePicker from '$lib/components/TimeRangePicker.svelte';
	import { fmtValue } from '$lib/components/chart';
	import { menuGroups, type ContextMenuItem } from '$lib/components/contextmenu';
	import type { InfoCell } from '$lib/components/grid';
	import type { Column } from '$lib/components/table';
	import { DEFAULT_RANGE, resolveRange, type TimeRange } from '$lib/components/timerange';
	import type { McpToolGroup } from '$shared/mcptools';
	import type { McpCallPage, McpCallRecord } from '$core/mcp';
	import {
		CALL_SHELL_GROUPS,
		behalfLabel,
		callAccount,
		callArgs,
		callBadge,
		callCaller,
		callChangesState,
		callGroup,
		callInstance,
		callInstanceHref,
		callOutcome,
		callSeries,
		callStyles,
		prettyArgs,
		type CallOutcome,
		type CallRow
	} from './mcp';

	/**
	 * One token's calls, newest first: presets and filters over what is loaded,
	 * a histogram of what the table shows, and the selected call in full in the
	 * split panel. The screen hands in its newest page; a range reaching past it,
	 * or paging onto the last page, reads further back, and a refresh merges in
	 * without dropping what was reached.
	 */

	let {
		token,
		records,
		truncated,
		loading = false,
		lastUpdated = null,
		tableId,
		emptyText
	}: {
		/** The token's id, for reading older calls */
		token: string;
		/** The newest calls, as the screen last read them */
		records: McpCallRecord[];
		/** Whether older calls exist past `records` */
		truncated: boolean;
		loading?: boolean;
		lastUpdated?: number | null;
		tableId: string;
		emptyText: string;
	} = $props();

	const PAGE = 500;
	const SLOW_MS = 1000;
	const SOME = '\u0001some';
	const NONE = '\u0001none';

	// -- every call reached so far, newest first ----------------------------------------------

	let held: CallRow[] = $state([]);
	const known = new Set<string>();
	let counter = 0;
	let older = $state(false);
	let reachedEnd = $state(false);
	let canOlder = $state(true);

	/** Merges a page in; a call already held is kept, with its key. */
	function merge(page: McpCallRecord[]): void {
		const occurrences = new Map<string, number>();
		const added: CallRow[] = [];

		for (const record of page) {
			const base = `${record.t}|${record.tool}|${record.durationMs}|${record.ok}|${record.args ?? ''}`;
			const nth = (occurrences.get(base) ?? 0) + 1;
			const signature = `${base}#${nth}`;

			occurrences.set(base, nth);

			if (known.has(signature)) {
				continue;
			}

			known.add(signature);
			added.push({ ...record, key: `c${counter++}` });
		}

		if (added.length > 0) {
			held = [...held, ...added].sort((a, b) => b.t - a.t);
		}
	}

	$effect(() => {
		const page = records;

		untrack(() => merge(page));
	});

	const more = $derived(canOlder && !reachedEnd && (truncated || older));

	// -- the range the chart and the table cover ----------------------------------------------

	/** Pages read by themselves for one range before the pager takes over, 500 calls each */
	const AUTO_PAGES = 10;

	let range = $state<TimeRange>(DEFAULT_RANGE);
	let autoPages = 0;

	const span = $derived(resolveRange(range, lastUpdated ?? Date.now()));

	/** Whether the range reaches back past the oldest call held, with more to read there. */
	const needsOlder = $derived(more && held.length > 0 && span.from < held.at(-1)!.t);

	function setRange(next: TimeRange): void {
		range = next;
		autoPages = 0;
	}

	// a range reaching past what is held reads further back by itself, a few pages at most
	$effect(() => {
		if (needsOlder && !older && autoPages < AUTO_PAGES) {
			untrack(() => {
				autoPages++;
				void loadOlder();
			});
		}
	});

	/** Paging onto the last page reads further back when the range still reaches past what is held. */
	function pageChanged(at: number, pages: number): void {
		if (at > 1 && at >= pages && needsOlder && !older) {
			void loadOlder();
		}
	}

	async function loadOlder(): Promise<void> {
		const oldest = held.at(-1);

		if (!oldest) {
			return;
		}

		older = true;

		try {
			const ask = new URLSearchParams({ token, until: String(oldest.t + 1), limit: String(PAGE) });
			const answer = await api<McpCallPage>(`/mcp-calls?${ask}`);
			const before = held.length;

			merge(answer.calls);

			if (!answer.truncated || held.length === before) {
				reachedEnd = true;
			}
		} catch (err) {
			const status = (err as { status?: number }).status;

			if (status === 401 || status === 403) {
				canOlder = false;
			} else {
				Notify.error(t('web.mcp.callsOlderFailed'), { detail: (err as Error).message });
			}
		} finally {
			older = false;
		}
	}

	// -- the stretch picked on the chart, then the filters -------------------------------------

	let outcome = $state<'' | CallOutcome>('');
	let tool = $state('');
	let group = $state<'' | McpToolGroup>('');
	let minMs = $state('');
	let caller = $state('');
	let changesOnly = $state(false);
	let shellOnly = $state(false);
	let search = $state('');

	const windowed = $derived(held.filter((call) => call.t >= span.from && call.t < span.to));

	function passes(call: CallRow, skip: Partial<Record<'outcome' | 'minMs' | 'caller' | 'changes' | 'shell', boolean>> = {}): boolean {
		if (!skip.outcome && outcome && callOutcome(call) !== outcome) {
			return false;
		}

		if (tool && call.tool !== tool) {
			return false;
		}

		if (group && callGroup(call) !== group) {
			return false;
		}

		if (!skip.minMs && minMs && call.durationMs < Number(minMs)) {
			return false;
		}

		if (!skip.caller && caller) {
			const who = callCaller(call);

			if (caller === SOME ? !who : caller === NONE ? !!who : who !== caller) {
				return false;
			}
		}

		if (!skip.changes && changesOnly && !callChangesState(call)) {
			return false;
		}

		if (!skip.shell && shellOnly) {
			const own = callGroup(call);

			if (!own || !CALL_SHELL_GROUPS.includes(own)) {
				return false;
			}
		}

		return true;
	}

	const narrowed = $derived(windowed.filter((call) => passes(call)));
	const filtered = $derived(!!(outcome || tool || group || minMs || caller || changesOnly || shellOnly || search.trim()));

	/** What the search box and the filters leave, from the table; the chart and the count read it. */
	let shown: CallRow[] = $state([]);

	function clearFilters(): void {
		outcome = '';
		tool = '';
		group = '';
		minMs = '';
		caller = '';
		changesOnly = false;
		shellOnly = false;
		search = '';
	}

	// -- presets ------------------------------------------------------------------------------

	interface Preset {
		id: string;
		label: string;
		active: boolean;
		toggle: () => void;
	}

	const presets = $derived<Preset[]>([
		{
			id: 'failed',
			label: t('web.mcp.presetFailed'),
			active: outcome === 'failed',
			toggle: () => (outcome = outcome === 'failed' ? '' : 'failed')
		},
		{
			id: 'refused',
			label: t('web.mcp.presetRefused'),
			active: outcome === 'refused',
			toggle: () => (outcome = outcome === 'refused' ? '' : 'refused')
		},
		{
			id: 'slow',
			label: t('web.mcp.presetSlow'),
			active: minMs === String(SLOW_MS),
			toggle: () => (minMs = minMs === String(SLOW_MS) ? '' : String(SLOW_MS))
		},
		{
			id: 'changes',
			label: t('web.mcp.presetChanges'),
			active: changesOnly,
			toggle: () => (changesOnly = !changesOnly)
		},
		{
			id: 'shell',
			label: t('web.mcp.presetShell'),
			active: shellOnly,
			toggle: () => (shellOnly = !shellOnly)
		},
		{
			id: 'behalf',
			label: t('web.mcp.presetBehalf'),
			active: caller === SOME,
			toggle: () => (caller = caller === SOME ? '' : SOME)
		}
	]);

	// -- the toolbar's choices, from what is held ---------------------------------------------

	function tally<K>(keyOf: (call: CallRow) => K | null): Array<[K, number]> {
		const counts = new Map<K, number>();

		for (const call of held) {
			const key = keyOf(call);

			if (key !== null && key !== '') {
				counts.set(key, (counts.get(key) ?? 0) + 1);
			}
		}

		return [...counts].sort((a, b) => b[1] - a[1]);
	}

	const outcomeOptions = $derived([
		{ value: '', label: t('web.mcp.anyOutcome') },
		{ value: 'ok', label: t('web.mcp.outcomeOk') },
		{ value: 'refused', label: t('web.mcp.outcomeRefused') },
		{ value: 'failed', label: t('web.mcp.outcomeFailed') }
	]);

	const toolOptions = $derived([
		{ value: '', label: t('web.mcp.anyTool') },
		...tally((call) => call.tool).map(([name, count]) => ({ value: name, label: `${name} (${fmtValue(count, 'count')})` }))
	]);

	const groupOptions = $derived([
		{ value: '', label: t('web.mcp.anyGroup') },
		...tally(callGroup).map(([name, count]) => ({ value: name, label: `${t(`web.mcp.group.${name}`)} (${fmtValue(count, 'count')})` }))
	]);

	const durationOptions = $derived([
		{ value: '', label: t('web.mcp.durationAny') },
		...['500', '1000', '5000', '30000'].map((value) => ({ value, label: t('web.mcp.durationOver', { value: fmtValue(Number(value), 'ms') }) }))
	]);

	const callers = $derived(tally(callCaller));

	const callerOptions = $derived([
		{ value: '', label: t('web.mcp.anyCaller') },
		{ value: SOME, label: t('web.mcp.callerSomebody') },
		{ value: NONE, label: t('web.mcp.callerNobody') },
		...callers.map(([name, count]) => ({ value: name, label: `${name} (${fmtValue(count, 'count')})` }))
	]);

	// -- the chart ----------------------------------------------------------------------------

	const histogram = $derived(callSeries(shown, span.from, span.to));
	const barStyles = $derived(callStyles());

	/** A bar was clicked: its stretch, and its outcome when one part was under the pointer. */
	function openBar(from: number, to: number, key: string | null): void {
		setRange({ kind: 'fixed', from, to });

		if (key === 'ok' || key === 'refused' || key === 'failed') {
			outcome = key;
		}
	}

	// -- the table ----------------------------------------------------------------------------

	const columns: Column[] = $derived([
		{ id: 'when', label: t('web.mcp.colWhen'), sortable: true, width: 180 },
		{ id: 'outcome', label: t('web.mcp.colOutcome'), sortable: true, width: 120 },
		{ id: 'tool', label: t('web.mcp.colTool'), sortable: true, width: 170 },
		{ id: 'instance', label: t('web.mcp.colInstance'), sortable: true, width: 150 },
		{ id: 'behalf', label: t('web.mcp.colOnBehalfOf'), sortable: true, width: 180 },
		{ id: 'duration', label: t('web.mcp.colDuration'), sortable: true, width: 100, align: 'right' },
		{ id: 'args', label: t('web.mcp.colArgs') },
		{ id: 'group', label: t('web.mcp.colGroup'), sortable: true, width: 150, hidden: true },
		{ id: 'account', label: t('web.mcp.colAccount'), sortable: true, width: 150, hidden: true },
		{ id: 'client', label: t('web.mcp.colClient'), sortable: true, width: 160, hidden: true },
		{ id: 'ip', label: t('web.mcp.colAddress'), sortable: true, width: 140, hidden: true }
	]);

	function sortValue(row: CallRow, column: string): string | number | null {
		switch (column) {
			case 'when':
				return row.t;
			case 'outcome':
				return callOutcome(row);
			case 'tool':
				return row.tool;
			case 'instance':
				return callInstance(row) ?? '';
			case 'behalf':
				return behalfLabel(row);
			case 'duration':
				return row.durationMs;
			case 'group':
				return callGroup(row) ?? '';
			case 'account':
				return callAccount(row) ?? '';
			case 'client':
				return row.client ?? '';
			case 'ip':
				return row.ip ?? '';
			default:
				return null;
		}
	}

	function searchText(row: CallRow): string {
		return [row.tool, row.args, row.error, behalfLabel(row), callAccount(row), row.client, row.ip].filter(Boolean).join(' ');
	}

	function durationTone(ms: number): string {
		if (ms >= 5000) {
			return 'critical';
		}

		return ms >= SLOW_MS
			? 'warning'
			: '';
	}

	async function copy(text: string): Promise<void> {
		if (await copyText(text)) {
			Notify.success(t('web.common.copied'));
		}
	}

	function rowActions(row: CallRow): ContextMenuItem[] {
		const who = callCaller(row);

		return menuGroups(
			[
				{ label: t('web.mcp.copyArgs'), icon: 'copy', disabled: !row.args, action: () => copy(row.args ?? '') },
				{ label: t('web.mcp.copyError'), icon: 'copy', disabled: !row.error, action: () => copy(row.error ?? '') }
			],
			[
				{ label: t('web.mcp.sameTool'), icon: 'filter', action: () => {
					tool = row.tool;
				} },
				...(who
					? [{ label: t('web.mcp.sameCaller'), icon: 'user', action: () => {
						caller = who;
					} }]
					: [])
			]
		);
	}

	// -- the selected call --------------------------------------------------------------------

	let selected = $state(new Set<string>());

	const one = $derived(held.find((row) => selected.has(row.key)) ?? null);

	$effect(() => {
		// the split panel covers the bottom of the page; bring the chosen row up above it
		if (one) {
			requestAnimationFrame(() => {
				const element = document.querySelector<HTMLElement>('tr.selected');
				const panel = document.querySelector<HTMLElement>('aside.dp');
				const limit = panel?.getBoundingClientRect().top ?? window.innerHeight * 0.6;

				if (element && element.getBoundingClientRect().bottom > limit - 8) {
					element.scrollIntoView({ block: 'center', behavior: 'smooth' });
				}
			});
		}
	});

	const oneBadge = $derived(one ? callBadge(one) : null);
	const oneInstance = $derived(one ? callInstance(one) : null);
	const oneGroup = $derived(one ? callGroup(one) : null);
	const oneAccount = $derived(one ? callAccount(one) : undefined);

	const oneCells = $derived<InfoCell[]>(
		one
			? [
					{ id: 'outcome', label: t('web.mcp.colOutcome') },
					{ label: t('web.mcp.colDuration'), value: fmtValue(one.durationMs, 'ms') },
					{ label: t('web.mcp.colWhen'), value: fmtDateTime(one.t), time: one.t },
					{ label: t('web.mcp.colTool'), value: one.tool, copyable: true, style: 'mono' },
					{
						label: t('web.mcp.colGroup'),
						value: oneGroup
							? `${t(`web.mcp.group.${oneGroup}`)}${callChangesState(one) ? ` · ${t('web.mcp.destructive')}` : ''}`
							: '–'
					},
					{
						label: t('web.mcp.colInstance'),
						value: oneInstance ?? '–',
						...(oneInstance && callInstanceHref(oneInstance) ? { href: callInstanceHref(oneInstance)! } : {})
					},
					{
						label: t('web.mcp.colAccount'),
						value: oneAccount ?? '–',
						...(oneAccount ? { href: accountHref(oneAccount) } : {})
					},
					{ label: t('web.mcp.colClient'), value: one.client ?? '–' },
					{ label: t('web.mcp.colAddress'), value: one.ip ?? '–', copyable: !!one.ip, style: 'mono' }
				]
			: []
	);

	const oneBehalf = $derived<InfoCell[]>(
		one?.onBehalfOf
			? Object.entries(one.onBehalfOf).map(([key, value]) => ({ label: key, value: typeof value === 'string' ? value : JSON.stringify(value) }))
			: []
	);

	const oneArgs = $derived(one?.args ? prettyArgs(one.args) : '');
	const oneArgsCut = $derived(!!one?.args && one.args.endsWith('… [truncated]'));
	const oneArgsRedacted = $derived(!!one?.args && one.args.includes('"[redacted]"'));

	// a call whose arguments are not whole JSON still counts as having them
	const oneArgsParsed = $derived(one ? callArgs(one) !== null : false);
</script>

<Panel
	title={t('web.mcpDetail.tabCalls')}
	count={fmtValue(shown.length, 'count') + (!filtered && needsOlder ? '+' : '')}
	flush
>
	<div class="head">
		<div class="presets">
			<span class="dim">{t('web.mcp.presets')}</span>
			<div class="chips">
				<ButtonGroup>
					{#each presets as preset (preset.id)}
						<Btn pressed={preset.active} onclick={preset.toggle}>{preset.label}</Btn>
					{/each}
				</ButtonGroup>
			</div>
			{#if tool}
				<span class="chip">
					<span class="dim">{t('web.mcp.colTool')}</span>
					<span class="mono">{tool}</span>
					<Btn variant="icon" icon="close" title={t('web.mcp.clearTool')} onclick={() => (tool = '')} />
				</span>
			{/if}
			<div class="range">
				<TimeRangePicker value={range} onchange={setRange} />
			</div>
		</div>
		<StackedBars
			series={histogram}
			label={t('web.mcp.callsHistogram')}
			styles={barStyles}
			from={span.from}
			to={span.to}
			barHint={t('web.mcp.openCalls')}
			compact
			onzoom={(from, to) => setRange({ kind: 'fixed', from, to })}
			onbar={openBar}
		/>
	</div>

	<ResourceTable
		{tableId}
		{columns}
		rows={narrowed}
		getId={(row) => row.key}
		bind:search
		bind:filteredRows={shown}
		searchValue={searchText}
		searchPlaceholder={t('web.mcp.searchCalls')}
		searchWidth="31rem"
		selectable="single"
		bind:selected
		{sortValue}
		defaultSort={{ col: 'when', dir: 'desc' }}
		loading={loading || older}
		onpagechange={pageChanged}
		{rowActions}
		rowLabel={(row) => row.tool}
		noun={t('web.mcp.callNoun')}
		emptyTitle={held.length > 0 ? t('web.mcp.noCallsMatch') : t('web.mcp.noCallsTitle')}
		{emptyText}
	>
		{#snippet emptyAction()}
			{#if filtered}
				<Btn icon="close" onclick={clearFilters}>{t('web.mcp.clearFilters')}</Btn>
			{/if}
		{/snippet}
		{#snippet toolbar()}
			<Select ariaLabel={t('web.mcp.colOutcome')} value={outcome} options={outcomeOptions} width="11rem" onchange={(value) => (outcome = value as '' | CallOutcome)} />
			<Select ariaLabel={t('web.mcp.colTool')} value={tool} options={toolOptions} width="14rem" onchange={(value) => (tool = value)} />
			<Select ariaLabel={t('web.mcp.colGroup')} value={group} options={groupOptions} width="13rem" onchange={(value) => (group = value as '' | McpToolGroup)} />
			<Select ariaLabel={t('web.mcp.colDuration')} value={minMs} options={durationOptions} width="11rem" onchange={(value) => (minMs = value)} />
			{#if callers.length > 0}
				<Select ariaLabel={t('web.mcp.colOnBehalfOf')} value={caller} options={callerOptions} width="13rem" onchange={(value) => (caller = value)} />
			{/if}
			{#if filtered}
				<Btn icon="close" onclick={clearFilters}>{t('web.mcp.clearFilters')}</Btn>
			{/if}
		{/snippet}
		{#snippet cell(row, col)}
			{#if col === 'when'}
				<span class="dim"><DateTime at={row.t} text={fmtDateTime(row.t)} /></span>
			{:else if col === 'outcome'}
				{@const badge = callBadge(row)}
				<StatusBadge state={badge.state} label={badge.label} detail={row.error} />
			{:else if col === 'tool'}
				<span class="mono">{row.tool}</span>
			{:else if col === 'instance'}
				{@const name = callInstance(row)}
				{@const href = name ? callInstanceHref(name) : null}
				{#if name && href}
					<a href={href}>{name}</a>
				{:else}
					<span class="dim">{name ?? '–'}</span>
				{/if}
			{:else if col === 'behalf'}
				<span class:dim={!row.onBehalfOf}>{behalfLabel(row) || '–'}</span>
			{:else if col === 'duration'}
				<span class="mono {durationTone(row.durationMs)}">{fmtValue(row.durationMs, 'ms')}</span>
			{:else if col === 'args'}
				<span class="mono dim args">{row.args ?? '–'}</span>
			{:else if col === 'group'}
				{@const own = callGroup(row)}
				<span class:dim={!own}>{own ? t(`web.mcp.group.${own}`) : '–'}</span>
			{:else if col === 'account'}
				{@const account = callAccount(row)}
				{#if account}
					<a href={accountHref(account)}>{account}</a>
				{:else}
					<span class="dim">–</span>
				{/if}
			{:else if col === 'client'}
				<span class:dim={!row.client}>{row.client ?? '–'}</span>
			{:else if col === 'ip'}
				<span class="mono dim">{row.ip ?? '–'}</span>
			{/if}
		{/snippet}
	</ResourceTable>

</Panel>

{#if one && oneBadge}
	<DetailPanel title={one.tool} subtitle={oneBadge.label} onclose={() => (selected = new Set())}>
		{#snippet actions()}
			<Btn icon="copy" disabled={!one.args} onclick={() => void copy(one.args ?? '')}>{t('web.mcp.copyArgs')}</Btn>
		{/snippet}
		<div class="detail">
			<InfoGrid cells={oneCells}>
				{#snippet custom(cell)}
					{#if cell.id === 'outcome'}
						<StatusBadge state={oneBadge.state} label={oneBadge.label} />
					{/if}
				{/snippet}
			</InfoGrid>
			{#if one.error}
				<Flash kind={callOutcome(one) === 'refused' ? 'warning' : 'error'}>{one.error}</Flash>
			{/if}
			{#if oneBehalf.length > 0}
				<section>
					<h4>{t('web.mcp.colOnBehalfOf')}</h4>
					<p class="dim note">{t('web.mcp.behalfUnverified')}</p>
					<InfoGrid cells={oneBehalf} />
				</section>
			{/if}
			<section>
				<h4>{t('web.mcp.colArgs')}</h4>
				{#if oneArgsCut}
					<p class="dim note">{t('web.mcp.argsTruncated')}</p>
				{/if}
				{#if oneArgsRedacted}
					<p class="dim note">{t('web.mcp.argsRedacted')}</p>
				{/if}
				{#if oneArgs}
					<pre class="mono argsfull" class:raw={!oneArgsParsed}>{oneArgs}</pre>
				{:else}
					<p class="dim">–</p>
				{/if}
			</section>
		</div>
	</DetailPanel>
{/if}

<style lang="scss">
	.head {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1rem 1.25rem 0.5rem;
	}

	.presets {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 0.75rem;
		font-size: 0.875rem;
	}

	// the presets scroll inside their own strip on a narrow screen
	.chips {
		max-width: 100%;
		overflow-x: auto;
	}

	.range {
		margin-left: auto;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0 0 0 0.625rem;
		border: 0.1rem solid var(--border-divider);
		border-radius: 1rem;
		font-size: 0.8125rem;
	}

	.args {
		@include ellipsis;

		display: block;
		font-size: 0.75rem;
	}

	.warning {
		color: var(--warning);
	}

	.critical {
		color: var(--error);
	}

	.detail {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;

		section {
			display: flex;
			flex-direction: column;
			gap: 0.5rem;
		}

		h4 {
			margin: 0;
			font-size: 0.875rem;
		}

		.note {
			margin: 0;
			font-size: 0.8125rem;
		}
	}

	.argsfull {
		margin: 0;
		padding: 0.75rem 1rem;
		max-height: 24rem;
		overflow: auto;
		font-size: 0.75rem;
		white-space: pre-wrap;
		word-break: break-word;
		background: var(--bg-sunken, var(--bg-secondary));
		border: 0.1rem solid var(--border-divider);
		border-radius: 0.5rem;

		&.raw {
			color: var(--text-secondary);
		}
	}
</style>
