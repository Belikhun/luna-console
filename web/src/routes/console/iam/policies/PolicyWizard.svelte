<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { patch, post } from '$lib/api';
	import Wizard from '$lib/components/Wizard.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import FormGrid from '$lib/components/FormGrid.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import PolicyEditor from '$lib/components/PolicyEditor.svelte';
	import PolicySummaryTable from '$lib/components/PolicySummaryTable.svelte';
	import { POLICY_TEMPLATE, type PolicyEditorMode, type PolicyValidation } from '$lib/components/policyeditor';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import type { WizardStep } from '$lib/components/wizardmodal';
	import { Notify } from '$lib/notifications.svelte';
	import { policyToYaml } from '$shared/iam/yaml';
	import { IAM_NAME, policyHref, type PolicyRow } from '$lib/iam';

	/**
	 * Create or edit a managed policy, AWS's two steps: specify the permissions
	 * (the visual editor or YAML, checked by the daemon as it changes), then
	 * review them as a summary and name the policy. The YAML is what is saved;
	 * the visual editor only ever writes it.
	 */
	let {
		policy = null
	}: {
		/** the policy being edited; null creates one */
		policy?: PolicyRow | null;
	} = $props();

	const editing = untrack(() => policy !== null);
	const initialYaml = untrack(() => policy?.yaml ?? POLICY_TEMPLATE);

	let step = $state(0);
	let yaml = $state(initialYaml);
	let mode: PolicyEditorMode = $state('visual');
	let validation = $state<PolicyValidation | null>(null);
	let name = $state(untrack(() => policy?.name ?? ''));
	let description = $state(untrack(() => policy?.description ?? ''));
	let saving = $state(false);

	const nameError = $derived(name && !IAM_NAME.test(name.trim()) ? t('web.iamPolicy.nameRule') : '');

	const steps: WizardStep[] = $derived([
		{
			id: 'permissions',
			label: t('web.iamWizard.stepPermissions'),
			description: t('web.iamWizard.stepPermissionsHint'),
			blocked: !validation
				? t('web.iamWizard.writeFirst')
				: !validation.ok
					? t('web.iamWizard.fixFirst', { count: validation.issues.length })
					: ''
		},
		{
			id: 'review',
			label: editing ? t('web.iamWizard.stepReviewSave') : t('web.iamWizard.stepReviewCreate'),
			description: t('web.iamWizard.stepReviewHint'),
			blocked: !name.trim()
				? t('web.iamWizard.nameFirst')
				: nameError
		}
	]);

	const toolMenu: ContextMenuItem[] = $derived([
		{
			label: t('web.iamWizard.format'),
			icon: 'alignLeft',
			disabled: !validation?.document,
			hint: validation?.document ? undefined : t('web.iamWizard.formatHint'),
			action: () => {
				if (validation?.document) {
					yaml = policyToYaml(validation.document);
				}
			}
		},
		{
			label: t('web.iamWizard.reset'),
			icon: 'rotateLeft',
			disabled: yaml === initialYaml,
			hint: yaml === initialYaml ? t('web.iamWizard.resetHint') : undefined,
			action: () => {
				yaml = initialYaml;
				mode = 'yaml';
			}
		}
	]);

	async function submit(): Promise<void> {
		if (!validation?.ok || !name.trim() || nameError) {
			return;
		}

		saving = true;

		try {
			if (policy) {
				const body: Record<string, unknown> = { description: description.trim(), yaml };

				if (name.trim() !== policy.name) {
					body.name = name.trim();
				}

				const result = await patch(`/iam/policies/${encodeURIComponent(policy.name)}`, body);

				Notify.success(t('web.iamWizard.saved', { name: result.policy.name }));
				await goto(policyHref(result.policy.name));
			} else {
				const result = await post('/iam/policies', { name: name.trim(), description: description.trim(), yaml });

				Notify.success(t('web.iamPolicy.created', { name: result.policy.name }));
				await goto(policyHref(result.policy.name));
			}
		} catch (err) {
			Notify.error(editing ? t('web.iamPolicy.updateFailed') : t('web.iamPolicy.createFailed'), {
				detail: (err as Error).message
			});
		} finally {
			saving = false;
		}
	}
</script>

<Wizard
	title={editing ? t('web.iamWizard.editTitle', { name: policy?.name ?? '' }) : t('web.iamPolicy.newTitle')}
	description={editing ? t('web.iamWizard.editDescription') : t('web.iamPolicy.newDescription')}
	submitLabel={editing ? t('web.iamWizard.saveChanges') : t('web.iamPolicy.submit')}
	disabled={!validation?.ok || !name.trim() || !!nameError}
	loading={saving}
	onsubmit={submit}
	{steps}
	bind:step
	cancelHref={policy ? policyHref(policy.name) : '/console/iam/policies'}
>
	{#snippet summary()}
		{#if validation?.ok}
			{t('web.iamPolicy.recapStatements', { count: validation.statements })}
		{:else}
			{t('web.iamPolicy.recapInvalid')}
		{/if}
	{/snippet}

	{#if step === 0}
		<Panel title={t('web.iamWizard.editorPanel')} description={t('web.iamWizard.editorHint')}>
			<PolicyEditor
				bind:value={yaml}
				bind:mode
				showToggle
				path="iam/{name.trim() || 'policy'}.yaml"
				height="28rem"
				onvalidate={(result) => (validation = result)}
			>
				{#snippet tools()}
					<Dropdown label={t('web.common.actions')} menu={toolMenu} />
				{/snippet}
			</PolicyEditor>
		</Panel>
	{:else}
		<Panel title={t('web.iamWizard.detailsPanel')}>
			<FormGrid>
				<label class="field">
					<span class="lbl">{t('web.iamPolicy.name')}</span>
					<span class="hint">{editing ? t('web.iamPolicy.renameHint') : t('web.iamPolicy.nameHint')}</span>
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

		<Panel title={t('web.iamWizard.reviewPanel')} description={t('web.iamWizard.reviewHint')}>
			{#if validation?.document}
				<PolicySummaryTable document={validation.document} />
			{:else}
				<Flash kind="warning">{t('web.iamWizard.noDocument')}</Flash>
			{/if}
		</Panel>

		{#if !editing}
			<Flash kind="info">{t('web.iamPolicy.attachNotice')}</Flash>
		{/if}
	{/if}
</Wizard>
