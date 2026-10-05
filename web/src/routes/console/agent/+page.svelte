<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { api, del, patch, post, put } from '$lib/api';
	import { Agent, type AgentState } from '$lib/agent.svelte';
	import { fmtDateTime } from '$lib/format';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import type { InfoCell } from '$lib/components/grid';
	import FormGrid from '$lib/components/FormGrid.svelte';
	import Select from '$lib/components/Select.svelte';
	import Toggle from '$lib/components/Toggle.svelte';
	import Tabs from '$lib/components/Tabs.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import CodeEditor from '$lib/components/CodeEditor.svelte';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * Mèo Béo's settings: the Claude credential it runs on, how it behaves, and
	 * the MCP token whose scope is everything it may touch.
	 *
	 * The credential is pasted, never shown back. A Claude subscription connects
	 * through `claude setup-token`, Claude Code's own command for minting a
	 * long-lived token, so nothing here imitates Anthropic's sign-in page; an API
	 * key from the Anthropic Console works the same way.
	 */

	let agent = $state<AgentState | null>(null);
	let loading = $state(true);
	let lastUpdated: number | null = $state(null);
	let saving = $state(false);
	let testing = $state(false);
	let test = $state<{ ok: boolean; reply?: string; error?: string; executable: string } | null>(null);

	let enabled = $state(true);
	let model = $state('');
	let effort = $state('medium');
	let maxTurns = $state('30');
	let executable = $state('');
	let instructions = $state('');
	let bypassAllowed = $state(true);

	let connectOpen = $state(false);
	let connectKind = $state('oauth');
	let secret = $state('');
	let connecting = $state(false);
	let disconnectOpen = $state(false);

	async function load(): Promise<void> {
		loading = true;

		try {
			agent = await api<AgentState>('/agent');
			enabled = agent.settings.enabled;
			model = agent.settings.model;
			effort = agent.settings.effort;
			maxTurns = String(agent.settings.maxTurns);
			executable = agent.settings.executable;
			instructions = agent.settings.instructions;
			bypassAllowed = agent.settings.bypassAllowed;
			lastUpdated = Date.now();
		} catch (err) {
			Notify.error(t('web.agentSettings.loadFailed'), { detail: (err as Error).message });
		} finally {
			loading = false;
		}
	}

	onMount(load);

	const dirty = $derived(
		!!agent &&
			(enabled !== agent.settings.enabled ||
				model !== agent.settings.model ||
				effort !== agent.settings.effort ||
				maxTurns !== String(agent.settings.maxTurns) ||
				executable !== agent.settings.executable ||
				instructions !== agent.settings.instructions ||
				bypassAllowed !== agent.settings.bypassAllowed)
	);

	const modelOptions = $derived.by(() => {
		const options = (agent?.models ?? []).map((choice) => ({
			value: choice.value,
			label: choice.description ? `${choice.label} · ${choice.description}` : choice.label
		}));

		// a model typed in before the list knew it must stay pickable
		if (model && !options.some((option) => option.value === model)) {
			options.unshift({ value: model, label: model });
		}

		return options;
	});

	const effortOptions = $derived(
		(agent?.efforts ?? []).map((value) => ({ value, label: t(`web.agentSettings.effort_${value}`) }))
	);

	const connectTabs = $derived([
		{ id: 'oauth', label: t('web.agentSettings.kindOauth') },
		{ id: 'apikey', label: t('web.agentSettings.kindApikey') }
	]);

	const statusCells: InfoCell[] = $derived.by(() => {
		if (!agent) {
			return [];
		}

		const credential = agent.credential;

		return [
			{
				label: t('web.agentSettings.status'),
				value: agent.ready ? t('web.agentSettings.ready') : (agent.reason ?? '')
			},
			{
				label: t('web.agentSettings.credential'),
				value: credential
					? `${credential.kind === 'oauth' ? t('web.agentSettings.kindOauth') : t('web.agentSettings.kindApikey')} · ${credential.hint}`
					: t('web.agentSettings.none'),
				style: credential ? 'mono' : 'default'
			},
			{
				label: t('web.agentSettings.connectedBy'),
				value: credential
					? `${credential.setBy ?? 'root'} · ${fmtDateTime(credential.setAt)}`
					: null
			},
			{
				label: t('web.agentSettings.executable'),
				value: agent.executable.path ?? t(`web.agentSettings.exeSource_${agent.executable.source}`),
				style: agent.executable.path ? 'mono' : 'default',
				help: t(`web.agentSettings.exeSource_${agent.executable.source}`)
			}
		];
	});

	const tokenCells: InfoCell[] = $derived.by(() => {
		const token = agent?.token;

		if (!token) {
			return [{ label: t('web.agentSettings.token'), value: t('web.agentSettings.tokenPending'), colSpan: 'all' }];
		}

		return [
			{ label: t('web.agentSettings.token'), value: token.name, href: `/console/mcp/${token.id}` },
			{
				label: t('web.agentSettings.tokenState'),
				value: token.enabled ? t('web.agentSettings.tokenOn') : t('web.agentSettings.tokenOff')
			},
			{ label: t('web.agentSettings.tokenTools'), value: String(token.tools.length) },
			{
				label: t('web.agentSettings.memories'),
				value: t('web.agentSettings.memoriesLink'),
				href: `/console/knowledge?kind=memory&q=${encodeURIComponent(token.name)}`
			}
		];
	});

	async function save(): Promise<void> {
		saving = true;

		try {
			await patch('/agent', {
				enabled,
				model,
				effort,
				maxTurns: Number(maxTurns),
				executable,
				instructions,
				bypassAllowed
			});
			Notify.success(t('web.agentSettings.saved'));
			await load();
			void Agent.reloadState().catch(() => {});
		} catch (err) {
			Notify.error(t('web.agentSettings.saveFailed'), { detail: (err as Error).message });
		} finally {
			saving = false;
		}
	}

	async function connect(): Promise<void> {
		connecting = true;

		try {
			await put('/agent/credential', { value: secret });
			secret = '';
			connectOpen = false;
			Notify.success(t('web.agentSettings.connected'));
			await load();
			await runTest();
		} catch (err) {
			Notify.error(t('web.agentSettings.connectFailed'), { detail: (err as Error).message });
		} finally {
			connecting = false;
		}
	}

	async function disconnect(): Promise<void> {
		try {
			await del('/agent/credential');
			test = null;
			Notify.success(t('web.agentSettings.disconnected'));
			await load();
			void Agent.reloadState().catch(() => {});
		} catch (err) {
			Notify.error(t('web.agentSettings.saveFailed'), { detail: (err as Error).message });
		}
	}

	async function runTest(): Promise<void> {
		testing = true;
		test = null;

		try {
			test = await post('/agent/test');
			await load();
			void Agent.reloadState().catch(() => {});
		} catch (err) {
			test = { ok: false, error: (err as Error).message, executable: '' };
		} finally {
			testing = false;
		}
	}
</script>

<PageHeader title="Mèo Béo" description={t('web.agentSettings.description')}>
	{#snippet actions()}
		<RefreshControl onrefresh={load} {lastUpdated} {loading} />
		<Btn icon="plug" loading={testing} disabled={!agent?.credential} onclick={runTest}>
			{t('web.agentSettings.test')}
		</Btn>
		<Btn variant="primary" icon="cat" disabled={!agent?.ready} onclick={() => Agent.setOpen(true)}>
			{t('web.agentSettings.openChat')}
		</Btn>
	{/snippet}
</PageHeader>

{#if test}
	<div class="gap-b">
		{#if test.ok}
			<Flash kind="success" dismiss={() => (test = null)}>
				{t('web.agentSettings.testOk', { reply: test.reply ?? '' })}
			</Flash>
		{:else}
			<Flash kind="error" dismiss={() => (test = null)}>
				{t('web.agentSettings.testFailed', { error: test.error ?? '' })}
			</Flash>
		{/if}
	</div>
{/if}

<Panel title={t('web.agentSettings.connectionPanel')} description={t('web.agentSettings.connectionHint')}>
	{#snippet actions()}
		{#if agent?.credential}
			<Btn onclick={() => (disconnectOpen = true)}>{t('web.agentSettings.disconnect')}</Btn>
			<Btn icon="key" onclick={() => (connectOpen = true)}>{t('web.agentSettings.replace')}</Btn>
		{:else}
			<Btn variant="primary" icon="key" disabled={!agent} onclick={() => (connectOpen = true)}>
				{t('web.agentSettings.connect')}
			</Btn>
		{/if}
	{/snippet}
	<InfoGrid cells={statusCells} columns={[4, 2, 1]} />
</Panel>

<div class="gap"></div>

<Panel title={t('web.agentSettings.behaviourPanel')} description={t('web.agentSettings.behaviourHint')}>
	{#snippet actions()}
		<Btn variant="primary" loading={saving} disabled={!dirty} onclick={save}>{t('web.common.save')}</Btn>
	{/snippet}
	<FormGrid>
		<div class="field">
			<span class="lbl">{t('web.agentSettings.enabled')}</span>
			<span class="hint">{t('web.agentSettings.enabledHint')}</span>
			<Toggle checked={enabled} label={t('web.agentSettings.enabled')} onchange={(value) => (enabled = value)} />
		</div>

		<div class="field">
			<span class="lbl">{t('web.agentSettings.model')}</span>
			<span class="hint">
				{agent?.modelsReported ? t('web.agentSettings.modelHintReported') : t('web.agentSettings.modelHint')}
			</span>
			<Select options={modelOptions} bind:value={model} width="100%" searchable />
		</div>

		<div class="field">
			<span class="lbl">{t('web.agentSettings.effort')}</span>
			<span class="hint">{t('web.agentSettings.effortHint')}</span>
			<Select options={effortOptions} bind:value={effort} width="100%" />
		</div>

		<label class="field">
			<span class="lbl">{t('web.agentSettings.maxTurns')}</span>
			<span class="hint">{t('web.agentSettings.maxTurnsHint')}</span>
			<input class="input" type="number" min="1" max="100" bind:value={maxTurns} />
		</label>

		<div class="field">
			<span class="lbl">{t('web.agentSettings.bypassAllowed')}</span>
			<span class="hint">{t('web.agentSettings.bypassAllowedHint')}</span>
			<Toggle
				checked={bypassAllowed}
				label={t('web.agentSettings.bypassAllowed')}
				onchange={(value) => (bypassAllowed = value)}
			/>
		</div>

		<label class="field">
			<span class="lbl">{t('web.agentSettings.executablePath')}</span>
			<span class="hint">{t('web.agentSettings.executablePathHint')}</span>
			<input class="input mono" type="text" spellcheck="false" placeholder={agent?.executable.path ?? ''} bind:value={executable} />
		</label>
	</FormGrid>

	<div class="instr field">
		<span class="lbl">{t('web.agentSettings.instructions')}</span>
		<span class="hint">{t('web.agentSettings.instructionsHint')}</span>
		<CodeEditor bind:value={instructions} path="agent/instructions.md" height="14rem" />
	</div>
</Panel>

<div class="gap"></div>

<Panel title={t('web.agentSettings.handsPanel')} description={t('web.agentSettings.handsHint')}>
	<InfoGrid cells={tokenCells} columns={[4, 2, 1]} />
	<p class="note dim">{t('web.agentSettings.approvalNote')}</p>
</Panel>

<Modal title={t('web.agentSettings.connectTitle')} bind:open={connectOpen}>
	<Tabs tabs={connectTabs} bind:active={connectKind} />

	<div class="steps">
		{#if connectKind === 'oauth'}
			<ol>
				<li>{@html t('web.agentSettings.oauthStep1')}</li>
				<li>{t('web.agentSettings.oauthStep2')}</li>
				<li>{t('web.agentSettings.oauthStep3')}</li>
			</ol>
			<pre class="cmd mono">claude setup-token</pre>
			<Flash kind="warning">{t('web.agentSettings.oauthShared')}</Flash>
		{:else}
			<ol>
				<li>{@html t('web.agentSettings.apikeyStep1')}</li>
				<li>{t('web.agentSettings.apikeyStep2')}</li>
			</ol>
		{/if}

		<label class="field">
			<span class="lbl">
				{connectKind === 'oauth' ? t('web.agentSettings.pasteToken') : t('web.agentSettings.pasteKey')}
			</span>
			<input
				class="input mono"
				type="password"
				autocomplete="off"
				spellcheck="false"
				placeholder={connectKind === 'oauth' ? 'sk-ant-oat01-…' : 'sk-ant-api03-…'}
				bind:value={secret}
			/>
		</label>
		<p class="dim small">{t('web.agentSettings.writeOnly')}</p>
	</div>

	{#snippet footer()}
		<Btn onclick={() => (connectOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="primary" loading={connecting} disabled={!secret.trim()} onclick={connect}>
			{t('web.agentSettings.connect')}
		</Btn>
	{/snippet}
</Modal>

<ConfirmModal
	bind:open={disconnectOpen}
	title={t('web.agentSettings.disconnectTitle')}
	lead={t('web.agentSettings.disconnectLead')}
	confirmLabel={t('web.agentSettings.disconnect')}
	onconfirm={disconnect}
/>

<style lang="scss">
	.gap {
		height: 1rem;
	}

	.gap-b {
		margin-bottom: 1rem;
	}

	// a grid, not a flex column: the editor flexes to fill a column and would
	// shrink to nothing in one that has no height of its own
	.instr {
		display: grid;
		gap: 0.25rem;
		margin-top: 1.25rem;
	}

	.note {
		margin: 1rem 0 0;
		font-size: 0.8125rem;
	}

	.steps {
		margin-top: 1rem;

		ol {
			margin: 0 0 0.75rem;
			padding-left: 1.25rem;
			line-height: 1.6;
		}

		.field {
			display: flex;
			flex-direction: column;
			gap: 0.25rem;
			margin-top: 1rem;
		}
	}

	.cmd {
		margin: 0 0 0.75rem;
		padding: 0.5rem 0.75rem;
		background: var(--bg-terminal);
		border: 0.1rem solid var(--border-divider);
		border-radius: var(--radius-input);
		font-size: 0.8125rem;
	}

	.small {
		margin: 0.5rem 0 0;
		font-size: 0.75rem;
	}
</style>
