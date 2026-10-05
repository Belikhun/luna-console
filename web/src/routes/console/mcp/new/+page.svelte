<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, post } from '$lib/api';
	import { copyText } from '$lib/clipboard';
	import Wizard from '$lib/components/Wizard.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import FormGrid from '$lib/components/FormGrid.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Select from '$lib/components/Select.svelte';
	import McpScopeEditor from '$lib/components/McpScopeEditor.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import { allowedTools, defaultMcpScope, type McpScope } from '$shared/mcptools';
	import { clientSnippet } from '../mcp';

	/**
	 * Mint an MCP token. The scope starts read-only (observe + knowledge): a token
	 * is handed to a program, and widening it is a decision somebody should make
	 * on purpose rather than inherit from a default.
	 */

	const TOKEN_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
	const DAY_MS = 24 * 60 * 60 * 1000;

	let name = $state('');
	let description = $state('');
	let expiry = $state('never');
	let scope: McpScope = $state(defaultMcpScope());
	let instances: string[] = $state([]);
	let saving = $state(false);

	let bearer = $state('');
	let createdId = $state('');
	let copied = $state(false);
	let doneOpen = $state(false);

	onMount(async () => {
		try {
			const data = await api('/instances');

			instances = data.instances.map((row: { name: string }) => row.name);
		} catch {
			// the picker just stays empty; the limit is still editable on the token later
		}
	});

	const expiryOptions = $derived([
		{ value: 'never', label: t('web.mcpNew.expiryNever') },
		{ value: '7', label: t('web.mcpNew.expiryDays', { days: 7 }) },
		{ value: '30', label: t('web.mcpNew.expiryDays', { days: 30 }) },
		{ value: '90', label: t('web.mcpNew.expiryDays', { days: 90 }) },
		{ value: '365', label: t('web.mcpNew.expiryDays', { days: 365 }) }
	]);

	const nameError = $derived(name && !TOKEN_NAME.test(name.trim()) ? t('web.mcpNew.nameRule') : '');
	const toolCount = $derived(allowedTools(scope).length);
	const ready = $derived(!!name.trim() && !nameError);

	async function submit(): Promise<void> {
		saving = true;

		const expiresAt = expiry === 'never'
			? null
			: Date.now() + Number(expiry) * DAY_MS;

		try {
			const result = await post('/mcp-tokens', { name: name.trim(), description, expiresAt, scope });

			bearer = result.bearer;
			createdId = result.token.id;
			doneOpen = true;
		} catch (err) {
			Notify.error(t('web.mcpNew.failed'), { detail: (err as Error).message });
		} finally {
			saving = false;
		}
	}

	async function copySnippet(): Promise<void> {
		copied = await copyText(clientSnippet(page.url.origin, bearer));
	}

	async function copyBearer(): Promise<void> {
		copied = await copyText(bearer);
	}

	async function finish(): Promise<void> {
		doneOpen = false;

		await goto(`/console/mcp/${createdId}`);
	}
</script>

<Wizard
	title={t('web.mcpNew.title')}
	description={t('web.mcpNew.description')}
	submitLabel={t('web.mcpNew.submit')}
	disabled={!ready || !!bearer}
	loading={saving}
	onsubmit={submit}
>
	{#snippet summary()}
		{#if name}
			<b>{name}</b>
			·
			{t('web.mcpNew.recapTools', { count: toolCount })}
			·
			{scope.instances === null
				? t('web.mcp.everyInstance')
				: t('web.mcpNew.recapInstances', { count: scope.instances.length })}
		{:else}
			{t('web.mcpNew.recapEmpty')}
		{/if}
	{/snippet}

	<Panel title={t('web.mcpNew.identityPanel')} description={t('web.mcpNew.identityHint')}>
		<FormGrid>
			<label class="field">
				<span class="lbl">{t('web.mcpNew.name')}</span>
				<span class="hint">{t('web.mcpNew.nameHint')}</span>
				<input class="input" type="text" spellcheck="false" bind:value={name} />
				{#if nameError}<span class="err">{nameError}</span>{/if}
			</label>

			<label class="field">
				<span class="lbl">{t('web.mcpNew.purpose')}</span>
				<span class="hint">{t('web.mcpNew.purposeHint')}</span>
				<input class="input" type="text" bind:value={description} />
			</label>

			<div class="field">
				<span class="lbl">{t('web.mcpNew.expiry')}</span>
				<span class="hint">{t('web.mcpNew.expiryHint')}</span>
				<Select options={expiryOptions} bind:value={expiry} />
			</div>
		</FormGrid>
	</Panel>

	<div class="gap"></div>

	<Panel title={t('web.mcpNew.scopePanel')} description={t('web.mcpNew.scopeHint')}>
		<McpScopeEditor bind:scope {instances} />
	</Panel>

	<div class="gap"></div>

	<Flash kind="info">{t('web.mcpNew.onceNotice')}</Flash>
</Wizard>

<Modal title={t('web.mcpNew.createdTitle', { name })} bind:open={doneOpen} dismissable={false}>
	<Flash kind="warning">{t('web.mcp.bearerOnceOnly')}</Flash>
	<div class="secret">
		<code class="mono">{bearer}</code>
	</div>
	<p class="modalnote dim">{t('web.mcp.snippetHint')}</p>
	<pre class="snippet mono">{clientSnippet(page.url.origin, bearer)}</pre>

	{#snippet footer()}
		<Btn icon={copied ? 'circleCheck' : 'copy'} onclick={copySnippet}>
			{copied ? t('web.common.copied') : t('web.mcp.copySnippet')}
		</Btn>
		<Btn icon="key" onclick={copyBearer}>
			{t('web.mcpNew.copyBearer')}
		</Btn>
		<Btn variant="primary" onclick={finish}>{t('web.common.done')}</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.gap {
		height: 1rem;
	}

	.modalnote {
		margin: 0.75rem 0;
		font-size: 0.8125rem;
	}

	.secret code {
		display: block;
		margin-top: 0.75rem;
		overflow-wrap: anywhere;
		background: var(--bg-input);
		border: 0.1rem solid var(--border-input);
		border-radius: var(--radius-input);
		padding: 0.5rem 0.75rem;
		font-size: 0.8125rem;
	}

	.snippet {
		margin: 0;
		padding: 0.75rem;
		background: var(--bg-terminal);
		border: 0.1rem solid var(--border-divider);
		border-radius: var(--radius-input);
		font-size: 0.75rem;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
