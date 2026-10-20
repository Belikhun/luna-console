<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { goto } from '$app/navigation';
	import { post } from '$lib/api';
	import Wizard from '$lib/components/Wizard.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import FormGrid from '$lib/components/FormGrid.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import PolicyEditor from '$lib/components/PolicyEditor.svelte';
	import { POLICY_TEMPLATE, type PolicyValidation } from '$lib/components/policyeditor';
	import { Notify } from '$lib/notifications.svelte';
	import { IAM_NAME, policyHref } from '../../iam';

	/**
	 * Create a managed policy: a name, a line about it, and the document. The
	 * document starts as a working example and the daemon checks it as it is
	 * typed, so the submit is only open on a document that would save.
	 */

	let name = $state('');
	let description = $state('');
	let yaml = $state(POLICY_TEMPLATE);
	let validation = $state<PolicyValidation | null>(null);
	let saving = $state(false);

	const nameError = $derived(name && !IAM_NAME.test(name.trim()) ? t('web.iamPolicy.nameRule') : '');
	const ready = $derived(!!name.trim() && !nameError && !!validation?.ok);

	async function submit(): Promise<void> {
		saving = true;

		try {
			const result = await post('/iam/policies', { name: name.trim(), description: description.trim(), yaml });

			Notify.success(t('web.iamPolicy.created', { name: result.policy.name }));
			await goto(policyHref(result.policy.name));
		} catch (err) {
			Notify.error(t('web.iamPolicy.createFailed'), { detail: (err as Error).message });
		} finally {
			saving = false;
		}
	}
</script>

<Wizard
	title={t('web.iamPolicy.newTitle')}
	description={t('web.iamPolicy.newDescription')}
	submitLabel={t('web.iamPolicy.submit')}
	disabled={!ready}
	loading={saving}
	onsubmit={submit}
>
	{#snippet summary()}
		{#if name}
			<b>{name}</b>
			·
			{validation?.ok
				? t('web.iamPolicy.recapStatements', { count: validation.statements })
				: t('web.iamPolicy.recapInvalid')}
		{:else}
			{t('web.iamPolicy.recapEmpty')}
		{/if}
	{/snippet}

	<Panel title={t('web.iamPolicy.identityPanel')} description={t('web.iamPolicy.identityHint')}>
		<FormGrid>
			<label class="field">
				<span class="lbl">{t('web.iamPolicy.name')}</span>
				<span class="hint">{t('web.iamPolicy.nameHint')}</span>
				<input class="input" type="text" spellcheck="false" autocapitalize="none" bind:value={name} />
				{#if nameError}<span class="err">{nameError}</span>{/if}
			</label>

			<label class="field">
				<span class="lbl">{t('web.iamPolicy.description')}</span>
				<span class="hint">{t('web.iamPolicy.descriptionHint')}</span>
				<input class="input" type="text" bind:value={description} />
			</label>
		</FormGrid>
	</Panel>

	<div class="gap"></div>

	<Panel title={t('web.iamPolicy.documentPanel')} description={t('web.iamPolicy.documentHint')}>
		<PolicyEditor bind:value={yaml} path="iam/{name.trim() || 'policy'}.yaml" onvalidate={(result) => (validation = result)} />
	</Panel>

	<div class="gap"></div>

	<Flash kind="info">{t('web.iamPolicy.attachNotice')}</Flash>
</Wizard>

<style lang="scss">
	.gap {
		height: 1rem;
	}
</style>
