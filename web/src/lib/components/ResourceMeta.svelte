<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { api, put } from '$lib/api';
	import { fmtDateTime } from '$lib/format';
	import { Authz } from '$lib/authz.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import { loadResourceMeta } from '$lib/resourcemeta.svelte';
	import { MAX_TAGS } from '$shared/iam/resources';
	import type { ResourceView } from '$core/resources';
	import Panel from './Panel.svelte';
	import InfoGrid from './InfoGrid.svelte';
	import CopyValue from './CopyValue.svelte';
	import DataTable from './DataTable.svelte';
	import Modal from './Modal.svelte';
	import Btn from './Btn.svelte';
	import OwnerCell from './OwnerCell.svelte';
	import TagEditor from './TagEditor.svelte';
	import {
		diffIsEmpty,
		diffTags,
		draftFaults,
		draftRows,
		draftTags,
		tagEntries,
		type TagDraftRow,
		type TagEntry
	} from './tageditor';
	import type { InfoCell } from './grid';
	import type { Column } from './table';

	/**
	 * A resource's "Tags" tab, as AWS draws it: who owns the resource and when it
	 * changed, then its tags as a Key/Value table with "Manage tags", which opens
	 * the row editor and writes only the difference on save.
	 *
	 * `readonly` left unset means "whatever the account may do": adding or
	 * changing a tag needs `tag:Tag` and removing one `tag:Untag`, decided with
	 * the record's own facts once it has loaded, so an owner-only grant reads
	 * correctly.
	 */

	let {
		id,
		readonly,
		subject
	}: {
		id: string;
		readonly?: boolean;
		/** names the resource in the panel titles, for a screen showing several */
		subject?: string;
	} = $props();

	let resource = $state<ResourceView | null>(null);
	let failed = $state(false);

	let editOpen = $state(false);
	let editRows = $state<TagDraftRow[]>([]);
	let saving = $state(false);
	let editor: { touchAll: () => void } | undefined = $state();

	const facts = $derived(resource ? { tags: resource.tags, createdBy: resource.createdBy } : null);

	const canTag = $derived.by(() => {
		if (readonly !== undefined) {
			return !readonly;
		}

		return !!facts && Authz.can('tag:Tag', id, facts);
	});

	const canUntag = $derived.by(() => {
		if (readonly !== undefined) {
			return !readonly;
		}

		return !!facts && Authz.can('tag:Untag', id, facts);
	});

	/** Why "Manage tags" is unavailable, or empty when it is not. */
	const manageBlocked = $derived.by(() => {
		if (!resource) {
			return t('web.common.loading');
		}

		if (!canTag && !canUntag) {
			return t('web.resourceMeta.notAllowed');
		}

		return '';
	});

	const entries = $derived(resource ? tagEntries(resource.tags) : []);

	async function load(target: string): Promise<void> {
		failed = false;

		try {
			const loaded = await loadResourceMeta([target]);

			// a slower answer for a previous id must not land on the current one
			if (target === id) {
				resource = loaded[target] ?? null;
			}
		} catch (err) {
			if (target === id) {
				failed = true;
				resource = null;
				Notify.error(t('web.resourceMeta.loadFailed'), { detail: (err as Error).message });
			}
		}
	}

	$effect(() => {
		const target = id;

		resource = null;
		void load(target);
	});

	function openEditor(): void {
		if (!resource || manageBlocked) {
			return;
		}

		editRows = draftRows(resource.tags);
		editOpen = true;
	}

	const editFaults = $derived(draftFaults(editRows));
	const editDiff = $derived(diffTags(resource?.tags ?? {}, draftTags(editRows)));

	/** Why Save cannot go ahead, or empty when it can. */
	const saveBlocked = $derived.by(() => {
		if (Object.keys(draftTags(editRows)).length > MAX_TAGS) {
			return t('web.tagEditor.tooMany', { max: MAX_TAGS });
		}

		if (Object.keys(editDiff.set).length > 0 && !canTag) {
			return t('web.resourceMeta.mayNotTag');
		}

		if (editDiff.remove.length > 0 && !canUntag) {
			return t('web.resourceMeta.mayNotUntag');
		}

		return '';
	});

	async function save(): Promise<void> {
		if (Object.keys(editFaults).length > 0) {
			editor?.touchAll();

			return;
		}

		if (saveBlocked) {
			return;
		}

		if (diffIsEmpty(editDiff)) {
			editOpen = false;

			return;
		}

		saving = true;

		try {
			if (Object.keys(editDiff.set).length > 0) {
				const result = await put<{ resource: ResourceView }>('/resources/tags', { id, tags: editDiff.set });

				resource = result.resource;
			}

			if (editDiff.remove.length > 0) {
				const result = await api<{ resource: ResourceView }>('/resources/tags', {
					method: 'DELETE',
					body: JSON.stringify({ id, keys: editDiff.remove })
				});

				resource = result.resource;
			}

			Notify.success(t('web.resourceMeta.saved'));
			editOpen = false;
		} catch (err) {
			Notify.error(t('web.resourceMeta.tagFailed'), { detail: (err as Error).message });

			// whatever half landed is what the table should show
			await load(id);
		} finally {
			saving = false;
		}
	}

	const ownerCells: InfoCell[] = $derived([
		{ id: 'createdBy', label: t('web.resourceMeta.createdBy') },
		{ label: t('web.resourceMeta.createdAt'), value: resource?.createdAt ? fmtDateTime(resource.createdAt) : null },
		{ id: 'updatedBy', label: t('web.resourceMeta.updatedBy') },
		{ label: t('web.resourceMeta.updatedAt'), value: resource?.updatedAt ? fmtDateTime(resource.updatedAt) : null },
		{ id: 'id', label: t('web.resourceMeta.id'), colSpan: 'all' }
	]);

	const tagColumns: Column[] = $derived([
		{ id: 'key', label: t('web.tagEditor.key'), sortable: true, width: 260 },
		{ id: 'value', label: t('web.tagEditor.value'), sortable: true }
	]);
</script>

<div class="resmeta">
	<Panel
		title={subject ? t('web.resourceMeta.ownershipOf', { name: subject }) : t('web.resourceMeta.ownership')}
		description={resource?.unknown ? t('web.resourceMeta.unrecorded') : undefined}
	>
		{#if failed}
			<p class="none dim">{t('web.resourceMeta.loadFailed')}</p>
		{:else}
			<InfoGrid cells={ownerCells}>
				{#snippet custom(cell)}
					{#if cell.id === 'createdBy'}
						<OwnerCell name={resource?.createdBy} />
					{:else if cell.id === 'updatedBy'}
						<OwnerCell name={resource?.updatedBy} />
					{:else if cell.id === 'id'}
						<CopyValue value={id} label={t('web.resourceMeta.id')} />
					{/if}
				{/snippet}
			</InfoGrid>
		{/if}
	</Panel>

	<Panel
		title={subject ? t('web.resourceMeta.tagsOf', { name: subject }) : t('web.resourceMeta.tags')}
		count={resource ? entries.length : undefined}
		description={t('web.resourceMeta.tagsDescription')}
		flush
	>
		{#snippet actions()}
			{#if readonly !== true}
				<Btn icon="tags" disabled={!!manageBlocked} title={manageBlocked || undefined} onclick={openEditor}>
					{t('web.resourceMeta.manage')}
				</Btn>
			{/if}
		{/snippet}

		<DataTable
			columns={tagColumns}
			rows={entries}
			getId={(row: TagEntry) => row.key}
			sortValue={(row: TagEntry, col) => (col === 'value' ? row.value : row.key)}
			defaultSort={{ col: 'key' }}
			loading={!resource && !failed}
			emptyTitle={t('web.resourceMeta.noTags')}
			emptyText={readonly === true ? '' : t('web.resourceMeta.noTagsHint')}
		>
			{#snippet cell(row, col)}
				{#if col === 'key'}
					<span class="mono">{row.key}</span>
				{:else if row.value === ''}
					<span class="dim">–</span>
				{:else}
					<span class="mono">{row.value}</span>
				{/if}
			{/snippet}

			{#snippet emptyExtra()}
				{#if readonly !== true}
					<Btn icon="tags" disabled={!!manageBlocked} title={manageBlocked || undefined} onclick={openEditor}>
						{t('web.resourceMeta.manage')}
					</Btn>
				{/if}
			{/snippet}
		</DataTable>
	</Panel>
</div>

<Modal title={t('web.resourceMeta.manageTitle')} bind:open={editOpen} wide dismissable={!saving}>
	<p class="note dim">{t('web.resourceMeta.manageHint')}</p>
	<p class="note mono">{id}</p>

	<TagEditor bind:this={editor} bind:rows={editRows} faults={editFaults} disabled={saving} />

	{#snippet footer()}
		<span class="reason dim">{saveBlocked}</span>
		<Btn disabled={saving} onclick={() => (editOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="primary" disabled={!!saveBlocked} loading={saving} onclick={() => void save()}>
			{t('web.resourceMeta.saveChanges')}
		</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.resmeta {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		min-width: 0;
	}

	.none {
		margin: 0;
		font-size: 0.8125rem;
	}

	.note {
		margin: 0 0 0.75rem;
		font-size: 0.8125rem;
	}

	.reason {
		flex: 1;
		font-size: 0.75rem;
	}
</style>
