<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { t } from '$lib/i18n.svelte';
	import { api, put } from '$lib/api';
	import Panel from './Panel.svelte';
	import Btn from './Btn.svelte';
	import SplitBtn from './SplitBtn.svelte';
	import DataTable from './DataTable.svelte';
	import Modal from './Modal.svelte';
	import ConfirmModal from './ConfirmModal.svelte';
	import Checkbox from './Checkbox.svelte';
	import Flash from './Flash.svelte';
	import Icon from './Icon.svelte';
	import PolicyEditor from './PolicyEditor.svelte';
	import PolicyYamlPreview from './PolicyYamlPreview.svelte';
	import PolicyPickTable from './PolicyPickTable.svelte';
	import GroupPickTable from './GroupPickTable.svelte';
	import type { Column } from './table';
	import type { ContextMenuItem } from './contextmenu';
	import type { PolicyEditorMode, PolicyValidation } from './policyeditor';
	import {
		accountPermissionRows,
		groupPermissionRows,
		type PermissionRow,
		type PermissionsSubject
	} from './permissionspolicies';
	import {
		IAM_NAME,
		POLICY_KIND_ICONS,
		groupHref,
		notifyEach,
		policyHref,
		policyKindLabel,
		runEach,
		type GroupRow,
		type PolicyRow
	} from '$lib/iam';
	import type { AccountPermissions, GroupSummary } from '$core/iam';

	/**
	 * AWS's "Permissions policies" panel, shared by an account's screen and a
	 * group's: every policy that reaches the subject, how it arrives (directly,
	 * or through which group), each row unfolding into its document. The panel
	 * attaches, writes inline policies and removes what is attached directly;
	 * what arrives through a group is removed from the group, and the verb says
	 * so rather than pretending it can.
	 */
	let {
		subject,
		permissions,
		group,
		onchange
	}: {
		subject: PermissionsSubject;
		/** an account's attachments, when the subject is an account */
		permissions?: AccountPermissions | null;
		/** the group itself, when the subject is a group */
		group?: GroupSummary | null;
		/** something changed; the owner reloads what it passed in */
		onchange: () => void | Promise<void>;
	} = $props();

	let catalog: PolicyRow[] = $state([]);
	let groups: GroupRow[] = $state([]);
	let loaded = $state(false);
	let selected: Set<string> = $state(new Set());
	let busy = $state(false);

	let addOpen = $state(false);
	let addMode: 'groups' | 'policies' = $state('groups');
	let pickedPolicies: Set<string> = $state(new Set());
	let pickedGroups: Set<string> = $state(new Set());

	let inlineOpen = $state(false);
	let inlineEditing = $state(false);
	let inlineName = $state('');
	let inlineYaml = $state('');
	let inlineMode: PolicyEditorMode = $state('visual');
	let inlineValidation = $state<PolicyValidation | null>(null);

	let removeOpen = $state(false);
	let removeRows: PermissionRow[] = $state([]);

	const isAccount = $derived(subject.kind === 'account');

	/** the body field the attach and inline routes take to name the subject */
	const target = $derived(
		subject.kind === 'account'
			? { account: subject.username }
			: { group: subject.name }
	);

	async function loadCatalog(): Promise<void> {
		try {
			const [policyData, groupData] = await Promise.all([
				api<{ policies: PolicyRow[] }>('/iam/policies'),
				isAccount
					? api<{ groups: GroupRow[] }>('/iam/groups')
					: Promise.resolve({ groups: [] as GroupRow[] })
			]);

			catalog = policyData.policies;
			groups = groupData.groups;
		} catch {
			// the rows still show their names; the catalog only adds types and documents
		} finally {
			loaded = true;
		}
	}

	onMount(() => {
		void loadCatalog();
	});

	async function refresh(): Promise<void> {
		await Promise.all([loadCatalog(), onchange()]);
	}

	const rows: PermissionRow[] = $derived.by(() => {
		if (subject.kind === 'account') {
			return permissions ? accountPermissionRows(permissions, catalog, groups) : [];
		}

		return group ? groupPermissionRows(group, catalog) : [];
	});

	const picked = $derived(rows.filter((row) => selected.has(row.key)));

	/** Why a row cannot be removed here, or an empty string when it can. */
	function removeReason(row: PermissionRow): string {
		return row.via
			? t('web.permissionsPanel.viaGroupReason', { group: row.via })
			: '';
	}

	const removeHint = $derived.by(() => {
		if (picked.length === 0) {
			return t('web.permissionsPanel.pickToRemove');
		}

		const blocked = picked.find((row) => row.via);

		return blocked
			? removeReason(blocked)
			: '';
	});

	function askRemove(targets: PermissionRow[]): void {
		const removable = targets.filter((row) => !row.via);

		if (removable.length === 0) {
			return;
		}

		removeRows = removable;
		removeOpen = true;
	}

	async function removeConfirmed(): Promise<void> {
		busy = true;

		const outcome = await runEach(
			removeRows,
			(row) =>
				row.kind === 'inline'
					? api('/iam/inline', { method: 'DELETE', body: JSON.stringify({ ...target, name: row.name }) })
					: api('/iam/attachments', { method: 'DELETE', body: JSON.stringify({ ...target, policy: row.name }) }),
			(row) => row.name
		);

		busy = false;
		selected = new Set();
		notifyEach(
			outcome,
			t('web.permissionsPanel.removed', { count: outcome.done }),
			t('web.permissionsPanel.removeFailed')
		);
		await refresh();
	}

	function openAdd(mode: 'groups' | 'policies'): void {
		addMode = isAccount ? mode : 'policies';
		pickedPolicies = new Set();
		pickedGroups = new Set();
		addOpen = true;
	}

	/** policies held directly, which the attach table locks */
	const directNames = $derived(
		new Set(rows.filter((row) => !row.via && row.kind !== 'inline').map((row) => row.name.toLowerCase()))
	);

	const memberOf = $derived(new Set(permissions?.groups.map((entry) => entry.name) ?? []));

	const addCount = $derived(addMode === 'groups' ? pickedGroups.size : pickedPolicies.size);

	async function addConfirmed(): Promise<void> {
		busy = true;

		if (addMode === 'groups' && subject.kind === 'account') {
			const accountId = subject.id;

			const outcome = await runEach(
				[...pickedGroups],
				(name) => api(`/iam/groups/${encodeURIComponent(name)}/members`, {
					method: 'POST',
					body: JSON.stringify({ members: [accountId] })
				}),
				(name) => name
			);

			notifyEach(
				outcome,
				t('web.permissionsPanel.addedToGroups', { count: outcome.done }),
				t('web.permissionsPanel.addFailed')
			);
		} else {
			const outcome = await runEach(
				[...pickedPolicies],
				(name) => api('/iam/attachments', { method: 'POST', body: JSON.stringify({ ...target, policy: name }) }),
				(name) => name
			);

			notifyEach(
				outcome,
				t('web.permissionsPanel.attached', { count: outcome.done }),
				t('web.permissionsPanel.addFailed')
			);
		}

		busy = false;
		addOpen = false;
		await refresh();
	}

	function openInline(row: PermissionRow | null): void {
		inlineEditing = row !== null;
		inlineName = row?.name ?? '';
		inlineYaml = row?.yaml ?? '';
		inlineMode = row ? 'yaml' : 'visual';
		inlineValidation = null;
		inlineOpen = true;
	}

	const inlineNameError = $derived(
		inlineName && !IAM_NAME.test(inlineName.trim()) ? t('web.iamPolicy.nameRule') : ''
	);

	const inlineNameTaken = $derived(
		!inlineEditing &&
			rows.some((row) => !row.via && row.kind === 'inline' && row.name.toLowerCase() === inlineName.trim().toLowerCase())
	);

	const inlineReady = $derived(!!inlineName.trim() && !inlineNameError && !inlineNameTaken && !!inlineValidation?.ok);

	async function saveInline(): Promise<void> {
		if (!inlineReady) {
			return;
		}

		busy = true;

		try {
			await put('/iam/inline', { ...target, name: inlineName.trim(), yaml: inlineYaml });

			inlineOpen = false;
			await refresh();
		} catch (err) {
			notifyEach({ done: 0, failed: [(err as Error).message] }, '', t('web.permissionsPanel.inlineFailed'));
		} finally {
			busy = false;
		}
	}

	function rowActions(row: PermissionRow): ContextMenuItem[] {
		const targets = selected.has(row.key) && picked.length > 1 ? picked : [row];
		const reason = targets.length === 1 ? removeReason(row) : '';
		const removable = targets.filter((entry) => !entry.via);

		return [
			{
				label: t('web.permissionsPanel.openPolicy'),
				icon: 'circleInfo',
				disabled: row.kind === 'inline',
				hint: row.kind === 'inline' ? t('web.permissionsPanel.inlineHasNoPage') : undefined,
				action: () => goto(policyHref(row.name))
			},
			{
				label: t('web.permissionsPanel.editInline'),
				icon: 'pen',
				disabled: !row.inline,
				hint: row.inline
					? undefined
					: row.kind === 'inline'
						? removeReason(row)
						: t('web.permissionsPanel.onlyInlineEdits'),
				action: () => openInline(row)
			},
			...(row.via
				? [{ label: t('web.permissionsPanel.openGroup'), icon: 'users', action: () => goto(groupHref(row.via!)) }]
				: []),
			{ separator: true },
			{
				label: t('web.permissionsPanel.removeAction', { count: removable.length }),
				icon: 'trash',
				color: 'danger',
				disabled: removable.length === 0,
				hint: reason || (removable.length === 0 ? removeReason(row) : undefined),
				action: () => askRemove(targets)
			}
		];
	}

	const addMenu: ContextMenuItem[] = $derived(
		isAccount
			? [
					{ label: t('web.permissionsPanel.addPermissions'), icon: 'plus', action: () => openAdd('groups') },
					{ label: t('web.permissionsPanel.createInline'), icon: 'fileLines', action: () => openInline(null) }
				]
			: [
					{ label: t('web.permissionsPanel.attachPolicies'), icon: 'link', action: () => openAdd('policies') },
					{ label: t('web.permissionsPanel.createInline'), icon: 'fileLines', action: () => openInline(null) }
				]
	);

	const columns: Column[] = $derived([
		{ id: 'name', label: t('web.iamList.colPolicyName'), sortable: true, width: 280 },
		{ id: 'type', label: t('web.iamList.colType'), sortable: true, width: 170 },
		{ id: 'via', label: t('web.permissionsPanel.colAttachedVia'), sortable: true, width: 200 },
		{ id: 'description', label: t('web.iamList.colDescription') }
	]);
</script>

<Panel
	title={t('web.permissionsPanel.title')}
	count={rows.length}
	description={isAccount ? t('web.permissionsPanel.accountHint') : t('web.permissionsPanel.groupHint')}
	flush
>
	{#snippet actions()}
		<Btn variant="tool" icon="rotate" title={t('web.common.refresh')} onclick={() => void refresh()} />
		{#if subject.kind === 'account'}
			<Btn icon="flaskVial" href="/console/iam/simulator?account={encodeURIComponent(subject.username)}">
				{t('web.permissionsPanel.simulate')}
			</Btn>
		{/if}
		<Btn
			icon="trash"
			disabled={!!removeHint}
			title={removeHint || undefined}
			onclick={() => askRemove(picked)}
		>
			{t('web.common.remove')}
		</Btn>
		<SplitBtn
			primary
			icon="plus"
			label={isAccount ? t('web.permissionsPanel.addPermissions') : t('web.permissionsPanel.attachPolicies')}
			menu={addMenu}
			onclick={() => openAdd(isAccount ? 'groups' : 'policies')}
		/>
	{/snippet}

	<DataTable
		{columns}
		{rows}
		getId={(row) => row.key}
		selectable="multi"
		bind:selected
		{rowActions}
		rowLabel={(row) => row.name}
		loading={!loaded && rows.length === 0}
		sortValue={(row, col) =>
			col === 'type'
				? row.kind
				: col === 'via'
					? (row.via ?? '')
					: null}
		emptyTitle={t('web.permissionsPanel.emptyTitle')}
		emptyText={isAccount ? t('web.permissionsPanel.emptyAccount') : t('web.permissionsPanel.emptyGroup')}
	>
		{#snippet cell(row, col)}
			{#if col === 'name'}
				<span class="pname">
					<Icon name={POLICY_KIND_ICONS[row.kind]} size="0.875rem" style={row.kind === 'builtin' ? 'solid' : 'regular'} />
					{#if row.kind === 'inline'}
						<b class="mono">{row.name}</b>
					{:else}
						<a href={policyHref(row.name)}>{row.name}</a>
					{/if}
				</span>
			{:else if col === 'type'}
				{policyKindLabel(row.kind)}
			{:else if col === 'via'}
				{#if row.via}
					<span>{t('web.permissionsPanel.viaGroup')} <a href={groupHref(row.via)}>{row.via}</a></span>
				{:else}
					{t('web.permissionsPanel.directly')}
				{/if}
			{:else if col === 'description'}
				<span class="dim">{row.description || '–'}</span>
			{/if}
		{/snippet}

		{#snippet expanded(row)}
			{#if row.yaml !== null}
				<PolicyYamlPreview yaml={row.yaml} />
			{:else}
				<PolicyYamlPreview name={row.name} />
			{/if}
		{/snippet}
	</DataTable>
</Panel>

<Modal
	title={isAccount
		? t('web.permissionsPanel.addTitle', { name: subject.kind === 'account' ? subject.username : '' })
		: t('web.permissionsPanel.attachTitle', { name: subject.kind === 'group' ? subject.name : '' })}
	bind:open={addOpen}
	wide
>
	{#if isAccount}
		<div class="options">
			<label class="option" class:on={addMode === 'groups'}>
				<Checkbox
					shape="radio"
					checked={addMode === 'groups'}
					label={t('web.permissionsPanel.optionGroups')}
					onchange={() => (addMode = 'groups')}
				/>
				<span>
					<b>{t('web.permissionsPanel.optionGroups')}</b>
					<span class="dim">{t('web.permissionsPanel.optionGroupsHint')}</span>
				</span>
			</label>
			<label class="option" class:on={addMode === 'policies'}>
				<Checkbox
					shape="radio"
					checked={addMode === 'policies'}
					label={t('web.permissionsPanel.optionPolicies')}
					onchange={() => (addMode = 'policies')}
				/>
				<span>
					<b>{t('web.permissionsPanel.optionPolicies')}</b>
					<span class="dim">{t('web.permissionsPanel.optionPoliciesHint')}</span>
				</span>
			</label>
		</div>
	{/if}

	{#if addMode === 'groups'}
		{#if groups.length === 0}
			<Flash kind="info">{t('web.permissionsPanel.noGroupsYet')}</Flash>
		{:else}
			<GroupPickTable
				tableId="iam-add-to-groups"
				{groups}
				bind:selected={pickedGroups}
				locked={(row) => memberOf.has(row.name)}
			/>
		{/if}
	{:else}
		<PolicyPickTable
			tableId="iam-attach-policies"
			policies={catalog}
			bind:selected={pickedPolicies}
			locked={(row) => directNames.has(row.name.toLowerCase())}
		/>
	{/if}

	{#snippet footer()}
		<Btn onclick={() => (addOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="primary" loading={busy} disabled={addCount === 0} onclick={() => void addConfirmed()}>
			{addMode === 'groups'
				? t('web.permissionsPanel.addToGroupsAction', { count: addCount })
				: t('web.permissionsPanel.attachAction', { count: addCount })}
		</Btn>
	{/snippet}
</Modal>

<Modal
	title={inlineEditing
		? t('web.permissionsPanel.editInlineTitle', { name: inlineName })
		: t('web.permissionsPanel.createInlineTitle')}
	bind:open={inlineOpen}
	wide
>
	<p class="note dim">{t('web.permissionsPanel.inlineLead')}</p>
	<label class="field">
		<span class="lbl">{t('web.permissionsPanel.inlineName')}</span>
		<span class="hint">{t('web.permissionsPanel.inlineNameHint')}</span>
		<input
			class="input mono"
			type="text"
			spellcheck="false"
			autocapitalize="none"
			disabled={inlineEditing}
			bind:value={inlineName}
		/>
		{#if inlineNameError}
			<span class="err">{inlineNameError}</span>
		{:else if inlineNameTaken}
			<span class="err">{t('web.permissionsPanel.inlineNameTaken')}</span>
		{/if}
	</label>

	{#key inlineOpen}
		<div class="editor">
			<PolicyEditor
				bind:value={inlineYaml}
				bind:mode={inlineMode}
				showToggle
				path="iam/{inlineName.trim() || 'inline'}.yaml"
				height="20rem"
				onvalidate={(result) => (inlineValidation = result)}
				onsave={() => void saveInline()}
			/>
		</div>
	{/key}

	{#snippet footer()}
		<Btn onclick={() => (inlineOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="primary" icon="floppyDisk" loading={busy} disabled={!inlineReady} onclick={() => void saveInline()}>
			{t('web.common.save')}
		</Btn>
	{/snippet}
</Modal>

<ConfirmModal
	bind:open={removeOpen}
	title={t('web.permissionsPanel.removeTitle', { count: removeRows.length })}
	lead={t('web.permissionsPanel.removeLead', { names: removeRows.map((row) => row.name).join(', ') })}
	notes={[t('web.permissionsPanel.removeNote')]}
	confirmLabel={t('web.common.remove')}
	onconfirm={() => void removeConfirmed()}
/>

<style lang="scss">
	.pname {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--text-secondary);
	}

	.options {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.75rem;
		margin-bottom: 1rem;

		@include below($bp-narrow) {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.option {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.75rem 1rem;
		border: 0.1rem solid var(--border-divider);
		border-radius: var(--radius-container);
		text-align: left;
		cursor: pointer;

		> span {
			display: flex;
			flex-direction: column;
			gap: 0.25rem;
			font-size: 0.875rem;
		}

		.dim {
			font-size: 0.8125rem;
		}

		&.on {
			border-color: var(--link);
			background: var(--bg-hover);
		}
	}

	.note {
		margin: 0 0 1rem;
		font-size: 0.8125rem;
	}

	.editor {
		margin-top: 1rem;
	}
</style>
