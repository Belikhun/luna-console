<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import { clearCrumbLabel, setCrumbLabel } from '$lib/crumbs.svelte';
	import { policyHref, type PolicyRow } from '$lib/iam';
	import PolicyWizard from '../../PolicyWizard.svelte';

	/**
	 * Edit a managed policy: the same two steps as creating one, starting from
	 * the saved document. A built-in policy is code and cannot be edited.
	 */

	const name = $derived(page.params.name ?? '');

	let policy = $state<PolicyRow | null>(null);
	let failed = $state('');

	onMount(async () => {
		try {
			const data = await api<{ policy: PolicyRow }>(`/iam/policies/${encodeURIComponent(name)}`);

			policy = data.policy;
		} catch (err) {
			failed = (err as Error).message;
		}
	});

	$effect(() => {
		if (!policy) {
			return;
		}

		const path = policyHref(name);

		setCrumbLabel(path, policy.name);

		return () => clearCrumbLabel(path);
	});
</script>

{#if failed}
	<PageHeader title={name} description={t('web.iamPolicy.kind')} />
	<Flash kind="error">
		{t('web.iamPolicy.notFound', { name })}
		<a href="/console/iam/policies">{t('web.iamList.backToPolicies')}</a>
	</Flash>
{:else if policy?.builtin}
	<PageHeader title={policy.name} description={t('web.iamPolicy.kind')} />
	<Flash kind="info">
		{t('web.iam.builtinNoEdit')}
		<a href={policyHref(policy.name)}>{t('web.iamWizard.backToPolicy')}</a>
	</Flash>
{:else if policy}
	<PolicyWizard {policy} />
{/if}
