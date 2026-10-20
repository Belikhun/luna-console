<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { api, post } from '$lib/api';
	import Wizard from '$lib/components/Wizard.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import FormGrid from '$lib/components/FormGrid.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import MultiSelect from '$lib/components/MultiSelect.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import type { AccountSummary } from '$core/accounts';
	import { IAM_NAME, groupHref, policyKindLabel, type PolicyRow } from '../../iam';

	/**
	 * Create a group: a name, a line about it, and optionally who is in it and
	 * which policies it carries from the start. Both pickers are optional; a group
	 * is also fine as an empty shell filled in on its own screen.
	 */

	let name = $state('');
	let description = $state('');
	let members: string[] = $state([]);
	let policies: string[] = $state([]);
	let accounts: AccountSummary[] = $state([]);
	let catalog: PolicyRow[] = $state([]);
	let saving = $state(false);

	onMount(async () => {
		try {
			const [accountData, policyData] = await Promise.all([api('/accounts'), api('/iam/policies')]);

			accounts = accountData.accounts;
			catalog = policyData.policies;
		} catch (err) {
			Notify.error(t('web.iam.loadFailed'), { detail: (err as Error).message });
		}
	});

	const accountOptions = $derived(accounts.map((account) => ({ value: account.id, label: account.username })));

	const policyOptions = $derived(
		catalog.map((policy) => ({ value: policy.name, label: `${policy.name} (${policyKindLabel(policy)})` }))
	);

	const nameError = $derived(name && !IAM_NAME.test(name.trim()) ? t('web.iamGroup.nameRule') : '');
	const ready = $derived(!!name.trim() && !nameError);

	async function submit(): Promise<void> {
		saving = true;

		try {
			const result = await post('/iam/groups', {
				name: name.trim(),
				description: description.trim(),
				members,
				policies
			});

			Notify.success(t('web.iamGroup.created', { name: result.group.name }));
			await goto(groupHref(result.group.name));
		} catch (err) {
			Notify.error(t('web.iamGroup.createFailed'), { detail: (err as Error).message });
		} finally {
			saving = false;
		}
	}
</script>

<Wizard
	title={t('web.iamGroup.newTitle')}
	description={t('web.iamGroup.newDescription')}
	submitLabel={t('web.iamGroup.submit')}
	disabled={!ready}
	loading={saving}
	onsubmit={submit}
>
	{#snippet summary()}
		{#if name}
			<b>{name}</b>
			·
			{t('web.iamGroup.recapMembers', { count: members.length })}
			·
			{t('web.iamGroup.recapPolicies', { count: policies.length })}
		{:else}
			{t('web.iamGroup.recapEmpty')}
		{/if}
	{/snippet}

	<Panel title={t('web.iamGroup.identityPanel')} description={t('web.iamGroup.identityHint')}>
		<FormGrid>
			<label class="field">
				<span class="lbl">{t('web.iamGroup.name')}</span>
				<span class="hint">{t('web.iamGroup.nameHint')}</span>
				<input class="input" type="text" spellcheck="false" autocapitalize="none" bind:value={name} />
				{#if nameError}<span class="err">{nameError}</span>{/if}
			</label>

			<label class="field">
				<span class="lbl">{t('web.iamGroup.description')}</span>
				<span class="hint">{t('web.iamGroup.descriptionHint')}</span>
				<input class="input" type="text" bind:value={description} />
			</label>
		</FormGrid>
	</Panel>

	<div class="gap"></div>

	<Panel title={t('web.iamGroup.membersPanel')} description={t('web.iamGroup.membersHint')}>
		<div class="field">
			<span class="lbl">{t('web.iamGroup.members')}</span>
			<MultiSelect
				options={accountOptions}
				bind:value={members}
				width="100%"
				placeholder={t('web.iamGroup.noMembersPicked')}
			/>
		</div>
	</Panel>

	<div class="gap"></div>

	<Panel title={t('web.iamGroup.policiesPanel')} description={t('web.iamGroup.policiesHint')}>
		<div class="field">
			<span class="lbl">{t('web.iamGroup.policies')}</span>
			<MultiSelect
				options={policyOptions}
				bind:value={policies}
				width="100%"
				placeholder={t('web.iamGroup.noPoliciesPicked')}
			/>
		</div>
	</Panel>

	<div class="gap"></div>

	<Flash kind="info">{t('web.iamGroup.inlineNotice')}</Flash>
</Wizard>

<style lang="scss">
	.gap {
		height: 1rem;
	}
</style>
