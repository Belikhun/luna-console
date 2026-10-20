<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, del, patch } from '$lib/api';
	import { fmtDateTime } from '$lib/format';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Tabs from '$lib/components/Tabs.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import FormGrid from '$lib/components/FormGrid.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import PolicyEditor from '$lib/components/PolicyEditor.svelte';
	import type { PolicyValidation } from '$lib/components/policyeditor';
	import type { InfoCell } from '$lib/components/grid';
	import type { Column } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { Notify } from '$lib/notifications.svelte';
	import { clearCrumbLabel, setCrumbLabel } from '$lib/crumbs.svelte';
	import {
		IAM_NAME,
		accountSearchHref,
		attachedCount,
		groupHref,
		iamAuditLabel,
		iamAuditTone,
		keyIamAudit,
		policyDeleteReason,
		policyHref,
		policyKindLabel,
		type IamAuditRow,
		type PolicyRow
	} from '../../iam';

	/**
	 * One policy: what it is and where it is attached, its document (editable
	 * when managed, shown as code when built-in), and what was done to it.
	 */

	const name = $derived(page.params.name ?? '');

	let policy = $state<PolicyRow | null>(null);
	let audit: IamAuditRow[] = $state([]);
	let missing = $state(false);
	let loading = $state(false);
	let lastUpdated: number | null = $state(null);
	let tab = $state(page.url.searchParams.get('tab') ?? 'details');

	/** The document being edited: a working copy once the policy has loaded */
	let draft = $state('');
	let draftLoaded = $state(false);
	let validation = $state<PolicyValidation | null>(null);
	let savingDocument = $state(false);

	let editOpen = $state(false);
	let editName = $state('');
	let editDescription = $state('');
	let deleteOpen = $state(false);
	let busy = $state(false);

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const data = await api(`/iam/policies/${encodeURIComponent(name)}`);

			policy = data.policy;
			audit = keyIamAudit(data.audit);
			missing = false;
			lastUpdated = Date.now();

			if (!draftLoaded || !documentDirty) {
				draft = data.policy.yaml;
				draftLoaded = true;
			}
		} catch (err) {
			if ((err as { status?: number }).status === 404) {
				missing = true;
			} else {
				Notify.error(t('web.iam.loadFailed'), { detail: (err as Error).message });
			}
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (!policy) {
			return;
		}

		const path = policyHref(name);

		setCrumbLabel(path, policy.name);

		return () => clearCrumbLabel(path);
	});

	onMount(() => {
		void refresh();
	});

	const documentDirty = $derived(!!policy && draftLoaded && draft !== policy.yaml);
	const deleteReason = $derived(policy ? policyDeleteReason(policy) : '');

	async function saveDocument(): Promise<void> {
		if (!policy || !draftLoaded || !validation?.ok) {
			return;
		}

		savingDocument = true;

		try {
			const result = await patch(`/iam/policies/${encodeURIComponent(policy.name)}`, { yaml: draft });

			policy = result.policy;
			draft = result.policy.yaml;
			Notify.success(t('web.iamPolicy.documentSaved', { count: result.policy.document.Statement.length }));
			await refresh();
		} catch (err) {
			Notify.error(t('web.iamPolicy.documentFailed'), { detail: (err as Error).message });
		} finally {
			savingDocument = false;
		}
	}

	function resetDocument(): void {
		if (policy) {
			draft = policy.yaml;
		}
	}

	function openEdit(): void {
		if (!policy) {
			return;
		}

		editName = policy.name;
		editDescription = policy.description;
		editOpen = true;
	}

	const editNameError = $derived(editName && !IAM_NAME.test(editName.trim()) ? t('web.iamPolicy.nameRule') : '');

	async function saveEdit(): Promise<void> {
		if (!policy) {
			return;
		}

		busy = true;

		const nextName = editName.trim();
		const body: Record<string, unknown> = { description: editDescription.trim() };

		if (nextName !== policy.name) {
			body.name = nextName;
		}

		try {
			const result = await patch(`/iam/policies/${encodeURIComponent(policy.name)}`, body);

			editOpen = false;

			if (result.policy.name !== name) {
				await goto(policyHref(result.policy.name));
			}

			await refresh();
		} catch (err) {
			Notify.error(t('web.iamPolicy.updateFailed'), { detail: (err as Error).message });
		} finally {
			busy = false;
		}
	}

	async function removeConfirmed(): Promise<void> {
		if (!policy) {
			return;
		}

		try {
			await del(`/iam/policies/${encodeURIComponent(policy.name)}`);

			Notify.success(t('web.iamPolicy.removed', { name: policy.name }));
			await goto('/console/iam');
		} catch (err) {
			Notify.error(t('web.iamPolicy.updateFailed'), { detail: (err as Error).message });
		}
	}

	const verbs: ContextMenuItem[] = $derived(
		!policy
			? []
			: [
					{
						label: t('web.iamPolicy.editDetails'),
						icon: 'pen',
						disabled: policy.builtin,
						hint: policy.builtin ? t('web.iam.builtinNoEdit') : undefined,
						action: openEdit
					},
					{
						label: t('web.iam.viewDocument'),
						icon: 'fileLines',
						action: () => {
							tab = 'document';
						}
					},
					{ separator: true },
					{
						label: t('web.iam.deletePolicyAction', { count: 1 }),
						icon: 'trash',
						color: 'danger',
						disabled: !!deleteReason,
						hint: deleteReason || undefined,
						action: () => {
							deleteOpen = true;
						}
					}
				]
	);

	const summaryCells: InfoCell[] = $derived(
		!policy
			? []
			: [
					{ label: t('web.iam.colName'), value: policy.name, copyable: true },
					{ id: 'kind', label: t('web.iam.colKind') },
					{ label: t('web.iam.colDescription'), value: policy.description || '–', colSpan: 2 },
					{ label: t('web.iam.colStatements'), value: policy.document.Statement.length },
					{ label: t('web.iamPolicy.attachedCount'), value: attachedCount(policy) },
					{
						label: t('web.iam.colCreated'),
						value: policy.createdAt
							? `${fmtDateTime(policy.createdAt)}${policy.createdBy ? ` · ${policy.createdBy}` : ''}`
							: t('web.iamPolicy.shipsWithLuna')
					},
					{
						label: t('web.iam.colUpdated'),
						value: policy.updatedAt
							? `${fmtDateTime(policy.updatedAt)}${policy.updatedBy ? ` · ${policy.updatedBy}` : ''}`
							: '–'
					},
					{ id: 'accounts', label: t('web.iamPolicy.attachedAccounts'), colSpan: 2 },
					{ id: 'groups', label: t('web.iamPolicy.attachedGroups'), colSpan: 2 }
				]
	);

	const auditColumns: Column[] = $derived([
		{ id: 'when', label: t('web.iam.colWhen'), sortable: true, width: 180 },
		{ id: 'action', label: t('web.iam.colAction'), sortable: true, width: 200 },
		{ id: 'actor', label: t('web.iam.colActor'), sortable: true, width: 160 },
		{ id: 'detail', label: t('web.iam.colDetail') }
	]);
</script>

<svelte:head><title>{policy?.name ?? name} | Luna Console</title></svelte:head>

{#if missing}
	<PageHeader title={name} description={t('web.iamPolicy.kind')} />
	<Flash kind="error">
		{t('web.iamPolicy.notFound', { name })}
		<a href="/console/iam">{t('web.iam.back')}</a>
	</Flash>
{:else if policy}
	<PageHeader title={policy.name} description={policy.description || t('web.iamPolicy.kind')} info>
		{#snippet extra()}
			<StatusBadge state={policy!.builtin ? 'info' : 'ok'} label={policyKindLabel(policy!)} />
		{/snippet}
		{#snippet actions()}
			<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="iam-policy-detail" />
			<Dropdown label={t('web.common.actions')} menu={verbs} />
			<Btn icon="pen" disabled={policy!.builtin} onclick={openEdit}>{t('web.iamPolicy.editDetails')}</Btn>
		{/snippet}
	</PageHeader>

	{#if policy.builtin}
		<Flash kind="info">{t('web.iamPolicy.builtinNotice')}</Flash>
	{/if}

	<Tabs
		tabs={[
			{ id: 'details', label: t('web.iamPolicy.tabDetails') },
			{ id: 'document', label: t('web.iamPolicy.tabDocument') },
			{ id: 'activity', label: t('web.iamPolicy.tabActivity') }
		]}
		bind:active={tab}
	/>

	<div class="tabbody">
		{#if tab === 'details'}
			<Panel title={t('web.iamPolicy.summary')}>
				<InfoGrid cells={summaryCells}>
					{#snippet custom(cell)}
						{#if cell.id === 'kind'}
							<StatusBadge state={policy!.builtin ? 'info' : 'ok'} label={policyKindLabel(policy!)} />
						{:else if cell.id === 'accounts'}
							<div class="chips">
								{#each policy!.attachedTo.accounts as username (username)}
									<a class="chip" href={accountSearchHref(username)}>{username}</a>
								{:else}
									<span class="dim">{t('web.iamPolicy.noAccounts')}</span>
								{/each}
							</div>
						{:else if cell.id === 'groups'}
							<div class="chips">
								{#each policy!.attachedTo.groups as group (group)}
									<a class="chip" href={groupHref(group)}>{group}</a>
								{:else}
									<span class="dim">{t('web.iamPolicy.noGroups')}</span>
								{/each}
							</div>
						{/if}
					{/snippet}
				</InfoGrid>
			</Panel>
		{:else if tab === 'document' && draftLoaded}
			<Panel title={t('web.iamPolicy.documentPanel')} description={t('web.iamPolicy.documentHint')}>
				{#snippet actions()}
					{#if !policy!.builtin}
						<Btn disabled={!documentDirty} onclick={resetDocument}>{t('web.common.discard')}</Btn>
						<Btn
							variant="primary"
							icon="floppyDisk"
							disabled={!documentDirty || !validation?.ok}
							loading={savingDocument}
							onclick={saveDocument}
						>
							{t('web.iamPolicy.saveDocument')}
						</Btn>
					{/if}
				{/snippet}
				{#if policy.builtin}
					<Flash kind="info">{t('web.iamPolicy.builtinDocument')}</Flash>
					<div class="gap"></div>
				{/if}
				<PolicyEditor
					bind:value={draft}
					readonly={policy.builtin}
					path="iam/{policy.name}.yaml"
					onvalidate={(result) => (validation = result)}
					onsave={saveDocument}
				/>
			</Panel>
		{:else if tab === 'activity'}
			<Panel flush>
				<ResourceTable
					tableId="iam-policy-audit"
					columns={auditColumns}
					rows={audit}
					getId={(row) => row.key}
					searchValue={(row) => `${row.action} ${row.actor ?? ''} ${row.detail ?? ''}`}
					searchPlaceholder={t('web.iam.searchActivity')}
					noun={t('web.iam.activityNoun')}
					sortValue={(row, col) => (col === 'when' ? row.t : null)}
					emptyTitle={t('web.iam.noActivityTitle')}
					emptyText={t('web.iam.noActivityText')}
				>
					{#snippet cell(row, col)}
						{#if col === 'when'}
							<span class="dim">{fmtDateTime(row.t)}</span>
						{:else if col === 'action'}
							<StatusBadge state={iamAuditTone(row.action)} label={iamAuditLabel(row.action)} />
						{:else if col === 'actor'}
							<span class:dim={!row.actor}>{row.actor ?? t('web.iam.noActor')}</span>
						{:else if col === 'detail'}
							<span class="dim">{row.detail ?? '–'}</span>
						{/if}
					{/snippet}
				</ResourceTable>
			</Panel>
		{/if}
	</div>

	<Modal title={t('web.iamPolicy.editTitle', { name: policy.name })} bind:open={editOpen}>
		<FormGrid>
			<label class="field">
				<span class="lbl">{t('web.iamPolicy.name')}</span>
				<span class="hint">{t('web.iamPolicy.renameHint')}</span>
				<input class="input" type="text" spellcheck="false" autocapitalize="none" bind:value={editName} />
				{#if editNameError}<span class="err">{editNameError}</span>{/if}
			</label>
			<label class="field">
				<span class="lbl">{t('web.iamPolicy.description')}</span>
				<input class="input" type="text" bind:value={editDescription} />
			</label>
		</FormGrid>

		{#snippet footer()}
			<Btn onclick={() => (editOpen = false)}>{t('web.common.cancel')}</Btn>
			<Btn variant="primary" loading={busy} disabled={!editName.trim() || !!editNameError} onclick={saveEdit}>
				{t('web.common.save')}
			</Btn>
		{/snippet}
	</Modal>

	<ConfirmModal
		bind:open={deleteOpen}
		title={t('web.iam.deletePolicyTitle', { count: 1 })}
		lead={t('web.iam.deletePolicyLead', { names: policy.name })}
		notes={[t('web.iam.deletePolicyNote')]}
		confirmLabel={t('web.common.delete')}
		onconfirm={() => void removeConfirmed()}
	/>
{/if}

<style lang="scss">
	.tabbody {
		margin-top: 1rem;
	}

	.gap {
		height: 1rem;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.chip {
		font-size: 0.75rem;
		border: 0.1rem solid var(--border-divider);
		border-radius: 0.75rem;
		padding: 0.125rem 0.5rem;
	}
</style>
