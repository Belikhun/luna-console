<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { tick } from 'svelte';
	import { t } from '$lib/i18n.svelte';
	import { api, put } from '$lib/api';
	import { Authz } from '$lib/authz.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import { RESOURCE_TYPE_ICONS, loadOneResourceMeta, resourceTypeLabel } from '$lib/resourcemeta.svelte';
	import { MAX_TAGS, resourceId } from '$shared/iam/resources';
	import type { IamResourceType } from '$shared/iam/actions';
	import type { ResourceView } from '$core/resources';
	import Modal from './Modal.svelte';
	import Btn from './Btn.svelte';
	import Flash from './Flash.svelte';
	import Icon from './Icon.svelte';
	import Spinner from './Spinner.svelte';
	import TagEditor from './TagEditor.svelte';
	import {
		blankTagRow,
		changeCounts,
		diffTags,
		draftFaults,
		draftRows,
		draftTags,
		rebaseRows,
		type TagDraftRow,
		type TagMap
	} from './tageditor';

	/**
	 * "Manage tags" for one resource: the row editor, then a save that writes
	 * only the difference (`tag:Tag` for what is added or changed, `tag:Untag`
	 * for what is removed, decided with the record's own facts). A screen that
	 * already holds the record passes it as `resource`; otherwise the modal
	 * reads it when it opens. `onsaved` hears the record as it now stands,
	 * including after a save that landed only in part, which keeps the dialog
	 * open with the rows measured against what was written.
	 */
	let {
		open = $bindable(false),
		type,
		name,
		resource = null,
		onsaved
	}: {
		open: boolean;
		type: IamResourceType;
		name: string;
		resource?: ResourceView | null;
		onsaved?: (view: ResourceView | null) => void;
	} = $props();

	const id = $derived(resourceId(type, name));

	let record = $state<ResourceView | null>(null);
	let rows = $state<TagDraftRow[]>([]);
	let saving = $state(false);
	let loading = $state(false);
	let loadFailed = $state(false);
	// a save was pressed while rows had faults; from then on the footer names them
	let attempted = $state(false);
	let saveError = $state<{ key: string; message: string } | null>(null);
	let editor: { touchAll: () => void; revealFault: () => Promise<void> } | undefined = $state();
	let body: HTMLDivElement | undefined = $state();
	let wasOpen = false;

	/** The rows a record opens with; one blank row to type into when it has no tags. */
	function initialRows(tags: TagMap): TagDraftRow[] {
		const out = draftRows(tags);

		return out.length > 0
			? out
			: [blankTagRow()];
	}

	async function focusStart(): Promise<void> {
		await tick();

		const target = Object.keys(record?.tags ?? {}).length === 0
			? body?.querySelector<HTMLElement>('input[data-field="key"]')
			: body?.querySelector<HTMLElement>('.add button');

		target?.focus();
	}

	async function prepare(target: string, given: ResourceView | null): Promise<void> {
		record = given;
		loadFailed = false;
		attempted = false;
		saveError = null;
		rows = given
			? initialRows(given.tags)
			: [];

		if (given) {
			await focusStart();

			return;
		}

		loading = true;

		const loaded = await loadOneResourceMeta(target);

		loading = false;

		// the modal moved on to another resource while this one loaded
		if (target !== id) {
			return;
		}

		if (!loaded) {
			loadFailed = true;

			return;
		}

		record = loaded;
		rows = initialRows(loaded.tags);

		await focusStart();
	}

	$effect(() => {
		if (open && !wasOpen) {
			void prepare(id, resource);
		}

		wasOpen = open;
	});

	const facts = $derived(record ? { tags: record.tags, createdBy: record.createdBy } : null);
	const canTag = $derived(!!facts && Authz.can('tag:Tag', id, facts));
	const canUntag = $derived(!!facts && Authz.can('tag:Untag', id, facts));
	const faults = $derived(draftFaults(rows));
	const hasFaults = $derived(Object.keys(faults).length > 0);
	const diff = $derived(diffTags(record?.tags ?? {}, draftTags(rows)));
	const counts = $derived(changeCounts(rows));
	const dirty = $derived(counts.add + counts.change + counts.remove > 0);

	/** Why Save cannot go ahead whatever the operator types next, or empty when it can. */
	const blocked = $derived.by(() => {
		if (!record) {
			return '';
		}

		if (Object.keys(draftTags(rows)).length > MAX_TAGS) {
			return t('web.tagEditor.tooMany', { max: MAX_TAGS });
		}

		if (Object.keys(diff.set).length > 0 && !canTag) {
			return t('web.resourceMeta.mayNotTag');
		}

		if (diff.remove.length > 0 && !canUntag) {
			return t('web.resourceMeta.mayNotUntag');
		}

		if (!canTag && !canUntag) {
			return t('web.resourceMeta.notAllowed');
		}

		return '';
	});

	const reason = $derived(
		hasFaults && attempted
			? t('web.tagEditor.fixFaults')
			: blocked
	);

	const summary = $derived(
		[
			counts.add > 0
				? t('web.tagEditor.summaryAdd', { count: counts.add })
				: '',
			counts.change > 0
				? t('web.tagEditor.summaryChange', { count: counts.change })
				: '',
			counts.remove > 0
				? t('web.tagEditor.summaryRemove', { count: counts.remove })
				: ''
		]
			.filter((part) => part !== '')
			.join(' · ')
	);

	const saveDisabled = $derived(!record || loading || !dirty || !!blocked);

	async function save(): Promise<void> {
		if (saving || !record) {
			return;
		}

		if (hasFaults) {
			attempted = true;
			await editor?.revealFault();

			return;
		}

		if (blocked || !dirty) {
			return;
		}

		saveError = null;
		saving = true;

		let landed = false;

		try {
			if (Object.keys(diff.set).length > 0) {
				const result = await put<{ resource: ResourceView }>('/resources/tags', { id, tags: diff.set });

				record = result.resource;
				landed = true;
			}

			if (diff.remove.length > 0) {
				const result = await api<{ resource: ResourceView }>('/resources/tags', {
					method: 'DELETE',
					body: JSON.stringify({ id, keys: diff.remove })
				});

				record = result.resource;
				landed = true;
			}

			Notify.success(t('web.resourceMeta.saved', { name }));
			onsaved?.(record);
			open = false;
		} catch (err) {
			// whatever half landed is what the rows are measured against now
			const reread = await loadOneResourceMeta(id);

			if (reread) {
				record = reread;
				rows = rebaseRows(rows, reread.tags);
			}

			onsaved?.(reread);
			saveError = {
				key: landed
					? 'web.resourceMeta.partSaved'
					: 'web.resourceMeta.tagFailed',
				message: (err as Error).message
			};
		} finally {
			saving = false;
		}
	}

	function onKeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			void save();
		}
	}
</script>

<Modal title={t('web.resourceMeta.manageTitle')} bind:open wide dismissable={!saving && !dirty}>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="body" bind:this={body} onkeydown={onKeydown}>
		<div class="identity">
			<Icon name={RESOURCE_TYPE_ICONS[type]} size="0.875rem" style="solid" />
			<b class="name">{name}</b>
			<span class="dim kind">{resourceTypeLabel(type)}</span>
		</div>

		{#if loadFailed}
			<Flash kind="error">
				<div class="failed">
					<span>{t('web.resourceMeta.loadFailed')}</span>
					<Btn onclick={() => void prepare(id, null)}>{t('web.common.retry')}</Btn>
				</div>
			</Flash>
		{:else if !record}
			<div class="loading dim">
				<Spinner />
				<span>{t('web.common.loading')}</span>
			</div>
		{:else}
			{#if !canTag && !canUntag}
				<div class="flash"><Flash kind="warning">{t('web.resourceMeta.notAllowed')}</Flash></div>
			{:else if !canTag}
				<div class="flash"><Flash kind="info">{t('web.resourceMeta.onlyRemove')}</Flash></div>
			{:else if !canUntag}
				<div class="flash"><Flash kind="info">{t('web.resourceMeta.onlyTag')}</Flash></div>
			{/if}

			{#if saveError}
				<div class="flash"><Flash kind="error">{t(saveError.key)} {saveError.message}</Flash></div>
			{/if}

			<TagEditor
				bind:this={editor}
				bind:rows
				{faults}
				disabled={saving || (!canTag && !canUntag)}
				canEdit={canTag}
				canRemove={canUntag}
				editBlocked={t('web.resourceMeta.mayNotTag')}
				removeBlocked={t('web.resourceMeta.mayNotUntag')}
			/>
		{/if}
	</div>

	{#snippet footer()}
		{#if loadFailed}
			<span class="reason"></span>
		{:else if reason}
			<span class="reason warn">{reason}</span>
		{:else if dirty}
			<span class="reason">{summary}</span>
		{:else}
			<span class="reason dim">{record ? t('web.tagEditor.summaryNone') : ''}</span>
		{/if}

		<Btn disabled={saving} onclick={() => (open = false)}>
			{dirty
				? t('web.resourceMeta.discardChanges')
				: t('web.common.cancel')}
		</Btn>

		{#if !loadFailed}
			<Btn variant="primary" disabled={saveDisabled} loading={saving} onclick={() => void save()}>
				{t('web.resourceMeta.saveChanges')}
			</Btn>
		{/if}
	{/snippet}
</Modal>

<style lang="scss">
	.identity {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
		margin-bottom: 0.75rem;
		font-size: 0.875rem;

		.name {
			@include ellipsis;

			color: var(--text-heading);
		}

		.kind {
			flex: none;
		}
	}

	.flash {
		margin-bottom: 0.75rem;
	}

	.failed {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.75rem;
	}

	.loading {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		height: 6rem;
		font-size: 0.8125rem;
	}

	.reason {
		flex: 1;
		font-size: 0.75rem;

		&.warn {
			color: var(--warning);
		}
	}
</style>
