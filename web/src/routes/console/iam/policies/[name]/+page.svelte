<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, del, post } from '$lib/api';
	import { fmtDateTime } from '$lib/format';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import ButtonGroup from '$lib/components/ButtonGroup.svelte';
	import Tabs from '$lib/components/Tabs.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import ResourceIdValue from '$lib/components/ResourceIdValue.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import ResourceMeta from '$lib/components/ResourceMeta.svelte';
	import PolicyEditor from '$lib/components/PolicyEditor.svelte';
	import PolicySummaryTable from '$lib/components/PolicySummaryTable.svelte';
	import type { InfoCell } from '$lib/components/grid';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { Authz } from '$lib/authz.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import { clearCrumbLabel, setCrumbLabel } from '$lib/crumbs.svelte';
	import {
		POLICY_KIND_ICONS,
		accountHref,
		groupHref,
		iamAuditLabel,
		iamAuditTone,
		iamResourceId,
		keyIamAudit,
		notifyEach,
		policyDeleteReason,
		policyHref,
		policyKind,
		policyKindLabel,
		runEach,
		type GroupRow,
		type IamAuditRow,
		type PolicyRow
	} from '$lib/iam';
	import type { AccountSummary } from '$core/accounts';

	/**
	 * One policy, AWS's policy screen: its details, then tabs for what it
	 * permits (as a summary or as YAML), the accounts and groups it is attached
	 * to, its tags and what was done to it.
	 */

	/** An account or a group, as the "Entities attached" table lists them. */
	interface Entity {
		key: string;
		kind: 'account' | 'group';
		name: string;
		/** an account's id, for its screen */
		id: string | null;
	}

	const name = $derived(page.params.name ?? '');

	let policy = $state<PolicyRow | null>(null);
	let audit: IamAuditRow[] = $state([]);
	let accounts: AccountSummary[] = $state([]);
	let groups: GroupRow[] = $state([]);
	let missing = $state(false);
	let loading = $state(false);
	let lastUpdated: number | null = $state(null);
	let tab = $state(page.url.searchParams.get('tab') ?? 'permissions');
	let view: 'summary' | 'yaml' = $state('summary');

	let selectedEntities: Set<string> = $state(new Set());
	let attachOpen = $state(false);
	let attachPicked: Set<string> = $state(new Set());
	let detachOpen = $state(false);
	let detachRows: Entity[] = $state([]);
	let deleteOpen = $state(false);
	let busy = $state(false);

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const data = await api<{ policy: PolicyRow; audit: IamAuditRow[] }>(`/iam/policies/${encodeURIComponent(name)}`);

			policy = data.policy;
			audit = keyIamAudit(data.audit);
			missing = false;
			lastUpdated = Date.now();
		} catch (err) {
			if ((err as { status?: number }).status === 404) {
				missing = true;
			} else {
				Notify.error(t('web.iam.loadFailed'), { detail: (err as Error).message });
			}
		} finally {
			loading = false;
		}

		// the entity table names accounts by id and offers groups to attach to;
		// a refusal here leaves the policy itself readable
		const [accountData, groupData] = await Promise.allSettled([
			api<{ accounts: AccountSummary[] }>('/accounts'),
			api<{ groups: GroupRow[] }>('/iam/groups')
		]);

		accounts = accountData.status === 'fulfilled'
			? accountData.value.accounts
			: [];

		groups = groupData.status === 'fulfilled'
			? groupData.value.groups
			: [];
	}

	$effect(() => {
		if (!policy) {
			return;
		}

		const path = policyHref(name);

		setCrumbLabel(path, policy.name);

		return () => clearCrumbLabel(path);
	});

	onMount(async () => {
		await refresh();

		if (page.url.searchParams.get('attach')) {
			openAttach();
		}
	});

	function denied(action: string): string {
		return Authz.can(action)
			? ''
			: t('web.common.notAllowed', { action });
	}

	const deleteReason = $derived(policy ? policyDeleteReason(policy) || denied('iam:DeletePolicy') : '');

	const editReason = $derived(
		!policy
			? ''
			: policy.builtin
				? t('web.iam.builtinNoEdit')
				: denied('iam:UpdatePolicy')
	);

	const entities: Entity[] = $derived(
		!policy
			? []
			: [
					...policy.attachedTo.accounts.map((username) => ({
						key: `account:${username}`,
						kind: 'account' as const,
						name: username,
						id: accounts.find((account) => account.username === username)?.id ?? null
					})),
					...policy.attachedTo.groups.map((group) => ({
						key: `group:${group}`,
						kind: 'group' as const,
						name: group,
						id: null
					}))
				]
	);

	/** Every account and group, for the attach dialog; the ones already holding the policy are locked. */
	const candidates: Entity[] = $derived([
		...accounts.map((account) => ({
			key: `account:${account.username}`,
			kind: 'account' as const,
			name: account.username,
			id: account.id
		})),
		...groups.map((group) => ({ key: `group:${group.name}`, kind: 'group' as const, name: group.name, id: null }))
	]);

	const attachedKeys = $derived(new Set(entities.map((entity) => entity.key)));
	const pickedEntities = $derived(entities.filter((entity) => selectedEntities.has(entity.key)));

	function entityHref(entity: Entity): string {
		return entity.kind === 'group'
			? groupHref(entity.name)
			: accountHref(entity.name, entity.id);
	}

	function entityBody(entity: Entity): Record<string, string> {
		return entity.kind === 'group'
			? { group: entity.name }
			: { account: entity.name };
	}

	function openAttach(): void {
		attachPicked = new Set();
		attachOpen = true;
		tab = 'entities';
	}

	async function attachConfirmed(): Promise<void> {
		if (!policy) {
			return;
		}

		const policyName = policy.name;
		const targets = candidates.filter((entity) => attachPicked.has(entity.key));

		busy = true;

		const outcome = await runEach(
			targets,
			(entity) => post('/iam/attachments', { ...entityBody(entity), policy: policyName }),
			(entity) => entity.name
		);

		busy = false;
		attachOpen = false;
		notifyEach(outcome, t('web.iamPolicyDetail.attached', { count: outcome.done }), t('web.iamPolicyDetail.attachFailed'));
		await refresh();
	}

	function askDetach(rows: Entity[]): void {
		if (rows.length === 0) {
			return;
		}

		detachRows = rows;
		detachOpen = true;
	}

	async function detachConfirmed(): Promise<void> {
		if (!policy) {
			return;
		}

		const policyName = policy.name;

		const outcome = await runEach(
			detachRows,
			(entity) => api('/iam/attachments', {
				method: 'DELETE',
				body: JSON.stringify({ ...entityBody(entity), policy: policyName })
			}),
			(entity) => entity.name
		);

		selectedEntities = new Set();
		notifyEach(outcome, t('web.iamPolicyDetail.detached', { count: outcome.done }), t('web.iamPolicyDetail.detachFailed'));
		await refresh();
	}

	async function removeConfirmed(): Promise<void> {
		if (!policy) {
			return;
		}

		try {
			await del(`/iam/policies/${encodeURIComponent(policy.name)}`);

			Notify.success(t('web.iamPolicy.removed', { name: policy.name }));
			await goto('/console/iam/policies');
		} catch (err) {
			Notify.error(t('web.iamPolicy.updateFailed'), { detail: (err as Error).message });
		}
	}

	function entityActions(row: Entity): ContextMenuItem[] {
		const targets = selectedEntities.has(row.key) && pickedEntities.length > 1 ? pickedEntities : [row];

		return [
			{
				label: row.kind === 'group' ? t('web.iamPolicyDetail.openGroup') : t('web.iamPolicyDetail.openAccount'),
				icon: 'circleInfo',
				action: () => goto(entityHref(row))
			},
			{ separator: true },
			{
				label: t('web.iamPolicyDetail.detachAction', { count: targets.length }),
				icon: 'unlink',
				color: 'danger',
				disabled: !!denied('iam:Detach'),
				hint: denied('iam:Detach') || undefined,
				action: () => askDetach(targets)
			}
		];
	}

	const detailCells: InfoCell[] = $derived(
		!policy
			? []
			: [
					{ id: 'type', label: t('web.iamList.colType') },
					{
						label: t('web.iamPolicyDetail.created'),
						value: policy.createdAt ? fmtDateTime(policy.createdAt) : t('web.iamPolicy.shipsWithLuna')
					},
					{
						label: t('web.iamPolicyDetail.edited'),
						value: policy.updatedAt ? fmtDateTime(policy.updatedAt) : '–'
					},
					{ id: 'resourceId', label: t('web.iamPolicyDetail.resourceId') },
					{ label: t('web.iamPolicyDetail.createdBy'), value: policy.createdBy ?? '–' },
					{ label: t('web.iamPolicyDetail.editedBy'), value: policy.updatedBy ?? '–' },
					{ label: t('web.iamList.colUsedAs'), value: entities.length },
					{ label: t('web.iamPolicyDetail.statements'), value: policy.document.Statement.length }
				]
	);

	const entityColumns: Column[] = $derived([
		{ id: 'name', label: t('web.iamPolicyDetail.colEntityName'), sortable: true, width: 260 },
		{ id: 'kind', label: t('web.iamPolicyDetail.colEntityType'), sortable: true }
	]);

	const entityFilters: TableFilterGroup<Entity>[] = $derived([
		{
			id: 'kind',
			label: t('web.iamPolicyDetail.filterEntityType'),
			options: [
				{ value: 'any', label: t('web.iamPolicyDetail.anyEntity') },
				{ value: 'account', label: t('web.iamPolicyDetail.entityUser'), match: (row) => row.kind === 'account' },
				{ value: 'group', label: t('web.iamPolicyDetail.entityGroup'), match: (row) => row.kind === 'group' }
			]
		}
	]);

	const auditColumns: Column[] = $derived([
		{ id: 'when', label: t('web.iam.colWhen'), sortable: true, width: 180 },
		{ id: 'action', label: t('web.iam.colAction'), sortable: true, width: 200 },
		{ id: 'actor', label: t('web.iam.colActor'), sortable: true, width: 160 },
		{ id: 'detail', label: t('web.iam.colDetail') }
	]);
</script>

<svelte:head><title>{policy?.name ?? name} | Luna Console</title></svelte:head>

{#snippet entityCell(row: Entity, col: string)}
	{#if col === 'name'}
		<span class="ename">
			<Icon name={row.kind === 'group' ? 'users' : 'userShield'} size="0.875rem" />
			<a href={entityHref(row)}>{row.name}</a>
		</span>
	{:else if col === 'kind'}
		{row.kind === 'group' ? t('web.iamPolicyDetail.entityGroup') : t('web.iamPolicyDetail.entityUser')}
	{/if}
{/snippet}

{#if missing}
	<PageHeader title={name} description={t('web.iamPolicy.kind')} />
	<Flash kind="error">
		{t('web.iamPolicy.notFound', { name })}
		<a href="/console/iam/policies">{t('web.iamList.backToPolicies')}</a>
	</Flash>
{:else if policy}
	<PageHeader title={policy.name} description={policy.description || t('web.iamPolicy.kind')} info>
		{#snippet extra()}
			<StatusBadge state={policy!.builtin ? 'info' : 'ok'} label={policyKindLabel(policyKind(policy!))} />
		{/snippet}
		{#snippet actions()}
			<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="iam-policy-detail" />
			<Btn icon="trash" disabled={!!deleteReason} title={deleteReason || undefined} onclick={() => (deleteOpen = true)}>
				{t('web.common.delete')}
			</Btn>
			<Btn
				variant="primary"
				icon="pen"
				href="{policyHref(policy!.name)}/edit"
				disabled={!!editReason}
				title={editReason || undefined}
			>
				{t('web.common.edit')}
			</Btn>
		{/snippet}
	</PageHeader>

	<Panel title={t('web.iamPolicyDetail.details')}>
		<InfoGrid cells={detailCells}>
			{#snippet custom(cell)}
				{#if cell.id === 'type'}
					<span class="ptype">
						<Icon name={POLICY_KIND_ICONS[policyKind(policy!)]} size="0.875rem" style={policy!.builtin ? 'solid' : 'regular'} />
						{policyKindLabel(policyKind(policy!))}
					</span>
				{:else if cell.id === 'resourceId'}
					<ResourceIdValue value={iamResourceId('policy', policy!.name)} label={t('web.iamPolicyDetail.resourceId')} />
				{/if}
			{/snippet}
		</InfoGrid>
	</Panel>

	<div class="gap"></div>

	<Tabs
		tabs={[
			{ id: 'permissions', label: t('web.iamPolicyDetail.tabPermissions') },
			{ id: 'entities', label: t('web.iamPolicyDetail.tabEntities', { count: entities.length }) },
			{ id: 'tags', label: t('web.iamPolicyDetail.tabTags') },
			{ id: 'activity', label: t('web.iamPolicyDetail.tabActivity') }
		]}
		bind:active={tab}
	/>

	<div class="tabbody">
		{#if tab === 'permissions'}
			<Panel title={t('web.iamPolicyDetail.permissionsPanel')} description={t('web.iamPolicyDetail.permissionsHint')}>
				{#snippet actions()}
					<ButtonGroup>
						<Btn variant={view === 'summary' ? 'primary' : 'normal'} icon="listCheck" onclick={() => (view = 'summary')}>
							{t('web.iamPolicyDetail.summary')}
						</Btn>
						<Btn variant={view === 'yaml' ? 'primary' : 'normal'} icon="code" onclick={() => (view = 'yaml')}>
							{t('web.policyEditor.yaml')}
						</Btn>
					</ButtonGroup>
					<Btn icon="pen" href="{policyHref(policy!.name)}/edit" disabled={!!editReason} title={editReason || undefined}>
						{t('web.common.edit')}
					</Btn>
				{/snippet}
				{#if view === 'summary'}
					<PolicySummaryTable document={policy.document} />
				{:else}
					<PolicyEditor value={policy.yaml} readonly path="iam/{policy.name}.yaml" />
				{/if}
			</Panel>
		{:else if tab === 'entities'}
			<Panel
				title={t('web.iamPolicyDetail.entitiesPanel')}
				count={entities.length}
				description={t('web.iamPolicyDetail.entitiesHint')}
				flush
			>
				{#snippet actions()}
					<Btn
						icon="unlink"
						disabled={pickedEntities.length === 0 || !!denied('iam:Detach')}
						title={pickedEntities.length === 0 ? t('web.iamPolicyDetail.pickToDetach') : denied('iam:Detach') || undefined}
						onclick={() => askDetach(pickedEntities)}
					>
						{t('web.iamPolicyDetail.detach')}
					</Btn>
					<Btn
						variant="primary"
						icon="link"
						disabled={!!denied('iam:Attach')}
						title={denied('iam:Attach') || undefined}
						onclick={openAttach}
					>
						{t('web.iamPolicyDetail.attach')}
					</Btn>
				{/snippet}
				<DataTable
					columns={entityColumns}
					rows={entities}
					getId={(row) => row.key}
					selectable="multi"
					bind:selected={selectedEntities}
					rowActions={entityActions}
					rowLabel={(row) => row.name}
					resourceId={(row) => iamResourceId(row.kind, row.name)}
					sortValue={(row, col) => (col === 'kind' ? row.kind : null)}
					cell={entityCell}
					emptyTitle={t('web.iamPolicyDetail.noEntities')}
					emptyText={t('web.iamPolicyDetail.noEntitiesText')}
				/>
			</Panel>
		{:else if tab === 'tags'}
			{#if policy.builtin}
				<Flash kind="info">{t('web.iamPolicyDetail.builtinNoTags')}</Flash>
			{:else}
				<ResourceMeta id={iamResourceId('policy', policy.name)} />
			{/if}
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

	<Modal title={t('web.iamPolicyDetail.attachTitle', { name: policy.name })} bind:open={attachOpen} wide>
		<p class="note dim">{t('web.iamPolicyDetail.attachLead')}</p>
		<ResourceTable
			tableId="iam-policy-attach"
			columns={entityColumns}
			filters={entityFilters}
			rows={candidates}
			getId={(row) => row.key}
			searchValue={(row) => row.name}
			searchPlaceholder={t('web.iamPolicyDetail.searchEntities')}
			searchWidth="18rem"
			selectable="multi"
			bind:selected={attachPicked}
			rowLocked={(row) => attachedKeys.has(row.key)}
			resourceId={(row) => iamResourceId(row.kind, row.name)}
			pageSize={10}
			maxHeight="26rem"
			noun={t('web.iamPolicyDetail.entityNoun')}
			sortValue={(row, col) => (col === 'kind' ? row.kind : null)}
			cell={entityCell}
		/>

		{#snippet footer()}
			<Btn onclick={() => (attachOpen = false)}>{t('web.common.cancel')}</Btn>
			<Btn variant="primary" loading={busy} disabled={attachPicked.size === 0} onclick={() => void attachConfirmed()}>
				{t('web.iamPolicyDetail.attachAction', { count: attachPicked.size })}
			</Btn>
		{/snippet}
	</Modal>

	<ConfirmModal
		bind:open={detachOpen}
		title={t('web.iamPolicyDetail.detachTitle', { count: detachRows.length })}
		lead={t('web.iamPolicyDetail.detachLead', { policy: policy.name, names: detachRows.map((row) => row.name).join(', ') })}
		notes={[t('web.iamPolicyDetail.detachNote')]}
		confirmLabel={t('web.iamPolicyDetail.detach')}
		onconfirm={() => void detachConfirmed()}
	/>

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

	.ptype,
	.ename {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}

	.note {
		margin: 0 0 1rem;
		font-size: 0.8125rem;
	}
</style>
