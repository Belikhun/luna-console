<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, del, patch } from '$lib/api';
	import { fmtDateTime } from '$lib/format';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Tabs from '$lib/components/Tabs.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { Notify } from '$lib/notifications.svelte';
	import type { KnowledgeItem, KnowledgeKind } from '$core/mcp';
	import { scopeName } from './knowledge';

	/**
	 * What MCP clients are told: standing context, searchable memories and named
	 * skills, each either console-wide (every token reads it) or scoped to one
	 * token. A tab per kind, because each is used differently by the far side.
	 */

	const KINDS: KnowledgeKind[] = ['context', 'memory', 'skill'];

	let items: KnowledgeItem[] = $state([]);
	let tokens: Array<{ id: string; name: string }> = $state([]);
	let loading = $state(false);
	let loaded = $state(false);
	let lastUpdated: number | null = $state(null);
	let tab: string = $state(page.url.searchParams.get('kind') ?? 'context');
	let selected: Set<string> = $state(new Set());

	let deleteOpen = $state(false);
	let deleteRows: KnowledgeItem[] = $state([]);

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const data = await api('/knowledge');

			items = data.items;
			tokens = data.tokens;
			lastUpdated = Date.now();
		} catch (err) {
			Notify.error(t('web.knowledge.loadFailed'), { detail: (err as Error).message });
		} finally {
			loading = false;
			loaded = true;
		}
	}

	onMount(() => {
		void refresh();
	});

	const rows = $derived(items.filter((item) => item.kind === tab));
	const picked = $derived(rows.filter((row) => selected.has(row.id)));
	const counts = $derived(Object.fromEntries(KINDS.map((kind) => [kind, items.filter((item) => item.kind === kind).length])));

	async function runBulk(targets: KnowledgeItem[], verb: string, run: (row: KnowledgeItem) => Promise<unknown>): Promise<void> {
		if (targets.length === 0) {
			return;
		}

		const failed: string[] = [];

		for (const row of targets) {
			try {
				await run(row);
			} catch (err) {
				failed.push(`${row.title}: ${(err as Error).message}`);
			}
		}

		const done = targets.length - failed.length;

		if (failed.length === 0) {
			Notify.success(t('web.knowledge.bulkDone', { verb, count: done }));
		} else {
			Notify.warning(t('web.knowledge.bulkPartial', { verb, done, failed: failed.length }), {
				detail: failed.join('\n')
			});
		}

		await refresh();
	}

	function setField(targets: KnowledgeItem[], verb: string, field: 'enabled' | 'pinned', value: boolean): Promise<void> {
		return runBulk(targets, verb, (row) => patch(`/knowledge/${row.id}`, { [field]: value }));
	}

	function itemActions(targets: KnowledgeItem[]): ContextMenuItem[] {
		const one = targets.length === 1 ? targets[0] : undefined;
		const toEnable = targets.filter((row) => !row.enabled);
		const toDisable = targets.filter((row) => row.enabled);
		const toPin = targets.filter((row) => !row.pinned);
		const toUnpin = targets.filter((row) => row.pinned);

		return [
			{
				label: t('web.knowledge.edit'),
				icon: 'pen',
				disabled: !one,
				hint: one ? undefined : t('web.knowledge.pickOne'),
				action: () => goto(`/console/knowledge/${one!.id}`)
			},
			{ separator: true },
			{
				label: t('web.knowledge.pinAction', { count: toPin.length }),
				icon: 'thumbtack',
				disabled: toPin.length === 0,
				hint: toPin.length ? undefined : t('web.knowledge.allPinned'),
				action: () => setField(toPin, t('web.knowledge.verbPin'), 'pinned', true)
			},
			{
				label: t('web.knowledge.unpinAction', { count: toUnpin.length }),
				icon: 'thumbtack',
				disabled: toUnpin.length === 0,
				hint: toUnpin.length ? undefined : t('web.knowledge.nonePinned'),
				action: () => setField(toUnpin, t('web.knowledge.verbUnpin'), 'pinned', false)
			},
			{
				label: t('web.knowledge.enableAction', { count: toEnable.length }),
				icon: 'circleCheck',
				disabled: toEnable.length === 0,
				hint: toEnable.length ? undefined : t('web.knowledge.allEnabled'),
				action: () => setField(toEnable, t('web.knowledge.verbEnable'), 'enabled', true)
			},
			{
				label: t('web.knowledge.disableAction', { count: toDisable.length }),
				icon: 'ban',
				color: 'warning',
				disabled: toDisable.length === 0,
				hint: toDisable.length ? undefined : t('web.knowledge.allDisabled'),
				action: () => setField(toDisable, t('web.knowledge.verbDisable'), 'enabled', false)
			},
			{ separator: true },
			{
				label: t('web.knowledge.deleteAction', { count: targets.length }),
				icon: 'trash',
				color: 'danger',
				disabled: targets.length === 0,
				action: () => {
					deleteRows = targets;
					deleteOpen = true;
				}
			}
		];
	}

	function rowActions(row: KnowledgeItem): ContextMenuItem[] {
		return itemActions(selected.has(row.id) && picked.length > 1 ? picked : [row]);
	}

	async function removeConfirmed(): Promise<void> {
		await runBulk(deleteRows, t('web.knowledge.verbDelete'), (row) => del(`/knowledge/${row.id}`));
	}

	const columns: Column[] = $derived([
		{ id: 'title', label: tab === 'skill' ? t('web.knowledge.skillName') : t('web.knowledge.colTitle'), sortable: true, width: 260 },
		{ id: 'state', label: t('web.common.state'), sortable: true, width: 130 },
		{ id: 'scope', label: t('web.knowledge.colScope'), sortable: true, width: 170 },
		{ id: 'body', label: t('web.knowledge.colBody') },
		{ id: 'tags', label: t('web.knowledge.tags'), width: 160 },
		{ id: 'updated', label: t('web.knowledge.colUpdated'), sortable: true, width: 180 },
		{ id: 'author', label: t('web.knowledge.colAuthor'), sortable: true, width: 160, hidden: true }
	]);

	const filters: TableFilterGroup<KnowledgeItem>[] = $derived([
		{
			id: 'scope',
			label: t('web.knowledge.colScope'),
			options: [
				{ value: 'any', label: t('web.knowledge.anyScope') },
				{
					value: 'console',
					label: t('web.knowledge.scopeConsole'),
					match: (row) => row.scope.kind === 'console'
				},
				...tokens.map((token) => ({
					value: token.id,
					label: t('web.knowledge.scopeToken', { name: token.name }),
					match: (row: KnowledgeItem) => row.scope.kind === 'token' && row.scope.token === token.id
				}))
			]
		},
		{
			id: 'pinned',
			label: t('web.knowledge.pinned'),
			options: [
				{ value: 'any', label: t('web.knowledge.anyPinned') },
				{ value: 'yes', label: t('web.knowledge.pinned'), match: (row) => row.pinned },
				{ value: 'no', label: t('web.knowledge.notPinned'), match: (row) => !row.pinned }
			]
		}
	]);

	function itemState(row: KnowledgeItem): string {
		return row.enabled
			? (row.pinned ? 'info' : 'ok')
			: 'stopped';
	}

	function itemStateLabel(row: KnowledgeItem): string {
		if (!row.enabled) {
			return t('web.knowledge.disabled');
		}

		return row.pinned
			? t('web.knowledge.pinned')
			: t('web.knowledge.enabled');
	}
</script>

<svelte:head><title>{t('web.nav.knowledge')} | Luna Console</title></svelte:head>

<PageHeader title={t('web.nav.knowledge')} count={items.length} description={t('web.knowledge.pageDescription')} info>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="console-knowledge" />
		<Dropdown label={t('web.common.actions')} disabled={picked.length === 0} menu={itemActions(picked)} />
		<Btn icon="plug" href="/console/mcp">{t('web.knowledge.tokens')}</Btn>
		<Btn variant="primary" icon="plus" href="/console/knowledge/new?kind={tab}">
			{t(`web.knowledge.create.${tab}`)}
		</Btn>
	{/snippet}
</PageHeader>

<Tabs
	tabs={KINDS.map((kind) => ({ id: kind, label: `${t(`web.knowledge.tab.${kind}`)} (${counts[kind] ?? 0})` }))}
	bind:active={tab}
/>

<div class="tabbody">
	<Panel flush>
		{#key tab}
			<ResourceTable
				tableId="console-knowledge-{tab}"
				loading={!loaded}
				initialSearch={page.url.searchParams.get('q') ?? ''}
				{columns}
				{filters}
				{rows}
				getId={(row) => row.id}
				searchValue={(row) => `${row.title} ${row.description} ${row.body} ${row.tags.join(' ')}`}
				searchPlaceholder={t('web.knowledge.searchPlaceholder')}
				selectable="multi"
				bind:selected
				{rowActions}
				rowLabel={(row) => row.title}
				rowDim={(row) => !row.enabled}
				noun={t('web.knowledge.noun')}
				onRowClick={(row) => goto(`/console/knowledge/${row.id}`)}
				sortValue={(row, col) =>
					col === 'updated'
						? row.updatedAt
						: col === 'state'
							? itemState(row)
							: col === 'scope'
								? scopeName(row, tokens)
								: null}
				emptyTitle={t(`web.knowledge.emptyTitle.${tab}`)}
				emptyText={t(`web.knowledge.emptyText.${tab}`)}
			>
				{#snippet cell(row, col)}
					{#if col === 'title'}
						<a href="/console/knowledge/{row.id}"><b class:mono={row.kind === 'skill'}>{row.title}</b></a>
					{:else if col === 'state'}
						<StatusBadge state={itemState(row)} label={itemStateLabel(row)} />
					{:else if col === 'scope'}
						{#if row.scope.kind === 'console'}
							<span class="dim">{t('web.knowledge.scopeConsole')}</span>
						{:else}
							<a href="/console/mcp/{row.scope.token}">{scopeName(row, tokens)}</a>
						{/if}
					{:else if col === 'body'}
						<span class="dim excerpt">{row.description || row.body}</span>
					{:else if col === 'tags'}
						<span class:dim={row.tags.length === 0}>{row.tags.join(', ') || '–'}</span>
					{:else if col === 'updated'}
						<span class="dim">{fmtDateTime(row.updatedAt)}</span>
					{:else if col === 'author'}
						<span class="dim">{row.updatedBy ?? row.createdBy ?? '–'}</span>
					{/if}
				{/snippet}
			</ResourceTable>
		{/key}
	</Panel>
</div>

<ConfirmModal
	bind:open={deleteOpen}
	title={t('web.knowledge.deleteTitle', { count: deleteRows.length })}
	lead={t('web.knowledge.deleteLead', { names: deleteRows.map((row) => row.title).join(', ') })}
	confirmLabel={t('web.common.delete')}
	onconfirm={() => void removeConfirmed()}
/>

<style lang="scss">
	.tabbody {
		margin-top: 1rem;
	}

	.excerpt {
		@include ellipsis;

		display: block;
		font-size: 0.8125rem;
	}
</style>
