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
	import Modal from '$lib/components/Modal.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import FormGrid from '$lib/components/FormGrid.svelte';
	import Select from '$lib/components/Select.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import McpScopeEditor from '$lib/components/McpScopeEditor.svelte';
	import type { InfoCell } from '$lib/components/grid';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { Notify } from '$lib/notifications.svelte';
	import { clearCrumbLabel, setCrumbLabel } from '$lib/crumbs.svelte';
	import { allowedTools, type McpScope } from '$shared/mcptools';
	import type { KnowledgeItem } from '$core/mcp';
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
	} from '../mcp';

	/**
	 * One MCP token: what it is, what it may do, every call it made, the knowledge
	 * only it can see, and what was done to it.
	 */

	const id = $derived(page.params.id ?? '');
	const DAY_MS = 24 * 60 * 60 * 1000;

	let token = $state<TokenRow | null>(null);
	let calls: CallRow[] = $state([]);
	let callsTruncated = $state(false);
	let knowledge: KnowledgeItem[] = $state([]);
	let audit: McpAuditRow[] = $state([]);
	let instances: string[] = $state([]);
	let missing = $state(false);
	let loading = $state(false);
	let lastUpdated: number | null = $state(null);
	let tab = $state(page.url.searchParams.get('tab') ?? 'details');

	/** The scope being edited; null until the token has loaded, then a working copy */
	let draft = $state<McpScope | null>(null);
	let savingScope = $state(false);

	let editOpen = $state(false);
	let editName = $state('');
	let editDescription = $state('');
	let editExpiry = $state('keep');

	let rotateOpen = $state(false);
	let rotatedBearer = $state('');
	let copied = $state(false);
	let deleteOpen = $state(false);
	let busy = $state(false);

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const data = await api(`/mcp-tokens/${encodeURIComponent(id)}`);

			token = data.token;
			calls = keyCalls(data.calls);
			callsTruncated = data.callsTruncated;
			knowledge = data.knowledge;
			audit = keyMcpAudit(data.audit);
			missing = false;
			lastUpdated = Date.now();

			if (!draft || !scopeDirty) {
				draft = structuredClone($state.snapshot(data.token.scope));
			}
		} catch (err) {
			if ((err as { status?: number }).status === 404) {
				missing = true;
			} else {
				Notify.error(t('web.mcp.loadFailed'), { detail: (err as Error).message });
			}
		} finally {
			loading = false;
		}
	}

	// the segment is the token id; the crumb reads the name everyone else uses
	$effect(() => {
		if (!token) {
			return;
		}

		const path = `/console/mcp/${id}`;

		setCrumbLabel(path, token.name);

		return () => clearCrumbLabel(path);
	});

	onMount(async () => {
		await refresh();

		try {
			const data = await api('/instances');

			instances = data.instances.map((row: { name: string }) => row.name);
		} catch {
			// the instance picker stays empty; everything else works
		}
	});

	const scopeDirty = $derived(
		!!token && !!draft && JSON.stringify(draft) !== JSON.stringify(token.scope)
	);

	async function saveScope(): Promise<void> {
		if (!token || !draft) {
			return;
		}

		savingScope = true;

		try {
			const result = await patch(`/mcp-tokens/${token.id}`, { scope: draft });

			token = result.token;
			draft = structuredClone($state.snapshot(result.token.scope));
			Notify.success(t('web.mcpDetail.scopeSaved', { count: result.token.tools.length }));
			await refresh();
		} catch (err) {
			Notify.error(t('web.mcpDetail.scopeFailed'), { detail: (err as Error).message });
		} finally {
			savingScope = false;
		}
	}

	function resetScope(): void {
		if (token) {
			draft = structuredClone($state.snapshot(token.scope));
		}
	}

	async function setEnabled(enabled: boolean): Promise<void> {
		if (!token) {
			return;
		}

		try {
			await patch(`/mcp-tokens/${token.id}`, { enabled });
			const message = enabled
				? t('web.mcpDetail.enabled', { name: token.name })
				: t('web.mcpDetail.disabled', { name: token.name });

			Notify.success(message);
			await refresh();
		} catch (err) {
			Notify.error(t('web.mcpDetail.updateFailed'), { detail: (err as Error).message });
		}
	}

	function openEdit(): void {
		if (!token) {
			return;
		}

		editName = token.name;
		editDescription = token.description;
		editExpiry = 'keep';
		editOpen = true;
	}

	async function saveEdit(): Promise<void> {
		if (!token) {
			return;
		}

		busy = true;

		const body: Record<string, unknown> = { name: editName, description: editDescription };

		if (editExpiry === 'never') {
			body.expiresAt = null;
		} else if (editExpiry !== 'keep') {
			body.expiresAt = Date.now() + Number(editExpiry) * DAY_MS;
		}

		try {
			await patch(`/mcp-tokens/${token.id}`, body);
			editOpen = false;
			await refresh();
		} catch (err) {
			Notify.error(t('web.mcpDetail.updateFailed'), { detail: (err as Error).message });
		} finally {
			busy = false;
		}
	}

	function openRotate(): void {
		rotatedBearer = '';
		copied = false;
		rotateOpen = true;
	}

	async function rotateConfirmed(): Promise<void> {
		if (!token) {
			return;
		}

		busy = true;

		try {
			const result = await post(`/mcp-tokens/${token.id}/rotate`);

			rotatedBearer = result.bearer;
			await refresh();
		} catch (err) {
			Notify.error(t('web.mcp.rotateFailed'), { detail: (err as Error).message });
			rotateOpen = false;
		} finally {
			busy = false;
		}
	}

	async function copySnippet(): Promise<void> {
		copied = await copyText(clientSnippet(page.url.origin, rotatedBearer));
	}

	async function removeConfirmed(): Promise<void> {
		if (!token) {
			return;
		}

		try {
			const result = await del(`/mcp-tokens/${token.id}`);

			Notify.success(t('web.mcpDetail.removed', { name: token.name }), {
				detail: result.knowledgeRemoved
					? t('web.mcpDetail.removedKnowledge', { count: result.knowledgeRemoved })
					: undefined
			});
			await goto('/console/mcp');
		} catch (err) {
			Notify.error(t('web.mcpDetail.updateFailed'), { detail: (err as Error).message });
		}
	}

	const verbs: ContextMenuItem[] = $derived(
		!token
			? []
			: [
					{
						label: token.enabled ? t('web.mcpDetail.disable') : t('web.mcpDetail.enable'),
						icon: token.enabled ? 'ban' : 'circleCheck',
						color: token.enabled ? 'warning' : undefined,
						action: () => setEnabled(!token!.enabled)
					},
					{
						label: t('web.mcp.rotateAction'),
						icon: 'rotate',
						color: 'warning',
						action: openRotate
					},
					{
						label: t('web.mcpDetail.copyId'),
						icon: 'copy',
						action: async () => {
							await copyText(token!.id);
						}
					},
					{ separator: true },
					{
						label: t('web.mcp.deleteAction', { count: 1 }),
						icon: 'trash',
						color: 'danger',
						action: () => {
							deleteOpen = true;
						}
					}
				]
	);

	const expiryOptions = $derived([
		{ value: 'keep', label: t('web.mcpDetail.expiryKeep') },
		{ value: 'never', label: t('web.mcpNew.expiryNever') },
		{ value: '7', label: t('web.mcpNew.expiryDays', { days: 7 }) },
		{ value: '30', label: t('web.mcpNew.expiryDays', { days: 30 }) },
		{ value: '90', label: t('web.mcpNew.expiryDays', { days: 90 }) },
		{ value: '365', label: t('web.mcpNew.expiryDays', { days: 365 }) }
	]);

	const summaryCells: InfoCell[] = $derived(
		!token
			? []
			: [
					{ label: t('web.mcp.colName'), value: token.name, copyable: true },
					{ id: 'state', label: t('web.common.state') },
					{ label: t('web.mcpNew.purpose'), value: token.description || '–', colSpan: 2 },
					{ id: 'tokenId', label: t('web.mcpDetail.tokenId') },
					{ label: t('web.mcp.colScope'), value: scopeSummary(token) },
					{
						label: t('web.mcp.colInstances'),
						value: token.scope.instances === null
							? t('web.mcp.everyInstance')
							: token.scope.instances.join(', ') || '–'
					},
					{
						label: t('web.mcp.colCreated'),
						value: `${fmtDateTime(token.createdAt)}${token.createdBy ? ` · ${token.createdBy}` : ''}`
					},
					{
						label: t('web.mcp.colLastUsed'),
						value: token.lastUsedAt
							? fmtDateTime(token.lastUsedAt)
							: t('web.mcp.never')
					},
					{
						label: t('web.mcp.colExpires'),
						value: token.expiresAt
							? fmtDateTime(token.expiresAt)
							: t('web.mcp.noExpiry')
					},
					{
						label: t('web.mcpDetail.rotated'),
						value: token.rotatedAt
							? fmtDateTime(token.rotatedAt)
							: t('web.mcp.never')
					},
					{
						label: t('web.mcp.colCalls'),
						value: `${token.stats.calls} · ${t('web.mcp.failuresShort', { count: token.stats.failures })}`
					},
					{ id: 'endpoint', label: t('web.mcp.overviewEndpoint'), colSpan: 2 }
				]
	);

	const callColumns: Column[] = $derived([
		{ id: 'when', label: t('web.mcp.colWhen'), sortable: true, width: 180 },
		{ id: 'outcome', label: t('web.mcp.colOutcome'), sortable: true, width: 120 },
		{ id: 'tool', label: t('web.mcp.colTool'), sortable: true, width: 170 },
		{ id: 'behalf', label: t('web.mcp.colOnBehalfOf'), sortable: true, width: 180 },
		{ id: 'duration', label: t('web.mcp.colDuration'), sortable: true, width: 110 },
		{ id: 'args', label: t('web.mcp.colArgs') },
		{ id: 'ip', label: t('web.mcp.colAddress'), sortable: true, width: 140, hidden: true }
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
		}
	]);

	const knowledgeColumns: Column[] = $derived([
		{ id: 'title', label: t('web.knowledge.colTitle'), sortable: true, width: 260 },
		{ id: 'kind', label: t('web.knowledge.colKind'), sortable: true, width: 130 },
		{ id: 'body', label: t('web.knowledge.colBody') },
		{ id: 'updated', label: t('web.knowledge.colUpdated'), sortable: true, width: 180 }
	]);

	const auditColumns: Column[] = $derived([
		{ id: 'when', label: t('web.mcp.colWhen'), sortable: true, width: 180 },
		{ id: 'action', label: t('web.mcp.colAction'), sortable: true, width: 170 },
		{ id: 'actor', label: t('web.mcp.colActor'), sortable: true, width: 170 },
		{ id: 'detail', label: t('web.mcp.colDetail') }
	]);

	function callActions(row: CallRow): ContextMenuItem[] {
		return [
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

	function knowledgeActions(row: KnowledgeItem): ContextMenuItem[] {
		return [
			{
				label: t('web.knowledge.edit'),
				icon: 'pen',
				action: () => goto(`/console/knowledge/${row.id}`)
			}
		];
	}
</script>

<svelte:head><title>{token?.name ?? id} | Luna Console</title></svelte:head>

{#if missing}
	<PageHeader title={id} description={t('web.mcpDetail.kind')} />
	<Flash kind="error">
		{t('web.mcpDetail.notFound', { name: id })}
		<a href="/console/mcp">{t('web.mcpDetail.back')}</a>
	</Flash>
{:else if token}
	<PageHeader title={token.name} description={token.description || t('web.mcpDetail.kind')} info>
		{#snippet extra()}
			<StatusBadge state={tokenState(token!)} label={tokenStateLabel(token!)} />
		{/snippet}
		{#snippet actions()}
			<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="mcp-token-detail" />
			<Dropdown label={t('web.common.actions')} menu={verbs} />
			<Btn icon="pen" onclick={openEdit}>{t('web.mcpDetail.editDetails')}</Btn>
			<Btn variant="primary" icon="plus" href="/console/knowledge/new?scope={token!.id}">
				{t('web.mcpDetail.addKnowledge')}
			</Btn>
		{/snippet}
	</PageHeader>

	{#if !token.enabled}
		<Flash kind="warning">{t('web.mcpDetail.disabledNotice')}</Flash>
	{:else if token.expired}
		<Flash kind="error">{t('web.mcpDetail.expiredNotice')}</Flash>
	{/if}

	<Tabs
		tabs={[
			{ id: 'details', label: t('web.mcpDetail.tabDetails') },
			{ id: 'scope', label: t('web.mcpDetail.tabScope') },
			{ id: 'calls', label: t('web.mcpDetail.tabCalls') },
			{ id: 'knowledge', label: t('web.mcpDetail.tabKnowledge') },
			{ id: 'activity', label: t('web.mcpDetail.tabActivity') }
		]}
		bind:active={tab}
	/>

	<div class="tabbody">
		{#if tab === 'details'}
			<Panel title={t('web.mcpDetail.summary')}>
				<InfoGrid cells={summaryCells}>
					{#snippet custom(cell)}
						{#if cell.id === 'state'}
							<StatusBadge state={tokenState(token!)} label={tokenStateLabel(token!)} />
						{:else if cell.id === 'tokenId'}
							<span class="mono dim">{token!.id}</span>
						{:else if cell.id === 'endpoint'}
							<span class="mono">{page.url.origin}/api/mcp</span>
						{/if}
					{/snippet}
				</InfoGrid>
			</Panel>

			<div class="gap"></div>

			<Panel title={t('web.mcpDetail.toolsPanel')} count={token.tools.length}>
				<div class="toollist">
					{#each token.tools as name (name)}
						<span class="mono chip">{name}</span>
					{:else}
						<span class="dim">{t('web.mcpDetail.noTools')}</span>
					{/each}
				</div>
			</Panel>
		{:else if tab === 'scope' && draft}
			<Panel title={t('web.mcpDetail.scopePanel')} description={t('web.mcpDetail.scopeHint')}>
				{#snippet actions()}
					<Btn disabled={!scopeDirty} onclick={resetScope}>{t('web.common.discard')}</Btn>
					<Btn variant="primary" icon="floppyDisk" disabled={!scopeDirty} loading={savingScope} onclick={saveScope}>
						{t('web.mcpDetail.saveScope', { count: allowedTools(draft!).length })}
					</Btn>
				{/snippet}
				<McpScopeEditor bind:scope={draft} {instances} />
			</Panel>
		{:else if tab === 'calls'}
			{#if callsTruncated}
				<Flash kind="info">{t('web.mcp.callsTruncated', { count: calls.length })}</Flash>
			{/if}
			<Panel flush>
				<ResourceTable
					tableId="mcp-token-calls"
					columns={callColumns}
					filters={callFilters}
					rows={calls}
					getId={(row) => row.key}
					searchValue={(row) => `${row.tool} ${row.args ?? ''} ${row.error ?? ''} ${behalfLabel(row)}`}
					searchPlaceholder={t('web.mcp.searchCalls')}
					rowActions={callActions}
					rowLabel={(row) => row.tool}
					noun={t('web.mcp.callNoun')}
					sortValue={(row, col) =>
						col === 'when'
							? row.t
							: col === 'duration'
								? row.durationMs
								: null}
					emptyTitle={t('web.mcp.noCallsTitle')}
					emptyText={t('web.mcpDetail.noCallsText')}
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
						{:else if col === 'behalf'}
							<span class:dim={!row.onBehalfOf}>{behalfLabel(row) || '–'}</span>
						{:else if col === 'duration'}
							<span class="mono">{row.durationMs} ms</span>
						{:else if col === 'args'}
							<span class="mono dim args">{row.args ?? '–'}</span>
						{:else if col === 'ip'}
							<span class="mono dim">{row.ip ?? '–'}</span>
						{/if}
					{/snippet}
				</ResourceTable>
			</Panel>
		{:else if tab === 'knowledge'}
			<Flash kind="info">{t('web.mcpDetail.knowledgeNotice')}</Flash>
			<Panel flush>
				<ResourceTable
					tableId="mcp-token-knowledge"
					columns={knowledgeColumns}
					rows={knowledge}
					getId={(row) => row.id}
					searchValue={(row) => `${row.title} ${row.body} ${row.tags.join(' ')}`}
					searchPlaceholder={t('web.knowledge.searchPlaceholder')}
					rowActions={knowledgeActions}
					rowLabel={(row) => row.title}
					rowDim={(row) => !row.enabled}
					noun={t('web.knowledge.noun')}
					onRowClick={(row) => goto(`/console/knowledge/${row.id}`)}
					sortValue={(row, col) => (col === 'updated' ? row.updatedAt : null)}
					emptyTitle={t('web.mcpDetail.noKnowledgeTitle')}
					emptyText={t('web.mcpDetail.noKnowledgeText')}
				>
					{#snippet cell(row, col)}
						{#if col === 'title'}
							<a href="/console/knowledge/{row.id}"><b>{row.title}</b></a>
						{:else if col === 'kind'}
							{t(`web.knowledge.kind.${row.kind}`)}
						{:else if col === 'body'}
							<span class="dim args">{row.description || row.body}</span>
						{:else if col === 'updated'}
							<span class="dim">{fmtDateTime(row.updatedAt)}</span>
						{/if}
					{/snippet}
				</ResourceTable>
			</Panel>
		{:else if tab === 'activity'}
			<Panel flush>
				<ResourceTable
					tableId="mcp-token-audit"
					columns={auditColumns}
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

	<Modal title={t('web.mcpDetail.editTitle', { name: token.name })} bind:open={editOpen}>
		<FormGrid>
			<label class="field">
				<span class="lbl">{t('web.mcpNew.name')}</span>
				<input class="input" type="text" spellcheck="false" bind:value={editName} />
			</label>
			<label class="field">
				<span class="lbl">{t('web.mcpNew.purpose')}</span>
				<input class="input" type="text" bind:value={editDescription} />
			</label>
			<div class="field">
				<span class="lbl">{t('web.mcpNew.expiry')}</span>
				<Select options={expiryOptions} bind:value={editExpiry} />
			</div>
		</FormGrid>

		{#snippet footer()}
			<Btn onclick={() => (editOpen = false)}>{t('web.common.cancel')}</Btn>
			<Btn variant="primary" loading={busy} disabled={!editName.trim()} onclick={saveEdit}>
				{t('web.common.save')}
			</Btn>
		{/snippet}
	</Modal>

	<Modal title={t('web.mcp.rotateTitle', { name: token.name })} bind:open={rotateOpen}>
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
				<Btn icon={copied ? 'circleCheck' : 'copy'} onclick={copySnippet}>
					{copied ? t('web.common.copied') : t('web.mcp.copySnippet')}
				</Btn>
				<Btn variant="primary" onclick={() => (rotateOpen = false)}>{t('web.common.done')}</Btn>
			{:else}
				<Btn onclick={() => (rotateOpen = false)}>{t('web.common.cancel')}</Btn>
				<Btn variant="primary" loading={busy} onclick={rotateConfirmed}>{t('web.mcp.rotateAction')}</Btn>
			{/if}
		{/snippet}
	</Modal>

	<ConfirmModal
		bind:open={deleteOpen}
		title={t('web.mcp.deleteTitle', { count: 1 })}
		lead={t('web.mcp.deleteLead', { names: token.name })}
		notes={[t('web.mcp.deleteNote')]}
		confirmLabel={t('web.common.delete')}
		onconfirm={() => void removeConfirmed()}
	/>
{/if}

<style lang="scss">
	.tabbody {
		margin-top: 1rem;
	}

	.gap {
		height: 1rem;
	}

	.toollist {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.chip {
		font-size: 0.75rem;
		border: 0.1rem solid var(--border-divider);
		border-radius: 0.75rem;
		padding: 0.125rem 0.5rem;
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

	.secret code {
		display: block;
		margin-top: 0.75rem;
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
