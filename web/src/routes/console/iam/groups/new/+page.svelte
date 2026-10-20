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
	import AccountPickTable from '$lib/components/AccountPickTable.svelte';
	import PolicyPickTable from '$lib/components/PolicyPickTable.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import { IAM_NAME, groupHref, type PolicyRow } from '$lib/iam';
	import type { AccountSummary } from '$core/accounts';

	/**
	 * Create a user group, AWS's single page: name it, pick the accounts that
	 * start in it and the policies it carries. Both tables are optional; a group
	 * can start empty and be filled on its own screen.
	 */

	let name = $state('');
	let description = $state('');
	let members: Set<string> = $state(new Set());
	let policies: Set<string> = $state(new Set());
	let accounts: AccountSummary[] = $state([]);
	let catalog: PolicyRow[] = $state([]);
	let saving = $state(false);

	onMount(async () => {
		try {
			const [accountData, policyData] = await Promise.all([
				api<{ accounts: AccountSummary[] }>('/accounts'),
				api<{ policies: PolicyRow[] }>('/iam/policies')
			]);

			accounts = accountData.accounts;
			catalog = policyData.policies;
		} catch (err) {
			Notify.error(t('web.iam.loadFailed'), { detail: (err as Error).message });
		}
	});

	const nameError = $derived(name && !IAM_NAME.test(name.trim()) ? t('web.iamGroup.nameRule') : '');
	const ready = $derived(!!name.trim() && !nameError);

	async function submit(): Promise<void> {
		saving = true;

		try {
			const result = await post('/iam/groups', {
				name: name.trim(),
				description: description.trim(),
				members: [...members],
				policies: [...policies]
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
		{#if name.trim()}
			<b>{name.trim()}</b>
			·
			{t('web.iamGroup.recapMembers', { count: members.size })}
			·
			{t('web.iamGroup.recapPolicies', { count: policies.size })}
		{:else}
			{t('web.iamGroup.recapEmpty')}
		{/if}
	{/snippet}

	<Panel title={t('web.iamGroupNew.namePanel')}>
		<FormGrid>
			<label class="field">
				<span class="lbl">{t('web.iamGroupNew.groupName')}</span>
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

	<Panel
		title={t('web.iamGroupNew.usersPanel')}
		count={members.size ? `${members.size}/${accounts.length}` : accounts.length}
		description={t('web.iamGroupNew.usersHint')}
		flush
	>
		<AccountPickTable tableId="iam-group-new-users" {accounts} bind:selected={members} />
	</Panel>

	<Panel
		title={t('web.iamGroupNew.policiesPanel')}
		count={policies.size ? `${policies.size}/${catalog.length}` : catalog.length}
		description={t('web.iamGroupNew.policiesHint')}
		flush
	>
		<PolicyPickTable tableId="iam-group-new-policies" policies={catalog} bind:selected={policies} />
	</Panel>
</Wizard>
