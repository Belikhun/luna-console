<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import FormGrid from '$lib/components/FormGrid.svelte';
	import Select from '$lib/components/Select.svelte';
	import Toggle from '$lib/components/Toggle.svelte';
	import CodeEditor from '$lib/components/CodeEditor.svelte';
	import type { KnowledgeDraft } from './knowledge';

	/**
	 * The fields of one knowledge item, shared by the create and edit screens. The
	 * kind is fixed once an item exists (a memory does not become a skill), so the
	 * kind picker only shows while creating.
	 */
	let {
		draft = $bindable(),
		tokens,
		creating = false
	}: {
		draft: KnowledgeDraft;
		tokens: Array<{ id: string; name: string }>;
		creating?: boolean;
	} = $props();

	const kindOptions = $derived([
		{ value: 'context', label: t('web.knowledge.kind.context') },
		{ value: 'memory', label: t('web.knowledge.kind.memory') },
		{ value: 'skill', label: t('web.knowledge.kind.skill') }
	]);

	const scopeOptions = $derived([
		{ value: 'console', label: t('web.knowledge.scopeConsole') },
		...tokens.map((token) => ({ value: token.id, label: t('web.knowledge.scopeToken', { name: token.name }) }))
	]);

	const titleLabel = $derived(draft.kind === 'skill' ? t('web.knowledge.skillName') : t('web.knowledge.title'));
	const titleHint = $derived(draft.kind === 'skill' ? t('web.knowledge.skillNameHint') : t('web.knowledge.titleHint'));
</script>

<Panel title={t('web.knowledge.fieldsPanel')} description={t(`web.knowledge.kindHint.${draft.kind}`)}>
	<FormGrid>
		{#if creating}
			<div class="field">
				<span class="lbl">{t('web.knowledge.colKind')}</span>
				<Select options={kindOptions} bind:value={draft.kind} />
			</div>
		{/if}

		<div class="field">
			<span class="lbl">{t('web.knowledge.colScope')}</span>
			<span class="hint">{t('web.knowledge.scopeHint')}</span>
			<Select options={scopeOptions} bind:value={draft.scope} searchable />
		</div>

		<label class="field">
			<span class="lbl">{titleLabel}</span>
			<span class="hint">{titleHint}</span>
			<input class="input" type="text" spellcheck={draft.kind !== 'skill'} bind:value={draft.title} />
		</label>

		<label class="field">
			<span class="lbl">{t('web.knowledge.description')}</span>
			<span class="hint">{t(`web.knowledge.descriptionHint.${draft.kind}`)}</span>
			<input class="input" type="text" bind:value={draft.description} />
		</label>

		<label class="field">
			<span class="lbl">{t('web.knowledge.tags')}</span>
			<span class="hint">{t('web.knowledge.tagsHint')}</span>
			<input class="input" type="text" spellcheck="false" bind:value={draft.tags} />
		</label>

		<div class="field toggles">
			<label class="toggle">
				<Toggle checked={draft.pinned} label={t('web.knowledge.pinned')} onchange={(value) => (draft.pinned = value)} />
				<span>{t('web.knowledge.pinned')}</span>
			</label>
			<span class="hint">{t('web.knowledge.pinnedHint')}</span>

			<label class="toggle">
				<Toggle checked={draft.enabled} label={t('web.knowledge.enabled')} onchange={(value) => (draft.enabled = value)} />
				<span>{t('web.knowledge.enabled')}</span>
			</label>
		</div>
	</FormGrid>
</Panel>

<div class="gap"></div>

<Panel title={t('web.knowledge.bodyPanel')} description={t('web.knowledge.bodyHint')}>
	<CodeEditor bind:value={draft.body} path="knowledge/{draft.kind}.md" height="24rem" />
</Panel>

<style lang="scss">
	.gap {
		height: 1rem;
	}

	.toggles {
		gap: 0.5rem;
	}

	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.875rem;
		cursor: pointer;
	}
</style>
