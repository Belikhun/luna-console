<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { api, post, put } from '$lib/api';
	import { fmtDateTime } from '$lib/format';
	import { Authz } from '$lib/authz.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import type { ResourceView } from '$core/resources';
	import Panel from './Panel.svelte';
	import InfoGrid from './InfoGrid.svelte';
	import CopyValue from './CopyValue.svelte';
	import TagEditor from './TagEditor.svelte';
	import type { InfoCell } from './grid';

	/**
	 * The record the resource store keeps about one object: who made it and
	 * when, who last changed it, and its tags, editable in place.
	 *
	 * `readonly` left unset means "whatever the account may do": tagging needs
	 * `tag:Tag` on this resource, decided with the record's own facts once it
	 * has loaded, so an owner-only grant reads correctly.
	 */

	let {
		id,
		readonly
	}: {
		id: string;
		readonly?: boolean;
	} = $props();

	let resource = $state<ResourceView | null>(null);
	let failed = $state(false);
	let busy = $state(false);

	const canTag = $derived.by(() => {
		if (readonly !== undefined) {
			return !readonly;
		}

		if (!resource) {
			return false;
		}

		return Authz.can('tag:Tag', id, { tags: resource.tags, createdBy: resource.createdBy });
	});

	async function load(target: string): Promise<void> {
		failed = false;

		try {
			const data = await post<{ resources: Record<string, ResourceView> }>('/resources/describe', { ids: [target] });

			// a slower answer for a previous id must not land on the current one
			if (target === id) {
				resource = data.resources[target] ?? null;
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

	async function addTag(key: string, value: string): Promise<void> {
		busy = true;

		try {
			const result = await put<{ resource: ResourceView }>('/resources/tags', { id, tags: { [key]: value } });

			resource = result.resource;
		} catch (err) {
			Notify.error(t('web.resourceMeta.tagFailed'), { detail: (err as Error).message });
		} finally {
			busy = false;
		}
	}

	async function removeTag(key: string): Promise<void> {
		busy = true;

		try {
			const result = await api<{ resource: ResourceView }>('/resources/tags', {
				method: 'DELETE',
				body: JSON.stringify({ id, keys: [key] })
			});

			resource = result.resource;
		} catch (err) {
			Notify.error(t('web.resourceMeta.tagFailed'), { detail: (err as Error).message });
		} finally {
			busy = false;
		}
	}

	function who(name: string | null): string {
		return name ?? '–';
	}

	function when(stamp: number | null): string {
		return stamp ? fmtDateTime(stamp) : '–';
	}

	const cells: InfoCell[] = $derived([
		{ id: 'id', label: t('web.resourceMeta.id'), colSpan: 2 },
		{ label: t('web.resourceMeta.createdBy'), value: who(resource?.createdBy ?? null) },
		{ label: t('web.resourceMeta.createdAt'), value: when(resource?.createdAt ?? null) },
		{ label: t('web.resourceMeta.updatedBy'), value: who(resource?.updatedBy ?? null) },
		{ label: t('web.resourceMeta.updatedAt'), value: when(resource?.updatedAt ?? null) },
		{ id: 'tags', label: t('web.resourceMeta.tags'), colSpan: 'all' }
	]);
</script>

<Panel
	title={t('web.resourceMeta.title')}
	description={resource?.unknown ? t('web.resourceMeta.unrecorded') : undefined}
>
	{#if failed}
		<p class="none dim">{t('web.resourceMeta.loadFailed')}</p>
	{:else if !resource}
		<p class="none dim">{t('web.common.loading')}</p>
	{:else}
		<InfoGrid {cells}>
			{#snippet custom(cell)}
				{#if cell.id === 'id'}
					<CopyValue value={id} label={t('web.resourceMeta.id')} />
				{:else if cell.id === 'tags'}
					<TagEditor
						tags={resource!.tags}
						readonly={!canTag}
						{busy}
						onadd={addTag}
						onremove={removeTag}
					/>
				{/if}
			{/snippet}
		</InfoGrid>
	{/if}
</Panel>

<style lang="scss">
	.none {
		margin: 0;
		font-size: 0.8125rem;
	}
</style>
