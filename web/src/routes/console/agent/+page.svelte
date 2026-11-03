<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { api, del, patch, post, put } from '$lib/api';
	import { Agent, type AgentState, type HelperDefinition, type HelperSummary } from '$lib/agent.svelte';
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
	import DataTable from '$lib/components/DataTable.svelte';
	import type { Column } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { MCP_TOOL_GROUPS } from '$shared/mcptools';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * Mèo Béo's settings: the Claude credential it runs on, how it behaves, and
	 * the MCP token whose scope is everything it may touch, and the helpers it
	 * may hand a self-contained job to.
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
	let suggestions = $state(true);

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
			suggestions = agent.settings.suggestions;
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
				bypassAllowed !== agent.settings.bypassAllowed ||
				suggestions !== agent.settings.suggestions)
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
				bypassAllowed,
				suggestions
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

	// -- helpers -------------------------------------------------------------

	/** One row of the helpers table: a built-in, or one defined here */
	interface HelperRow extends HelperSummary {
		definition: HelperDefinition | null;
	}

	const helperRows: HelperRow[] = $derived.by(() => {
		const summaries = agent?.helpers ?? [];
		const custom = agent?.settings.subagents ?? [];

		return [
			...summaries
				.filter((helper) => helper.builtin)
				.map((helper) => ({ ...helper, definition: null })),
			...custom.map((definition) => ({
				name: definition.name,
				description: definition.description,
				builtin: false,
				tools: summaries.find((helper) => helper.name === definition.name)?.tools ?? 0,
				definition
			}))
		];
	});

	const helperColumns: Column[] = $derived([
		{ id: 'name', label: t('web.agentHelpers.name'), width: 200 },
		{ id: 'kind', label: t('web.agentHelpers.kind'), width: 140 },
		{ id: 'tools', label: t('web.agentHelpers.tools'), width: 110, align: 'right' },
		{ id: 'description', label: t('web.agentHelpers.description'), width: 420 }
	]);

	const MODEL_CHOICES = ['', 'haiku', 'sonnet', 'opus', 'fable'];

	const helperModelOptions = $derived(
		MODEL_CHOICES.map((value) => ({ value, label: value ? value : t('web.agentHelpers.modelInherit') }))
	);

	let helperOpen = $state(false);
	let helperOriginal: string | null = $state(null);
	let helperDraft: HelperDefinition = $state({ name: '', description: '', prompt: '', tools: [], model: '', enabled: true });
	let helperTools = $state('');
	let helperSaving = $state(false);
	let helperDeleting: string | null = $state(null);
	let helperDeleteOpen = $state(false);

	function editHelper(definition: HelperDefinition | null): void {
		helperOriginal = definition?.name ?? null;
		helperDraft = definition
			? { ...definition, tools: [...definition.tools] }
			: { name: '', description: '', prompt: '', tools: ['group:observe'], model: '', enabled: true };
		helperTools = helperDraft.tools.join('\n');
		helperOpen = true;
	}

	async function saveHelpers(list: HelperDefinition[]): Promise<boolean> {
		helperSaving = true;

		try {
			await patch('/agent', { subagents: list });
			await load();
			void Agent.reloadState().catch(() => {});

			return true;
		} catch (err) {
			Notify.error(t('web.agentSettings.saveFailed'), { detail: (err as Error).message });

			return false;
		} finally {
			helperSaving = false;
		}
	}

	async function submitHelper(): Promise<void> {
		const current = agent?.settings.subagents ?? [];
		const draft: HelperDefinition = {
			...helperDraft,
			name: helperDraft.name.trim(),
			tools: helperTools.split(/[\s,]+/).map((tool) => tool.trim()).filter(Boolean)
		};
		const list = helperOriginal === null
			? [...current, draft]
			: current.map((entry) => (entry.name === helperOriginal ? draft : entry));

		if (await saveHelpers(list)) {
			helperOpen = false;
		}
	}

	function helperActions(row: HelperRow): ContextMenuItem[] {
		const definition = row.definition;
		const builtinHint = t('web.agentHelpers.builtinHint');

		return [
			{
				label: t('web.agentHelpers.edit'),
				icon: 'pen',
				disabled: !definition,
				hint: definition ? undefined : builtinHint,
				action: () => editHelper(definition)
			},
			{
				label: definition?.enabled === false ? t('web.agentHelpers.enable') : t('web.agentHelpers.disable'),
				icon: definition?.enabled === false ? 'play' : 'pause',
				disabled: !definition,
				hint: definition ? undefined : builtinHint,
				action: async () => {
					if (!definition) {
						return;
					}

					await saveHelpers((agent?.settings.subagents ?? []).map((entry) =>
						entry.name === definition.name ? { ...entry, enabled: !entry.enabled } : entry
					));
				}
			},
			{ separator: true },
			{
				label: t('web.agentHelpers.remove'),
				icon: 'trash',
				color: 'danger',
				disabled: !definition,
				hint: definition ? undefined : builtinHint,
				action: () => {
					helperDeleting = row.name;
					helperDeleteOpen = true;
				}
			}
		];
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
			<span class="lbl">{t('web.agentSettings.suggestions')}</span>
			<span class="hint">{t('web.agentSettings.suggestionsHint')}</span>
			<Toggle checked={suggestions} label={t('web.agentSettings.suggestions')} onchange={(value) => (suggestions = value)} />
		</div>

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

<div class="gap"></div>

<Panel title={t('web.agentHelpers.panel')} description={t('web.agentHelpers.hint')} count={helperRows.length}>
	{#snippet actions()}
		<Btn variant="primary" icon="plus" disabled={!agent} onclick={() => editHelper(null)}>{t('web.agentHelpers.add')}</Btn>
	{/snippet}
	<DataTable
		tableId="agent-helpers"
		columns={helperColumns}
		rows={helperRows}
		getId={(row) => row.name}
		rowActions={helperActions}
		rowLabel={(row) => row.name}
		rowDim={(row) => row.definition?.enabled === false || row.tools === 0}
		emptyTitle={t('web.agentHelpers.empty')}
	>
		{#snippet cell(row, column)}
			{#if column === 'name'}
				<span class="mono">{row.name}</span>
			{:else if column === 'kind'}
				{row.builtin
					? t('web.agentHelpers.builtin')
					: row.definition?.enabled === false
						? t('web.agentHelpers.disabled')
						: t('web.agentHelpers.custom')}
			{:else if column === 'tools'}
				{row.tools}
			{:else if column === 'description'}
				<span class="dim">{row.description}</span>
			{/if}
		{/snippet}
	</DataTable>
</Panel>

<Modal title={helperOriginal ? t('web.agentHelpers.editTitle', { name: helperOriginal }) : t('web.agentHelpers.addTitle')} bind:open={helperOpen} wide>
	<div class="helper-form">
		<label class="field">
			<span class="lbl">{t('web.agentHelpers.name')}</span>
			<span class="hint">{t('web.agentHelpers.nameHint')}</span>
			<input class="input mono" type="text" maxlength="40" spellcheck="false" bind:value={helperDraft.name} />
		</label>
		<label class="field">
			<span class="lbl">{t('web.agentHelpers.description')}</span>
			<span class="hint">{t('web.agentHelpers.descriptionHint')}</span>
			<input class="input" type="text" maxlength="300" bind:value={helperDraft.description} />
		</label>
		<div class="field">
			<span class="lbl">{t('web.agentHelpers.model')}</span>
			<Select options={helperModelOptions} bind:value={helperDraft.model} width="100%" />
		</div>
		<label class="field">
			<span class="lbl">{t('web.agentHelpers.tools')}</span>
			<span class="hint">{t('web.agentHelpers.toolsHint', { groups: MCP_TOOL_GROUPS.map((group) => `group:${group}`).join(', ') })}</span>
			<textarea class="input mono" rows="4" spellcheck="false" bind:value={helperTools}></textarea>
		</label>
		<div class="field prompt">
			<span class="lbl">{t('web.agentHelpers.prompt')}</span>
			<span class="hint">{t('web.agentHelpers.promptHint')}</span>
			<CodeEditor bind:value={helperDraft.prompt} path="agent/helper.md" height="12rem" />
		</div>
	</div>
	{#snippet footer()}
		<Btn onclick={() => (helperOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn
			variant="primary"
			loading={helperSaving}
			disabled={!helperDraft.name.trim() || !helperDraft.description.trim() || !helperDraft.prompt.trim()}
			onclick={submitHelper}
		>
			{t('web.common.save')}
		</Btn>
	{/snippet}
</Modal>

<ConfirmModal
	bind:open={helperDeleteOpen}
	title={t('web.agentHelpers.removeTitle')}
	lead={t('web.agentHelpers.removeLead', { name: helperDeleting ?? '' })}
	confirmLabel={t('web.agentHelpers.remove')}
	onconfirm={() => saveHelpers((agent?.settings.subagents ?? []).filter((entry) => entry.name !== helperDeleting))}
/>

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

	.helper-form {
		display: flex;
		flex-direction: column;
		gap: 1rem;

		.field {
			display: flex;
			flex-direction: column;
			gap: 0.25rem;
		}

		// a grid, for the same reason as the instructions editor above
		.prompt {
			display: grid;
		}

		textarea {
			resize: vertical;
		}
	}
</style>
