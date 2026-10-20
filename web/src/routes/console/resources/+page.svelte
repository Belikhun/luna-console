<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, put } from '$lib/api';
	import { fmtDateTime } from '$lib/format';
	import { Authz } from '$lib/authz.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import Select from '$lib/components/Select.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import TagEditor from '$lib/components/TagEditor.svelte';
	import { tagAddFault, tagEntries } from '$lib/components/tageditor';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { Notify } from '$lib/notifications.svelte';
	import { IAM_RESOURCE_TYPES, type IamResourceType } from '$shared/iam/actions';
	import type { ResourceView } from '$core/resources';

	/**
	 * Every resource the store has a record of: what kind it is, who made it,
	 * when it last changed and the tags on it. Tags are the one thing edited
	 * here; everything else about a resource lives on its own screen, which the
	 * name links to.
	 */

	let rows = $state<ResourceView[]>([]);
	let vocabulary = $state<Record<string, string[]>>({});
	let loading = $state(false);
	let loaded = $state(false);
	let lastUpdated = $state<number | null>(null);
	let selected = $state<Set<string>>(new Set());

	// edit one resource's tags in place
	let editOpen = $state(false);
	let editing = $state<ResourceView | null>(null);
	let editBusy = $state(false);

	// one tag over the whole selection
	let bulkAddOpen = $state(false);
	let bulkRemoveOpen = $state(false);
	let bulkKey = $state('');
	let bulkValue = $state('');
	let bulkBusy = $state(false);
	let bulkTargets = $state<ResourceView[]>([]);

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const data = await api<{ resources: ResourceView[]; vocabulary: Record<string, string[]> }>('/resources');

			rows = data.resources;
			vocabulary = data.vocabulary;
			lastUpdated = Date.now();
		} catch (err) {
			Notify.error(t('web.resources.loadFailed'), { detail: (err as Error).message });
		} finally {
			loading = false;
			loaded = true;
		}
	}

	onMount(() => {
		void refresh();
	});

	const picked = $derived(rows.filter((row) => selected.has(row.id)));

	/** Where a resource's own screen is, or null for a kind that has none. */
	function hrefOf(row: ResourceView): string | null {
		const name = encodeURIComponent(row.name);

		switch (row.type) {
			case 'instance':
				return `/instances/${name}`;
			case 'plugin':
				return `/plugins/${name}`;
			case 'pack':
				return `/packs/${name}`;
			case 'env':
				return `/environment/${name}`;
			case 'account':
				return `/console/accounts?q=${name}`;
			case 'policy':
				return `/console/iam/policies/${name}`;
			case 'group':
				return `/console/iam/groups/${name}`;
			case 'mcp-token':
				return `/console/mcp?q=${name}`;
			case 'knowledge':
				return `/console/knowledge/${name}`;
			case 'schedule':
				return `/schedules?q=${name}`;
			case 'domain':
				return `/network/domains?q=${name}`;
			case 'machine':
				return `/machines/${name}`;
			default:
				return null;
		}
	}

	function typeLabel(type: IamResourceType): string {
		const key = `web.resources.types.${type}`;
		const label = t(key);

		return label === key ? type : label;
	}

	function canTag(row: ResourceView): boolean {
		return Authz.can('tag:Tag', row.id, { tags: row.tags, createdBy: row.createdBy });
	}

	function tagText(row: ResourceView): string {
		return tagEntries(row.tags)
			.map((entry) => `${entry.key}=${entry.value}`)
			.join(' ');
	}

	/** Swap one row for the record the route handed back, keeping the table's order. */
	function adopt(resource: ResourceView): void {
		rows = rows.map((row) => (row.id === resource.id ? resource : row));

		if (editing?.id === resource.id) {
			editing = resource;
		}
	}

	function openEdit(row: ResourceView): void {
		editing = row;
		editOpen = true;
	}

	async function addTagTo(row: ResourceView, key: string, value: string): Promise<void> {
		const result = await put<{ resource: ResourceView }>('/resources/tags', { id: row.id, tags: { [key]: value } });

		adopt(result.resource);
	}

	async function removeTagFrom(row: ResourceView, key: string): Promise<void> {
		const result = await api<{ resource: ResourceView }>('/resources/tags', {
			method: 'DELETE',
			body: JSON.stringify({ id: row.id, keys: [key] })
		});

		adopt(result.resource);
	}

	async function editAdd(key: string, value: string): Promise<void> {
		if (!editing) {
			return;
		}

		editBusy = true;

		try {
			await addTagTo(editing, key, value);
		} catch (err) {
			Notify.error(t('web.resources.tagFailed', { name: editing.name }), { detail: (err as Error).message });
		} finally {
			editBusy = false;
		}
	}

	async function editRemove(key: string): Promise<void> {
		if (!editing) {
			return;
		}

		editBusy = true;

		try {
			await removeTagFrom(editing, key);
		} catch (err) {
			Notify.error(t('web.resources.tagFailed', { name: editing.name }), { detail: (err as Error).message });
		} finally {
			editBusy = false;
		}
	}

	function openBulkAdd(targets: ResourceView[]): void {
		bulkTargets = targets;
		bulkKey = '';
		bulkValue = '';
		bulkAddOpen = true;
	}

	function openBulkRemove(targets: ResourceView[]): void {
		bulkTargets = targets;
		bulkKey = selectionKeys(targets)[0] ?? '';
		bulkRemoveOpen = true;
	}

	/** Every tag key present on at least one of the rows, for the remove dialog. */
	function selectionKeys(targets: ResourceView[]): string[] {
		const keys = new Set<string>();

		for (const row of targets) {
			for (const key of Object.keys(row.tags)) {
				keys.add(key);
			}
		}

		return [...keys].sort((a, b) => a.localeCompare(b));
	}

	const bulkAddFault = $derived(tagAddFault(bulkKey.trim(), bulkValue.trim(), {}));
	const bulkRemoveOptions = $derived(selectionKeys(bulkTargets).map((key) => ({ value: key, label: key })));

	/** The remove verb only touches rows that carry the key; the rest are not an error. */
	const bulkRemoveCount = $derived(bulkTargets.filter((row) => bulkKey in row.tags).length);

	async function runBulk(
		targets: ResourceView[],
		run: (row: ResourceView) => Promise<void>,
		doneKey: string,
		partialKey: string
	): Promise<void> {
		bulkBusy = true;

		const failed: string[] = [];

		for (const row of targets) {
			try {
				await run(row);
			} catch (err) {
				failed.push(`${row.id}: ${(err as Error).message}`);
			}
		}

		bulkBusy = false;

		const done = targets.length - failed.length;

		if (failed.length === 0) {
			Notify.success(t(doneKey, { count: done, key: bulkKey.trim() }));
		} else {
			Notify.warning(t(partialKey, { done, failed: failed.length, key: bulkKey.trim() }), {
				detail: failed.join('\n')
			});
		}

		await refresh();
	}

	async function bulkAddConfirmed(): Promise<void> {
		if (bulkAddFault || bulkTargets.length === 0) {
			return;
		}

		const key = bulkKey.trim();
		const value = bulkValue.trim();

		await runBulk(
			bulkTargets,
			(row) => addTagTo(row, key, value),
			'web.resources.bulkAddDone',
			'web.resources.bulkAddPartial'
		);
		bulkAddOpen = false;
	}

	async function bulkRemoveConfirmed(): Promise<void> {
		if (!bulkKey || bulkRemoveCount === 0) {
			return;
		}

		const key = bulkKey;
		const carrying = bulkTargets.filter((row) => key in row.tags);

		await runBulk(
			carrying,
			(row) => removeTagFrom(row, key),
			'web.resources.bulkRemoveDone',
			'web.resources.bulkRemovePartial'
		);
		bulkRemoveOpen = false;
	}

	/** The verbs over a set of rows: the Actions dropdown and each row's menu share them. */
	function resourceActions(targets: ResourceView[]): ContextMenuItem[] {
		const one = targets.length === 1 ? targets[0] : undefined;
		const href = one ? hrefOf(one) : null;
		const taggable = targets.filter((row) => canTag(row));

		return [
			{
				label: t('web.resources.open'),
				icon: 'arrowUpRightFromSquare',
				disabled: !href,
				hint: !one
					? t('web.resources.pickOne')
					: href
						? undefined
						: t('web.resources.noScreen'),
				action: () => goto(href!)
			},
			{
				label: t('web.resources.editTags'),
				icon: 'tags',
				disabled: !one || !canTag(one),
				hint: !one
					? t('web.resources.pickOne')
					: canTag(one)
						? undefined
						: t('web.resources.notAllowed'),
				action: () => openEdit(one!)
			},
			{ separator: true },
			{
				label: t('web.resources.bulkAdd', { count: taggable.length }),
				icon: 'tag',
				disabled: taggable.length === 0,
				hint: taggable.length ? undefined : t('web.resources.noneTaggable'),
				action: () => openBulkAdd(taggable)
			},
			{
				label: t('web.resources.bulkRemove', { count: taggable.length }),
				icon: 'eraser',
				color: 'warning',
				disabled: taggable.length === 0 || selectionKeys(taggable).length === 0,
				hint: taggable.length === 0
					? t('web.resources.noneTaggable')
					: selectionKeys(taggable).length === 0
						? t('web.resources.noTagsToRemove')
						: undefined,
				action: () => openBulkRemove(taggable)
			}
		];
	}

	function rowActions(row: ResourceView): ContextMenuItem[] {
		return resourceActions(selected.has(row.id) && picked.length > 1 ? picked : [row]);
	}

	const columns: Column[] = $derived([
		{ id: 'type', label: t('web.resources.colType'), sortable: true, width: 150 },
		{ id: 'name', label: t('web.resources.colName'), sortable: true, width: 260 },
		{ id: 'tags', label: t('web.resources.colTags') },
		{ id: 'createdBy', label: t('web.resources.colCreatedBy'), sortable: true, width: 150 },
		{ id: 'created', label: t('web.resources.colCreated'), sortable: true, width: 180 },
		{ id: 'updated', label: t('web.resources.colUpdated'), sortable: true, width: 180 },
		{ id: 'updatedBy', label: t('web.resources.colUpdatedBy'), sortable: true, width: 150, hidden: true },
		{ id: 'id', label: t('web.resources.colId'), width: 260, hidden: true }
	]);

	const filters: TableFilterGroup<ResourceView>[] = $derived([
		{
			id: 'type',
			label: t('web.resources.colType'),
			options: [
				{ value: 'any', label: t('web.resources.anyType') },
				...IAM_RESOURCE_TYPES.map((type) => ({
					value: type,
					label: typeLabel(type),
					match: (row: ResourceView) => row.type === type
				}))
			]
		},
		{
			id: 'tag',
			label: t('web.resources.filterTag'),
			options: [
				{ value: 'any', label: t('web.resources.anyTag') },
				...Object.keys(vocabulary)
					.sort((a, b) => a.localeCompare(b))
					.map((key) => ({
						value: key,
						label: key,
						match: (row: ResourceView) => key in row.tags
					}))
			]
		}
	]);

	function sortValue(row: ResourceView, col: string): string | number | null {
		switch (col) {
			case 'type':
				return typeLabel(row.type);
			case 'created':
				return row.createdAt ?? 0;
			case 'updated':
				return row.updatedAt ?? 0;
			case 'createdBy':
				return row.createdBy ?? '';
			case 'updatedBy':
				return row.updatedBy ?? '';
			default:
				return null;
		}
	}
</script>

<svelte:head><title>{t('web.resources.title')} | Luna Console</title></svelte:head>

<PageHeader title={t('web.resources.title')} count={rows.length} description={t('web.resources.pageDescription')} info>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="console-resources" />
		<Dropdown label={t('web.common.actions')} disabled={picked.length === 0} menu={resourceActions(picked)} />
		<Btn icon="shieldHalved" href="/console/iam">{t('web.resources.iam')}</Btn>
	{/snippet}
</PageHeader>

<Panel flush>
	<ResourceTable
		tableId="resources"
		loading={!loaded}
		initialSearch={page.url.searchParams.get('q') ?? ''}
		{columns}
		{filters}
		{rows}
		getId={(row) => row.id}
		searchValue={(row) => `${row.name} ${row.id} ${tagText(row)} ${row.createdBy ?? ''} ${row.updatedBy ?? ''}`}
		searchPlaceholder={t('web.resources.searchPlaceholder')}
		selectable="multi"
		bind:selected
		{rowActions}
		rowLabel={(row) => row.name}
		{sortValue}
		defaultSort={{ col: 'type' }}
		noun={t('web.resources.noun')}
		emptyTitle={t('web.resources.emptyTitle')}
		emptyText={t('web.resources.emptyText')}
	>
		{#snippet cell(row, col)}
			{#if col === 'type'}
				<StatusBadge state="info" label={typeLabel(row.type)} />
			{:else if col === 'name'}
				{@const href = hrefOf(row)}
				{#if href}
					<a {href}><b>{row.name}</b></a>
				{:else}
					<b>{row.name}</b>
				{/if}
			{:else if col === 'tags'}
				{#if Object.keys(row.tags).length}
					<span class="chips">
						{#each tagEntries(row.tags) as entry (entry.key)}
							<span class="chip mono" title="{entry.key}={entry.value}">
								<span class="k">{entry.key}</span>{#if entry.value !== ''}<span class="v">={entry.value}</span>{/if}
							</span>
						{/each}
					</span>
				{:else}
					<span class="dim">–</span>
				{/if}
			{:else if col === 'createdBy'}
				<span class:dim={!row.createdBy}>{row.createdBy ?? '–'}</span>
			{:else if col === 'created'}
				<span class="dim">{row.createdAt ? fmtDateTime(row.createdAt) : '–'}</span>
			{:else if col === 'updated'}
				<span class="dim">{row.updatedAt ? fmtDateTime(row.updatedAt) : '–'}</span>
			{:else if col === 'updatedBy'}
				<span class:dim={!row.updatedBy}>{row.updatedBy ?? '–'}</span>
			{:else if col === 'id'}
				<span class="mono dim">{row.id}</span>
			{/if}
		{/snippet}
	</ResourceTable>
</Panel>

<Modal title={t('web.resources.editTagsTitle', { name: editing?.name ?? '' })} bind:open={editOpen}>
	{#if editing}
		<p class="modalnote mono dim">{editing.id}</p>
		<TagEditor tags={editing.tags} busy={editBusy} onadd={editAdd} onremove={editRemove} />
	{/if}

	{#snippet footer()}
		<Btn variant="primary" onclick={() => (editOpen = false)}>{t('web.common.done')}</Btn>
	{/snippet}
</Modal>

<Modal title={t('web.resources.bulkAddTitle', { count: bulkTargets.length })} bind:open={bulkAddOpen}>
	<p class="modalnote dim">{t('web.resources.bulkAddHint')}</p>
	<div class="pair">
		<label class="field">
			<span class="lbl">{t('web.resources.tagKey')}</span>
			<input class="input mono" type="text" bind:value={bulkKey} placeholder={t('web.tagEditor.keyPlaceholder')} />
		</label>
		<label class="field">
			<span class="lbl">{t('web.resources.tagValue')}</span>
			<input class="input mono" type="text" bind:value={bulkValue} placeholder={t('web.tagEditor.valuePlaceholder')} />
			{#if bulkKey !== '' && bulkAddFault}
				<span class="err">{t(bulkAddFault)}</span>
			{/if}
		</label>
	</div>

	{#snippet footer()}
		<Btn onclick={() => (bulkAddOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="primary" disabled={!!bulkAddFault} loading={bulkBusy} onclick={() => void bulkAddConfirmed()}>
			{t('web.resources.bulkAddAction', { count: bulkTargets.length })}
		</Btn>
	{/snippet}
</Modal>

<Modal title={t('web.resources.bulkRemoveTitle', { count: bulkTargets.length })} bind:open={bulkRemoveOpen}>
	<p class="modalnote dim">{t('web.resources.bulkRemoveHint')}</p>
	<div class="field">
		<span class="lbl">{t('web.resources.tagKey')}</span>
		<Select bind:value={bulkKey} options={bulkRemoveOptions} width="100%" searchable />
		<span class="hint">{t('web.resources.bulkRemoveCount', { count: bulkRemoveCount, total: bulkTargets.length })}</span>
	</div>

	{#snippet footer()}
		<Btn onclick={() => (bulkRemoveOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="danger" disabled={bulkRemoveCount === 0} loading={bulkBusy} onclick={() => void bulkRemoveConfirmed()}>
			{t('web.resources.bulkRemoveAction', { count: bulkRemoveCount })}
		</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.chips {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 0.25rem;
	}

	// the pill the tag editor draws, read-only and dense enough for a table cell
	.chip {
		display: inline-flex;
		max-width: 16rem;
		font-size: 0.6875rem;
		line-height: 1rem;
		border: 0.1rem solid var(--border-divider);
		border-radius: 0.75rem;
		padding: 0.0625rem 0.5rem;

		.k {
			@include ellipsis;

			color: var(--text-heading);
		}

		.v {
			@include ellipsis;

			color: var(--text-secondary);
		}
	}

	.modalnote {
		margin: 0 0 1rem;
		font-size: 0.8125rem;
	}

	.pair {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;

		@include below($bp-narrow) {
			grid-template-columns: 1fr;
		}
	}
</style>
