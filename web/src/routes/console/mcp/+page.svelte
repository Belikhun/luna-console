<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, del, patch, post } from '$lib/api';
	import { copyText } from '$lib/clipboard';
	import { fmtDateTime } from '$lib/format';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Tabs from '$lib/components/Tabs.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import OverviewBar from '$lib/components/OverviewBar.svelte';
	import OverviewCell from '$lib/components/OverviewCell.svelte';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { Notify } from '$lib/notifications.svelte';
	import {
		behalfLabel,
		clientSnippet,
		keyCalls,
		keyMcpAudit,
		mcpAuditTone,
		scopeSummary,
		tokenState,
		tokenStateLabel,
		type CallRow,
		type McpAuditRow,
		type TokenRow
	} from './mcp';

	/**
	 * MCP access: the tokens programs use to reach this console over MCP, every
	 * call they made, and what was done to the tokens. One subject read three ways,
	 * like the Accounts screen, so three tabs rather than three screens.
	 */

	let tokens: TokenRow[] = $state([]);
	let calls: CallRow[] = $state([]);
	let callsTruncated = $state(false);
	let audit: McpAuditRow[] = $state([]);

	let loading = $state(false);
	let loaded = $state(false);
	let lastUpdated: number | null = $state(null);
	let tab = $state(page.url.searchParams.get('tab') ?? 'tokens');
	let selected: Set<string> = $state(new Set());

	let deleteOpen = $state(false);
	let deleteRows: TokenRow[] = $state([]);

	let rotateOpen = $state(false);
	let rotateRow: TokenRow | null = $state(null);
	let rotatedBearer = $state('');
	let copied = $state(false);
	let busy = $state(false);

	const DAY_MS = 24 * 60 * 60 * 1000;

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const [data, callPage] = await Promise.all([api('/mcp-tokens'), api('/mcp-calls?limit=1000')]);

			tokens = data.tokens;
			audit = keyMcpAudit(data.audit);
			calls = keyCalls(callPage.calls);
			callsTruncated = callPage.truncated;
			lastUpdated = Date.now();
		} catch (err) {
			Notify.error(t('web.mcp.loadFailed'), { detail: (err as Error).message });
		} finally {
			loading = false;
			loaded = true;
		}
	}

	onMount(() => {
		void refresh();
	});

	function detailHref(row: TokenRow): string {
		return `/console/mcp/${row.id}`;
	}

	const picked = $derived(tokens.filter((row) => selected.has(row.id)));

	const counts = $derived.by(() => {
		const since = Date.now() - DAY_MS;
		const recent = calls.filter((call) => call.t >= since);

		return {
			enabled: tokens.filter((row) => row.enabled && !row.expired).length,
			calls24h: recent.length,
			failures24h: recent.filter((call) => !call.ok).length
		};
	});

	async function runBulk(rows: TokenRow[], verb: string, run: (row: TokenRow) => Promise<unknown>): Promise<void> {
		if (rows.length === 0) {
			return;
		}

		const failed: string[] = [];

		for (const row of rows) {
			try {
				await run(row);
			} catch (err) {
				failed.push(`${row.name}: ${(err as Error).message}`);
			}
		}

		const done = rows.length - failed.length;

		if (failed.length === 0) {
			Notify.success(t('web.mcp.bulkDone', { verb, count: done }));
		} else if (done === 0) {
			Notify.error(t('web.mcp.bulkFailed', { verb }), { detail: failed.join('\n') });
		} else {
			Notify.warning(t('web.mcp.bulkPartial', { verb, done, failed: failed.length }), {
				detail: failed.join('\n')
			});
		}

		await refresh();
	}

	async function setEnabled(rows: TokenRow[], enabled: boolean): Promise<void> {
		const verb = enabled
			? t('web.mcp.verbEnable')
			: t('web.mcp.verbDisable');

		await runBulk(rows, verb, (row) => patch(`/mcp-tokens/${row.id}`, { enabled }));
	}

	function remove(rows: TokenRow[]): void {
		if (rows.length === 0) {
			return;
		}

		deleteRows = rows;
		deleteOpen = true;
	}

	async function removeConfirmed(): Promise<void> {
		await runBulk(deleteRows, t('web.mcp.verbDelete'), (row) => del(`/mcp-tokens/${row.id}`));
	}

	function rotate(row: TokenRow): void {
		rotateRow = row;
		rotatedBearer = '';
		copied = false;
		rotateOpen = true;
	}

	async function rotateConfirmed(): Promise<void> {
		if (!rotateRow) {
			return;
		}

		busy = true;

		try {
			const result = await post(`/mcp-tokens/${rotateRow.id}/rotate`);

			rotatedBearer = result.bearer;
			await refresh();
		} catch (err) {
			Notify.error(t('web.mcp.rotateFailed'), { detail: (err as Error).message });
			rotateOpen = false;
		} finally {
			busy = false;
		}
	}

	async function copyBearer(): Promise<void> {
		copied = await copyText(clientSnippet(page.url.origin, rotatedBearer));
	}

	function tokenActions(rows: TokenRow[]): ContextMenuItem[] {
		const one = rows.length === 1 ? rows[0] : undefined;
		const toEnable = rows.filter((row) => !row.enabled);
		const toDisable = rows.filter((row) => row.enabled);

		return [
			{
				label: t('web.mcp.openToken'),
				icon: 'circleInfo',
				disabled: !one,
				hint: one ? undefined : t('web.mcp.pickOne'),
				action: () => goto(detailHref(one!))
			},
			{
				label: t('web.mcp.viewCalls'),
				icon: 'list',
				disabled: !one,
				hint: one ? undefined : t('web.mcp.pickOne'),
				action: () => goto(`${detailHref(one!)}?tab=calls`)
			},
			{ separator: true },
			{
				label: t('web.mcp.enableAction', { count: toEnable.length }),
				icon: 'circleCheck',
				disabled: toEnable.length === 0,
				hint: toEnable.length ? undefined : t('web.mcp.allEnabled'),
				action: () => setEnabled(toEnable, true)
			},
			{
				label: t('web.mcp.disableAction', { count: toDisable.length }),
				icon: 'ban',
				color: 'warning',
				disabled: toDisable.length === 0,
				hint: toDisable.length ? undefined : t('web.mcp.allDisabled'),
				action: () => setEnabled(toDisable, false)
			},
			{
				label: t('web.mcp.rotateAction'),
				icon: 'rotate',
				color: 'warning',
				disabled: !one,
				hint: one ? undefined : t('web.mcp.pickOne'),
				action: () => rotate(one!)
			},
			{ separator: true },
			{
				label: t('web.mcp.deleteAction', { count: rows.length }),
				icon: 'trash',
				color: 'danger',
				disabled: rows.length === 0,
				action: () => remove(rows)
			}
		];
	}

	function rowActions(row: TokenRow): ContextMenuItem[] {
		return tokenActions(selected.has(row.id) && picked.length > 1 ? picked : [row]);
	}

	function callActions(row: CallRow): ContextMenuItem[] {
		return [
			{
				label: t('web.mcp.openToken'),
				icon: 'circleInfo',
				action: () => goto(`/console/mcp/${row.token}`)
			},
			{
				label: t('web.mcp.copyArgs'),
				icon: 'copy',
				disabled: !row.args,
				action: async () => {
					await copyText(row.args ?? '');
				}
			}
		];
	}

	const headerDisabled = $derived(tab !== 'tokens' || picked.length === 0);

	const tokenColumns: Column[] = $derived([
		{ id: 'name', label: t('web.mcp.colName'), sortable: true, width: 200 },
		{ id: 'state', label: t('web.common.state'), sortable: true, width: 130 },
		{ id: 'scope', label: t('web.mcp.colScope'), width: 260 },
		{ id: 'tools', label: t('web.mcp.colTools'), sortable: true, width: 100 },
		{ id: 'instances', label: t('web.mcp.colInstances'), width: 160 },
		{ id: 'calls', label: t('web.mcp.colCalls'), sortable: true, width: 110 },
		{ id: 'lastUsed', label: t('web.mcp.colLastUsed'), sortable: true, width: 180 },
		{ id: 'expires', label: t('web.mcp.colExpires'), sortable: true, width: 180, hidden: true },
		{ id: 'created', label: t('web.mcp.colCreated'), sortable: true, width: 180, hidden: true }
	]);

	const tokenFilters: TableFilterGroup<TokenRow>[] = $derived([
		{
			id: 'state',
			label: t('web.mcp.filterState'),
			options: [
				{ value: 'any', label: t('web.mcp.anyState') },
				{ value: 'active', label: t('web.mcp.active'), match: (row) => row.enabled && !row.expired },
				{ value: 'disabled', label: t('web.mcp.disabled'), match: (row) => !row.enabled },
				{ value: 'expired', label: t('web.mcp.expired'), match: (row) => row.expired }
			]
		}
	]);

	const callColumns: Column[] = $derived([
		{ id: 'when', label: t('web.mcp.colWhen'), sortable: true, width: 180 },
		{ id: 'outcome', label: t('web.mcp.colOutcome'), sortable: true, width: 120 },
		{ id: 'tool', label: t('web.mcp.colTool'), sortable: true, width: 170 },
		{ id: 'token', label: t('web.mcp.colToken'), sortable: true, width: 150 },
		{ id: 'behalf', label: t('web.mcp.colOnBehalfOf'), sortable: true, width: 180 },
		{ id: 'duration', label: t('web.mcp.colDuration'), sortable: true, width: 110 },
		{ id: 'args', label: t('web.mcp.colArgs') },
		{ id: 'ip', label: t('web.mcp.colAddress'), sortable: true, width: 140, hidden: true },
		{ id: 'client', label: t('web.mcp.colClient'), width: 180, hidden: true }
	]);

	const callFilters: TableFilterGroup<CallRow>[] = $derived([
		{
			id: 'outcome',
			label: t('web.mcp.filterOutcome'),
			options: [
				{ value: 'any', label: t('web.mcp.anyOutcome') },
				{ value: 'ok', label: t('web.mcp.outcomeOk'), match: (row) => row.ok },
				{ value: 'failed', label: t('web.mcp.outcomeFailed'), match: (row) => !row.ok }
			]
		},
		{
			id: 'token',
			label: t('web.mcp.filterToken'),
			options: [
				{ value: 'any', label: t('web.mcp.anyToken') },
				...tokens.map((token) => ({
					value: token.id,
					label: token.name,
					match: (row: CallRow) => row.token === token.id
				}))
			]
		}
	]);

	const auditColumns: Column[] = $derived([
		{ id: 'when', label: t('web.mcp.colWhen'), sortable: true, width: 180 },
		{ id: 'action', label: t('web.mcp.colAction'), sortable: true, width: 170 },
		{ id: 'actor', label: t('web.mcp.colActor'), sortable: true, width: 170 },
		{ id: 'detail', label: t('web.mcp.colDetail') }
	]);

	const auditFilters: TableFilterGroup<McpAuditRow>[] = $derived([
		{
			id: 'kind',
			label: t('web.mcp.filterActivity'),
			options: [
				{ value: 'any', label: t('web.mcp.anyActivity') },
				{ value: 'tokens', label: t('web.mcp.tokenActivity'), match: (row) => row.action.startsWith('token.') },
				{
					value: 'knowledge',
					label: t('web.mcp.knowledgeActivity'),
					match: (row) => row.action.startsWith('knowledge.')
				},
				{
					value: 'mcp',
					label: t('web.mcp.byMcpActivity'),
					match: (row) => (row.actor ?? '').startsWith('mcp:')
				}
			]
		}
	]);

	function tokenName(id: string): string {
		return tokens.find((token) => token.id === id)?.name ?? id;
	}
</script>

<svelte:head><title>{t('web.nav.mcp')} | Luna Console</title></svelte:head>

<PageHeader title={t('web.nav.mcp')} count={tokens.length} description={t('web.mcp.pageDescription')} info>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="console-mcp" />
		<Dropdown label={t('web.common.actions')} disabled={headerDisabled} menu={tokenActions(picked)} />
		<Btn icon="book" href="/console/knowledge">{t('web.mcp.knowledge')}</Btn>
		<Btn variant="primary" icon="plus" href="/console/mcp/new">{t('web.mcp.createToken')}</Btn>
	{/snippet}
</PageHeader>

<OverviewBar title={t('web.mcp.overview')}>
	<OverviewCell label={t('web.mcp.overviewTokens')}>
		{tokens.length}
		<span class="dim">({counts.enabled} {t('web.mcp.active')})</span>
	</OverviewCell>
	<OverviewCell label={t('web.mcp.overviewCalls')}>{counts.calls24h}</OverviewCell>
	<OverviewCell label={t('web.mcp.overviewFailures')}>{counts.failures24h}</OverviewCell>
	<OverviewCell label={t('web.mcp.overviewEndpoint')}>
		<span class="mono">{page.url.origin}/api/mcp</span>
	</OverviewCell>
</OverviewBar>

<Tabs
	tabs={[
		{ id: 'tokens', label: t('web.mcp.tabTokens') },
		{ id: 'calls', label: t('web.mcp.tabCalls') },
		{ id: 'activity', label: t('web.mcp.tabActivity') }
	]}
	bind:active={tab}
/>

<div class="tabbody">
	{#if tab === 'tokens'}
		<Panel flush>
			<ResourceTable
				tableId="console-mcp-tokens"
				loading={!loaded}
				initialSearch={page.url.searchParams.get('q') ?? ''}
				columns={tokenColumns}
				filters={tokenFilters}
				rows={tokens}
				getId={(row) => row.id}
				searchValue={(row) => `${row.name} ${row.description} ${row.tools.join(' ')}`}
				searchPlaceholder={t('web.mcp.searchTokens')}
				selectable="multi"
				bind:selected
				{rowActions}
				rowLabel={(row) => row.name}
				rowDim={(row) => !row.enabled || row.expired}
				noun={t('web.mcp.tokenNoun')}
				onRowClick={(row) => goto(detailHref(row))}
				sortValue={(row, col) =>
					col === 'state'
						? tokenState(row)
						: col === 'tools'
							? row.tools.length
							: col === 'calls'
								? row.stats.calls
								: col === 'lastUsed'
									? (row.lastUsedAt ?? 0)
									: col === 'expires'
										? (row.expiresAt ?? Number.MAX_SAFE_INTEGER)
										: null}
				emptyTitle={t('web.mcp.emptyTitle')}
				emptyText={t('web.mcp.emptyText')}
			>
				{#snippet cell(row, col)}
					{#if col === 'name'}
						<a href={detailHref(row)}><b>{row.name}</b></a>
					{:else if col === 'state'}
						<StatusBadge state={tokenState(row)} label={tokenStateLabel(row)} />
					{:else if col === 'scope'}
						<span>{scopeSummary(row)}</span>
					{:else if col === 'tools'}
						<span class="mono">{row.tools.length}</span>
					{:else if col === 'instances'}
						{#if row.scope.instances === null}
							<span class="dim">{t('web.mcp.everyInstance')}</span>
						{:else}
							<span>{row.scope.instances.join(', ') || '–'}</span>
						{/if}
					{:else if col === 'calls'}
						<span class="mono">{row.stats.calls}</span>
						{#if row.stats.failures}
							<span class="dim">· {t('web.mcp.failuresShort', { count: row.stats.failures })}</span>
						{/if}
					{:else if col === 'lastUsed'}
						<span class:dim={!row.lastUsedAt}>
							{row.lastUsedAt ? fmtDateTime(row.lastUsedAt) : t('web.mcp.never')}
						</span>
					{:else if col === 'expires'}
						<span class:dim={!row.expiresAt}>
							{row.expiresAt ? fmtDateTime(row.expiresAt) : t('web.mcp.noExpiry')}
						</span>
					{:else if col === 'created'}
						<span class="dim">{fmtDateTime(row.createdAt)}</span>
					{/if}
				{/snippet}
			</ResourceTable>
		</Panel>
	{:else if tab === 'calls'}
		{#if callsTruncated}
			<Flash kind="info">{t('web.mcp.callsTruncated', { count: calls.length })}</Flash>
		{/if}
		<Panel flush>
			<ResourceTable
				tableId="console-mcp-calls"
				loading={!loaded}
				columns={callColumns}
				filters={callFilters}
				rows={calls}
				getId={(row) => row.key}
				searchValue={(row) =>
					`${row.tool} ${row.tokenName} ${row.args ?? ''} ${row.error ?? ''} ${behalfLabel(row)}`}
				searchPlaceholder={t('web.mcp.searchCalls')}
				rowActions={callActions}
				rowLabel={(row) => `${row.tool} · ${row.tokenName}`}
				noun={t('web.mcp.callNoun')}
				sortValue={(row, col) =>
					col === 'when'
						? row.t
						: col === 'duration'
							? row.durationMs
							: col === 'outcome'
								? (row.ok ? 1 : 0)
								: null}
				emptyTitle={t('web.mcp.noCallsTitle')}
				emptyText={t('web.mcp.noCallsText')}
			>
				{#snippet cell(row, col)}
					{#if col === 'when'}
						<span class="dim">{fmtDateTime(row.t)}</span>
					{:else if col === 'outcome'}
						<StatusBadge
							state={row.ok ? 'ok' : 'failed'}
							label={row.ok ? t('web.mcp.outcomeOk') : t('web.mcp.outcomeFailed')}
							detail={row.error}
						/>
					{:else if col === 'tool'}
						<span class="mono">{row.tool}</span>
					{:else if col === 'token'}
						<a href="/console/mcp/{row.token}">{tokenName(row.token)}</a>
					{:else if col === 'behalf'}
						<span class:dim={!row.onBehalfOf}>{behalfLabel(row) || '–'}</span>
					{:else if col === 'duration'}
						<span class="mono">{row.durationMs} ms</span>
					{:else if col === 'args'}
						<span class="mono dim args">{row.args ?? '–'}</span>
					{:else if col === 'ip'}
						<span class="mono dim">{row.ip ?? '–'}</span>
					{:else if col === 'client'}
						<span class="dim args">{row.client ?? '–'}</span>
					{/if}
				{/snippet}
			</ResourceTable>
		</Panel>
	{:else}
		<Panel flush>
			<ResourceTable
				tableId="console-mcp-audit"
				loading={!loaded}
				columns={auditColumns}
				filters={auditFilters}
				rows={audit}
				getId={(row) => row.key}
				searchValue={(row) => `${row.action} ${row.actor ?? ''} ${row.detail ?? ''}`}
				searchPlaceholder={t('web.mcp.searchActivity')}
				noun={t('web.mcp.activityNoun')}
				sortValue={(row, col) => (col === 'when' ? row.t : null)}
				emptyTitle={t('web.mcp.noActivityTitle')}
				emptyText={t('web.mcp.noActivityText')}
			>
				{#snippet cell(row, col)}
					{#if col === 'when'}
						<span class="dim">{fmtDateTime(row.t)}</span>
					{:else if col === 'action'}
						<StatusBadge state={mcpAuditTone(row.action)} label={row.action} />
					{:else if col === 'actor'}
						<span class:dim={!row.actor}>{row.actor ?? t('web.mcp.noActor')}</span>
					{:else if col === 'detail'}
						<span class="dim">{row.detail ?? '–'}</span>
					{/if}
				{/snippet}
			</ResourceTable>
		</Panel>
	{/if}
</div>

<ConfirmModal
	bind:open={deleteOpen}
	title={t('web.mcp.deleteTitle', { count: deleteRows.length })}
	lead={t('web.mcp.deleteLead', { names: deleteRows.map((row) => row.name).join(', ') })}
	notes={[t('web.mcp.deleteNote')]}
	confirmLabel={t('web.common.delete')}
	onconfirm={() => void removeConfirmed()}
/>

<Modal title={t('web.mcp.rotateTitle', { name: rotateRow?.name ?? '' })} bind:open={rotateOpen}>
	{#if rotatedBearer}
		<Flash kind="warning">{t('web.mcp.bearerOnceOnly')}</Flash>
		<div class="secret">
			<code class="mono">{rotatedBearer}</code>
		</div>
		<p class="modalnote dim">{t('web.mcp.snippetHint')}</p>
		<pre class="snippet mono">{clientSnippet(page.url.origin, rotatedBearer)}</pre>
	{:else}
		<p class="modalnote">{t('web.mcp.rotateLead')}</p>
	{/if}

	{#snippet footer()}
		{#if rotatedBearer}
			<Btn icon={copied ? 'circleCheck' : 'copy'} onclick={copyBearer}>
				{copied ? t('web.common.copied') : t('web.mcp.copySnippet')}
			</Btn>
			<Btn variant="primary" onclick={() => (rotateOpen = false)}>{t('web.common.done')}</Btn>
		{:else}
			<Btn onclick={() => (rotateOpen = false)}>{t('web.common.cancel')}</Btn>
			<Btn variant="primary" loading={busy} onclick={rotateConfirmed}>{t('web.mcp.rotateAction')}</Btn>
		{/if}
	{/snippet}
</Modal>

<style lang="scss">
	.tabbody {
		margin-top: 1rem;
	}

	.args {
		@include ellipsis;

		display: block;
		font-size: 0.75rem;
	}

	.modalnote {
		margin: 0.75rem 0;
		font-size: 0.8125rem;
	}

	// the one place a credential is on screen; same treatment as an access key's
	.secret code {
		display: block;
		overflow-wrap: anywhere;
		background: var(--bg-input);
		border: 0.1rem solid var(--border-input);
		border-radius: var(--radius-input);
		padding: 0.5rem 0.75rem;
		font-size: 0.8125rem;
	}

	.snippet {
		margin: 0;
		padding: 0.75rem;
		background: var(--bg-terminal);
		border: 0.1rem solid var(--border-divider);
		border-radius: var(--radius-input);
		font-size: 0.75rem;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
