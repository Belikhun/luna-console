<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, post } from '$lib/api';
	import Wizard from '$lib/components/Wizard.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import type { KnowledgeKind } from '$core/mcp';
	import KnowledgeForm from '../KnowledgeForm.svelte';
	import { draftBody, emptyDraft, type KnowledgeDraft } from '../knowledge';

	/** Write a new context document, memory or skill. `?kind=` and `?scope=` preset the form. */

	const KINDS: KnowledgeKind[] = ['context', 'memory', 'skill'];
	const askedKind = page.url.searchParams.get('kind') as KnowledgeKind | null;

	let draft: KnowledgeDraft = $state(
		emptyDraft(
			askedKind && KINDS.includes(askedKind) ? askedKind : 'context',
			page.url.searchParams.get('scope') ?? 'console'
		)
	);
	let tokens: Array<{ id: string; name: string }> = $state([]);
	let saving = $state(false);

	onMount(async () => {
		try {
			const data = await api('/knowledge?kind=none');

			tokens = data.tokens;
		} catch {
			// only console-wide scope can be picked until the tokens load
		}
	});

	const ready = $derived(!!draft.title.trim() && !!draft.body.trim());

	async function submit(): Promise<void> {
		saving = true;

		try {
			const result = await post('/knowledge', draftBody(draft));

			Notify.success(t('web.knowledge.created', { title: result.item.title }));
			await goto(`/console/knowledge?kind=${result.item.kind}`);
		} catch (err) {
			Notify.error(t('web.knowledge.saveFailed'), { detail: (err as Error).message });
			saving = false;
		}
	}
</script>

<Wizard
	title={t(`web.knowledge.create.${draft.kind}`)}
	description={t('web.knowledge.createDescription')}
	submitLabel={t('web.common.create')}
	disabled={!ready}
	loading={saving}
	onsubmit={submit}
>
	{#snippet summary()}
		{#if draft.title}
			<b>{draft.title}</b> · {t(`web.knowledge.kind.${draft.kind}`)}
		{:else}
			{t('web.knowledge.recapEmpty')}
		{/if}
	{/snippet}

	<KnowledgeForm bind:draft {tokens} creating />
</Wizard>
