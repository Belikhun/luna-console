<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import { api, post } from '$lib/api';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Select from '$lib/components/Select.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import SearchInput from '$lib/components/SearchInput.svelte';
	import type { Column } from '$lib/components/table';
	import { Notify } from '$lib/notifications.svelte';
	import { IAM_SERVICES, actionLabelKey, actionsOf, type IamActionSpec } from '$shared/iam/actions';
	import { policySourceKey, type AttachedDocument } from '$shared/iam/grammar';
	import { serviceLabel, serviceResourceType } from '$lib/components/policyvisual';
	import { POLICY_KIND_ICONS, groupHref, policyHref, policyKindLabel } from '$lib/iam';
	import type { AccountSummary } from '$core/accounts';
	import type { AccountPermissions, SimulationResult } from '$core/iam';

	/**
	 * The policy simulator, AWS's: pick an account, choose which of the policies
	 * that reach it take part, pick a service and its actions, name a resource
	 * (and, to test conditions, stand-in tags or a creator), and see what the
	 * console would decide for each action and which statement decided it.
	 * Nothing is changed by running it.
	 */

	interface ResultRow {
		key: string;
		action: string;
		result: SimulationResult;
	}

	let accounts: AccountSummary[] = $state([]);
	let account = $state(page.url.searchParams.get('account') ?? '');
	let permissions = $state<AccountPermissions | null>(null);
	let permissionsError = $state('');
	let included: Set<string> = $state(new Set());

	let service = $state(IAM_SERVICES[0] ?? 'instance');
	let actionFilter = $state('');
	let actions: Set<string> = $state(new Set());
	let resource = $state('');
	let creator = $state('');
	let resourceTags = $state('');
	let requestTags = $state('');

	let running = $state(false);
	let results: ResultRow[] = $state([]);
	let ranFor = $state('');

	onMount(async () => {
		try {
			const data = await api<{ accounts: AccountSummary[] }>('/accounts');

			accounts = data.accounts;
		} catch (err) {
			Notify.error(t('web.iamSimulator.accountsFailed'), { detail: (err as Error).message });
		}

		if (account) {
			await loadPermissions();
		}
	});

	async function loadPermissions(): Promise<void> {
		permissions = null;
		permissionsError = '';
		results = [];

		if (!account) {
			return;
		}

		const found = accounts.find((entry) => entry.username === account);

		try {
			const data = await api<{ permissions: AccountPermissions }>(
				`/accounts/${encodeURIComponent(found?.id ?? account)}/permissions`
			);

			permissions = data.permissions;
			included = new Set(data.permissions.effective.map((entry) => policySourceKey(entry.source)));
		} catch (err) {
			permissionsError = (err as Error).message;
		}
	}

	function pickAccount(value: string): void {
		account = value;

		const url = new URL(page.url);

		url.searchParams.set('account', value);
		replaceState(url, page.state);
		void loadPermissions();
	}

	const accountOptions = $derived(
		accounts.map((entry) => ({
			value: entry.username,
			label: entry.displayName ? `${entry.username} (${entry.displayName})` : entry.username
		}))
	);

	const serviceOptions = $derived(
		IAM_SERVICES.map((name) => ({ value: name, label: `${serviceLabel(name)} (${name})` }))
	);

	function pickService(value: string): void {
		service = value;
		actions = new Set();
		actionFilter = '';
	}

	function actionText(spec: IamActionSpec): string {
		const key = actionLabelKey(spec);
		const label = t(key);

		return label === key
			? spec.verb
			: label;
	}

	const serviceActions = $derived(actionsOf(service));

	const shownActions = $derived(
		actionFilter.trim()
			? serviceActions.filter(
					(spec) =>
						spec.name.toLowerCase().includes(actionFilter.trim().toLowerCase()) ||
						actionText(spec).toLowerCase().includes(actionFilter.trim().toLowerCase())
				)
			: serviceActions
	);

	const allPicked = $derived(serviceActions.length > 0 && serviceActions.every((spec) => actions.has(spec.name)));

	function toggleAction(name: string, checked: boolean): void {
		const next = new Set(actions);

		if (checked) {
			next.add(name);
		} else {
			next.delete(name);
		}

		actions = next;
	}

	function toggleAllActions(checked: boolean): void {
		actions = checked
			? new Set(serviceActions.map((spec) => spec.name))
			: new Set();
	}

	const resourceType = $derived(serviceResourceType(service));

	/** `key=value` per line (or comma separated) into a tag map; blank lines are skipped. */
	function parseTags(text: string): Record<string, string> | undefined {
		const out: Record<string, string> = {};

		for (const part of text.split(/[\n,]/)) {
			const trimmed = part.trim();

			if (!trimmed) {
				continue;
			}

			const equals = trimmed.indexOf('=');

			if (equals <= 0) {
				continue;
			}

			out[trimmed.slice(0, equals).trim()] = trimmed.slice(equals + 1).trim();
		}

		return Object.keys(out).length > 0 ? out : undefined;
	}

	const effective: AttachedDocument[] = $derived(permissions?.effective ?? []);

	const blocked = $derived(
		!account
			? t('web.iamSimulator.pickAccount')
			: actions.size === 0
				? t('web.iamSimulator.pickActions')
				: ''
	);

	async function run(): Promise<void> {
		if (blocked) {
			return;
		}

		running = true;

		const all = effective.every((entry) => included.has(policySourceKey(entry.source)));

		try {
			const data = await post<{ results: SimulationResult[] }>('/iam/simulate', {
				account,
				actions: [...actions],
				resource: resource.trim() || undefined,
				policies: all ? undefined : [...included],
				resourceCreator: creator.trim() || undefined,
				resourceTags: parseTags(resourceTags),
				requestTags: parseTags(requestTags)
			});

			results = data.results.map((result, index) => ({
				key: `${index}:${result.request.action}`,
				action: result.request.action,
				result
			}));

			ranFor = account;
		} catch (err) {
			Notify.error(t('web.iamSimulator.runFailed'), { detail: (err as Error).message });
		} finally {
			running = false;
		}
	}

	const reasonLabels: Record<string, string> = $derived({
		allow: t('web.iamSimulator.reasonAllow'),
		'explicit-deny': t('web.iamSimulator.reasonExplicitDeny'),
		'implicit-deny': t('web.iamSimulator.reasonImplicitDeny'),
		root: t('web.iamSimulator.reasonRoot')
	});

	const allowedCount = $derived(results.filter((row) => row.result.verdict.allowed).length);

	const policyColumns: Column[] = $derived([
		{ id: 'name', label: t('web.iamList.colPolicyName'), width: 220 },
		{ id: 'via', label: t('web.permissionsPanel.colAttachedVia') }
	]);

	const resultColumns: Column[] = $derived([
		{ id: 'action', label: t('web.iamSimulator.colAction'), sortable: true, width: 220 },
		{ id: 'resource', label: t('web.iamSimulator.colResource'), width: 220 },
		{ id: 'permission', label: t('web.iamSimulator.colPermission'), sortable: true, width: 130 },
		{ id: 'reason', label: t('web.iamSimulator.colReason'), sortable: true, width: 170 },
		{ id: 'matched', label: t('web.iamSimulator.colMatched') }
	]);
</script>

<svelte:head><title>{t('web.iamSimulator.title')} | Luna Console</title></svelte:head>

<PageHeader title={t('web.iamSimulator.title')} description={t('web.iamSimulator.description')} info>
	{#snippet actions()}
		<Btn icon="close" disabled={results.length === 0} onclick={() => (results = [])}>
			{t('web.iamSimulator.clear')}
		</Btn>
		<Btn variant="primary" icon="play" loading={running} disabled={!!blocked} title={blocked || undefined} onclick={() => void run()}>
			{t('web.iamSimulator.run')}
		</Btn>
	{/snippet}
</PageHeader>

<div class="layout">
	<div class="column">
		<Panel title={t('web.iamSimulator.principalPanel')} description={t('web.iamSimulator.principalHint')}>
			<Select
				label={t('web.iamSimulator.account')}
				value={account}
				options={accountOptions}
				width="100%"
				searchable
				onchange={pickAccount}
			/>
		</Panel>

		{#if permissionsError}
			<Flash kind="error">{t('web.iamSimulator.permissionsFailed', { detail: permissionsError })}</Flash>
		{:else if permissions}
			<Panel
				title={t('web.iamSimulator.policiesPanel')}
				count={`${included.size}/${effective.length}`}
				description={t('web.iamSimulator.policiesHint')}
				flush
			>
				<DataTable
					columns={policyColumns}
					rows={effective}
					getId={(row) => policySourceKey(row.source)}
					selectable="multi"
					bind:selected={included}
					emptyTitle={t('web.iamSimulator.noPolicies')}
				>
					{#snippet cell(row, col)}
						{#if col === 'name'}
							<span class="pname">
								<Icon name={POLICY_KIND_ICONS[row.source.kind]} size="0.875rem" style={row.source.kind === 'builtin' ? 'solid' : 'regular'} />
								{#if row.source.kind === 'inline'}
									<b class="mono">{row.source.name}</b>
								{:else}
									<a href={policyHref(row.source.name)} target="_blank" rel="noopener">{row.source.name}</a>
								{/if}
							</span>
						{:else if col === 'via'}
							{#if row.source.group}
								<span>{t('web.permissionsPanel.viaGroup')} <a href={groupHref(row.source.group)}>{row.source.group}</a></span>
							{:else}
								<span class="dim">{policyKindLabel(row.source.kind)} · {t('web.permissionsPanel.directly')}</span>
							{/if}
						{/if}
					{/snippet}
				</DataTable>
			</Panel>
		{:else if account}
			<p class="dim">{t('web.common.loading')}</p>
		{/if}
	</div>

	<div class="column">
		<Panel title={t('web.iamSimulator.requestPanel')} description={t('web.iamSimulator.requestHint')}>
			<div class="form">
				<Select
					label={t('web.iamSimulator.service')}
					value={service}
					options={serviceOptions}
					width="22rem"
					searchable
					onchange={pickService}
				/>

				<div class="actions-head">
					<label class="choice">
						<Checkbox
							checked={allPicked}
							indeterminate={actions.size > 0 && !allPicked}
							label={t('web.iamSimulator.selectAll')}
							onchange={toggleAllActions}
						/>
						<b>{t('web.iamSimulator.actions', { picked: actions.size, total: serviceActions.length })}</b>
					</label>
					<SearchInput bind:value={actionFilter} placeholder={t('web.policyVisual.filterActions')} width="16rem" />
				</div>

				<div class="action-list">
					{#each shownActions as spec (spec.name)}
						<label class="choice">
							<Checkbox
								checked={actions.has(spec.name)}
								label={spec.name}
								onchange={(checked) => toggleAction(spec.name, checked)}
							/>
							<span class="atext">
								<span class="mono">{spec.name}</span>
								<span class="dim">{actionText(spec)}</span>
							</span>
						</label>
					{/each}
				</div>

				<label class="field">
					<span class="lbl">{t('web.iamSimulator.resource')}</span>
					<span class="hint">
						{resourceType
							? t('web.iamSimulator.resourceHint', { type: resourceType })
							: t('web.iamSimulator.resourceNone')}
					</span>
					<input
						class="input mono"
						type="text"
						spellcheck="false"
						autocapitalize="none"
						disabled={!resourceType}
						placeholder={resourceType ? `luna:${resourceType}/…` : ''}
						bind:value={resource}
					/>
				</label>

				<details class="abac">
					<summary>{t('web.iamSimulator.abac')}</summary>
					<p class="dim">{t('web.iamSimulator.abacHint')}</p>
					<label class="field">
						<span class="lbl">{t('web.iamSimulator.creator')}</span>
						<input class="input mono" type="text" spellcheck="false" bind:value={creator} />
					</label>
					<label class="field">
						<span class="lbl">{t('web.iamSimulator.resourceTags')}</span>
						<span class="hint">{t('web.iamSimulator.tagsHint')}</span>
						<textarea class="input mono" rows="3" spellcheck="false" bind:value={resourceTags}></textarea>
					</label>
					<label class="field">
						<span class="lbl">{t('web.iamSimulator.requestTags')}</span>
						<span class="hint">{t('web.iamSimulator.tagsHint')}</span>
						<textarea class="input mono" rows="3" spellcheck="false" bind:value={requestTags}></textarea>
					</label>
				</details>

				<div class="runrow">
					{#if blocked}
						<span class="dim">{blocked}</span>
					{/if}
					<Btn variant="primary" icon="play" loading={running} disabled={!!blocked} onclick={() => void run()}>
						{t('web.iamSimulator.run')}
					</Btn>
				</div>
			</div>
		</Panel>
	</div>
</div>

<div class="gap"></div>

<Panel
	title={t('web.iamSimulator.resultsPanel')}
	count={results.length ? `${allowedCount}/${results.length}` : undefined}
	description={ranFor ? t('web.iamSimulator.resultsFor', { account: ranFor }) : t('web.iamSimulator.resultsHint')}
	flush
>
	<DataTable
		columns={resultColumns}
		rows={results}
		getId={(row) => row.key}
		sortValue={(row, col) =>
			col === 'action'
				? row.action
				: col === 'permission'
					? (row.result.verdict.allowed ? 0 : 1)
					: col === 'reason'
						? row.result.verdict.reason
						: null}
		emptyTitle={t('web.iamSimulator.noResults')}
		emptyText={t('web.iamSimulator.noResultsText')}
	>
		{#snippet cell(row, col)}
			{#if col === 'action'}
				<span class="mono">{row.action}</span>
			{:else if col === 'resource'}
				<span class="mono" class:dim={!row.result.request.resource}>
					{row.result.request.resource ?? t('web.iamSimulator.noResource')}
				</span>
			{:else if col === 'permission'}
				<StatusBadge
					state={row.result.verdict.allowed ? 'ok' : 'failed'}
					label={row.result.verdict.allowed ? t('web.iamSimulator.allowed') : t('web.iamSimulator.denied')}
				/>
			{:else if col === 'reason'}
				{reasonLabels[row.result.verdict.reason] ?? row.result.verdict.reason}
			{:else if col === 'matched'}
				{@const matched = row.result.verdict.matched}
				{#if matched}
					<span class="matched">
						{#if matched.source.kind === 'inline'}
							<b class="mono">{matched.source.name}</b>
						{:else}
							<a href={policyHref(matched.source.name)}>{matched.source.name}</a>
						{/if}
						<span class="mono dim">
							{matched.sid
								? t('web.iamSimulator.sid', { sid: matched.sid })
								: t('web.iamSimulator.statement', { index: matched.index + 1 })}
						</span>
						{#if matched.source.group}
							<span class="dim">{t('web.iamSimulator.viaGroup', { group: matched.source.group })}</span>
						{/if}
					</span>
				{:else}
					<span class="dim">{t('web.iamSimulator.noStatement')}</span>
				{/if}
			{/if}
		{/snippet}
	</DataTable>
</Panel>

<style lang="scss">
	.layout {
		display: grid;
		grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
		gap: 1rem;
		align-items: start;

		@include below($bp-medium) {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.column {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		min-width: 0;
	}

	.gap {
		height: 1rem;
	}

	.pname,
	.matched {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}

	.form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.actions-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		flex-wrap: wrap;
	}

	.choice {
		display: inline-flex;
		align-items: flex-start;
		gap: 0.5rem;
		font-size: 0.875rem;
		cursor: pointer;
	}

	.action-list {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
		gap: 0.375rem 1rem;
		max-height: 20rem;
		overflow-y: auto;
		padding: 0.625rem 0.75rem;
		border: 0.1rem solid var(--border-divider);
		border-radius: var(--radius-input);
	}

	.atext {
		display: flex;
		flex-direction: column;
		min-width: 0;

		.dim {
			font-size: 0.75rem;
		}
	}

	.abac {
		summary {
			cursor: pointer;
			font-size: 0.875rem;
			font-weight: 700;
		}

		p {
			margin: 0.5rem 0;
			font-size: 0.8125rem;
		}

		.field {
			margin-top: 0.75rem;
		}
	}

	.runrow {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.75rem;
		font-size: 0.8125rem;
	}
</style>
