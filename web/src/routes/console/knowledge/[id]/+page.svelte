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
	import Btn from '$lib/components/Btn.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import { clearCrumbLabel, setCrumbLabel } from '$lib/crumbs.svelte';
	import type { KnowledgeItem } from '$core/mcp';
	import KnowledgeForm from '../KnowledgeForm.svelte';
	import { draftBody, draftOf, type KnowledgeDraft } from '../knowledge';

	/** Edit one knowledge item in place. */

	const id = $derived(page.params.id ?? '');

	let item = $state<KnowledgeItem | null>(null);
	let draft = $state<KnowledgeDraft | null>(null);
	let tokens: Array<{ id: string; name: string }> = $state([]);
	let missing = $state(false);
	let saving = $state(false);
	let deleteOpen = $state(false);

	async function load(): Promise<void> {
		try {
			const data = await api(`/knowledge/${encodeURIComponent(id)}`);

			item = data.item;
			tokens = data.tokens;
			draft = draftOf(data.item);
		} catch (err) {
			if ((err as { status?: number }).status === 404) {
				missing = true;
			} else {
				Notify.error(t('web.knowledge.loadFailed'), { detail: (err as Error).message });
			}
		}
	}

	onMount(() => {
		void load();
	});

	$effect(() => {
		if (!item) {
			return;
		}

		const path = `/console/knowledge/${id}`;

		setCrumbLabel(path, item.title);

		return () => clearCrumbLabel(path);
	});

	const dirty = $derived(!!item && !!draft && JSON.stringify(draftBody(draft)) !== JSON.stringify(draftBody(draftOf(item))));

	async function save(): Promise<void> {
		if (!draft || !item) {
			return;
		}

		saving = true;

		try {
			const result = await patch(`/knowledge/${item.id}`, draftBody(draft));

			item = result.item;
			draft = draftOf(result.item);
			Notify.success(t('web.knowledge.saved', { title: result.item.title }));
		} catch (err) {
			Notify.error(t('web.knowledge.saveFailed'), { detail: (err as Error).message });
		} finally {
			saving = false;
		}
	}

	async function removeConfirmed(): Promise<void> {
		if (!item) {
			return;
		}

		try {
			await del(`/knowledge/${item.id}`);
			Notify.success(t('web.knowledge.removed', { title: item.title }));
			await goto(`/console/knowledge?kind=${item.kind}`);
		} catch (err) {
			Notify.error(t('web.knowledge.saveFailed'), { detail: (err as Error).message });
		}
	}
</script>

<svelte:head><title>{item?.title ?? id} | Luna Console</title></svelte:head>

{#if missing}
	<PageHeader title={id} description={t('web.nav.knowledge')} />
	<Flash kind="error">
		{t('web.knowledge.notFound', { id })}
		<a href="/console/knowledge">{t('web.knowledge.back')}</a>
	</Flash>
{:else if item && draft}
	<PageHeader
		title={item.title}
		description={`${t(`web.knowledge.kind.${item.kind}`)} · ${t('web.knowledge.lastEdited', { time: fmtDateTime(item.updatedAt), actor: item.updatedBy ?? '–' })}`}
	>
		{#snippet extra()}
			{#if !item!.enabled}
				<StatusBadge state="stopped" label={t('web.knowledge.disabled')} />
			{:else if item!.pinned}
				<StatusBadge state="info" label={t('web.knowledge.pinned')} />
			{/if}
		{/snippet}
		{#snippet actions()}
			<Btn icon="trash" onclick={() => (deleteOpen = true)}>{t('web.common.delete')}</Btn>
			<Btn disabled={!dirty} onclick={() => (draft = draftOf(item!))}>{t('web.common.discard')}</Btn>
			<Btn variant="primary" icon="floppyDisk" disabled={!dirty || !draft!.title.trim()} loading={saving} onclick={save}>
				{t('web.common.save')}
			</Btn>
		{/snippet}
	</PageHeader>

	{#if item.createdBy?.startsWith('mcp:')}
		<Flash kind="info">{t('web.knowledge.writtenByMcp', { actor: item.createdBy })}</Flash>
	{/if}

	<KnowledgeForm bind:draft {tokens} />

	<ConfirmModal
		bind:open={deleteOpen}
		title={t('web.knowledge.deleteTitle', { count: 1 })}
		lead={t('web.knowledge.deleteLead', { names: item.title })}
		confirmLabel={t('web.common.delete')}
		onconfirm={() => void removeConfirmed()}
	/>
{/if}
