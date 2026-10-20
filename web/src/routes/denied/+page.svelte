<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { page } from '$app/state';
	import { t } from '$lib/i18n.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import type { InfoCell } from '$lib/components/grid';

	/**
	 * Where a refused navigation lands. The gate names the action and the resource
	 * it needed, so the operator can ask whoever manages policies for exactly
	 * that, rather than for "access".
	 */

	const action = $derived(page.url.searchParams.get('action') ?? '');
	const resource = $derived(page.url.searchParams.get('resource') ?? '');
	const next = $derived(page.url.searchParams.get('next') ?? '');

	const cells: InfoCell[] = $derived([
		{ id: 'action', label: t('web.denied.action'), value: action || '—' },
		{ id: 'resource', label: t('web.denied.resource'), value: resource || t('web.denied.noResource') },
		{ id: 'page', label: t('web.denied.page'), value: next || '—' }
	]);
</script>

<svelte:head>
	<title>{t('web.denied.title')}</title>
</svelte:head>

<PageHeader title={t('web.denied.title')} description={t('web.denied.description')} />

<Flash kind="warning">{t('web.denied.notice', { action: action || '?' })}</Flash>

<div class="gap"></div>

<Panel title={t('web.denied.whatWasAsked')}>
	<InfoGrid {cells} />

	<div class="actions">
		<Btn href="/instances" icon="arrowLeft">{t('web.denied.back')}</Btn>
	</div>
</Panel>

<style lang="scss">
	.gap {
		height: 1rem;
	}

	.actions {
		margin-top: 1rem;
	}
</style>
