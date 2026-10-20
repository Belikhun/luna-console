<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, del, patch, post } from '$lib/api';
	import { fmtDateTime } from '$lib/format';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Tabs from '$lib/components/Tabs.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import FormGrid from '$lib/components/FormGrid.svelte';
	import ResourceIdValue from '$lib/components/ResourceIdValue.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import ResourceMeta from '$lib/components/ResourceMeta.svelte';
	import AccountAvatar from '$lib/components/AccountAvatar.svelte';
	import AccountPickTable from '$lib/components/AccountPickTable.svelte';
	import PermissionsPolicies from '$lib/components/PermissionsPolicies.svelte';
	import type { InfoCell } from '$lib/components/grid';
	import type { Column } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { Authz } from '$lib/authz.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import { clearCrumbLabel, setCrumbLabel } from '$lib/crumbs.svelte';
	import {
		IAM_NAME,
		groupHref,
		iamAuditLabel,
		iamAuditTone,
		iamResourceId,
		keyIamAudit,
		notifyEach,
		runEach,
		type GroupRow,
		type IamAuditRow
	} from '$lib/iam';
	import type { AccountSummary } from '$core/accounts';
	import type { GroupMember } from '$core/iam';

	/**
	 * One user group, AWS's group screen: its summary, then tabs for the
	 * accounts in it, the permissions it carries (the same panel an account's
	 * screen shows), its tags and what was done to it.
	 */

	/** A member with what the account list knows about it. */
	type MemberRow = GroupMember & { account: AccountSummary | null };

	const name = $derived(page.params.name ?? '');

	let group = $state<GroupRow | null>(null);
	let audit: IamAuditRow[] = $state([]);
	let accounts: AccountSummary[] = $state([]);
	let missing = $state(false);
	let loading = $state(false);
	let lastUpdated: number | null = $state(null);
	let tab = $state(page.url.searchParams.get('tab') ?? 'users');

	let selectedMembers: Set<string> = $state(new Set());
	let addOpen = $state(false);
	let addPicked: Set<string> = $state(new Set());
	let removeOpen = $state(false);
	let removeRows: MemberRow[] = $state([]);

	let editOpen = $state(false);
	let editName = $state('');
	let editDescription = $state('');
	let deleteOpen = $state(false);
	let busy = $state(false);

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const data = await api<{ group: GroupRow; audit: IamAuditRow[] }>(`/iam/groups/${encodeURIComponent(name)}`);

			group = data.group;
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

		try {
			const data = await api<{ accounts: AccountSummary[] }>('/accounts');

			accounts = data.accounts;
		} catch {
			// members still show by name without the account list
			accounts = [];
		}
	}

	$effect(() => {
		if (!group) {
			return;
		}

		const path = groupHref(name);

		setCrumbLabel(path, group.name);

		return () => clearCrumbLabel(path);
	});

	onMount(async () => {
		await refresh();

		if (page.url.searchParams.get('add')) {
			openAdd();
		}
	});

	function denied(action: string): string {
		return Authz.can(action)
			? ''
			: t('web.common.notAllowed', { action });
	}

	const members: MemberRow[] = $derived(
		(group?.members ?? []).map((member) => ({
			...member,
			account: accounts.find((account) => account.id === member.id) ?? null
		}))
	);

	const pickedMembers = $derived(members.filter((row) => selectedMembers.has(row.id)));
	const memberIds = $derived(new Set(members.map((row) => row.id)));

	function openAdd(): void {
		addPicked = new Set();
		addOpen = true;
		tab = 'users';
	}

	async function addConfirmed(): Promise<void> {
		if (!group || addPicked.size === 0) {
			return;
		}

		busy = true;

		try {
			await post(`/iam/groups/${encodeURIComponent(group.name)}/members`, { members: [...addPicked] });

			Notify.success(t('web.iamGroup.membersAdded', { count: addPicked.size }));
			addOpen = false;
			await refresh();
		} catch (err) {
			Notify.error(t('web.iamGroup.updateFailed'), { detail: (err as Error).message });
		} finally {
			busy = false;
		}
	}

	function askRemove(rows: MemberRow[]): void {
		if (rows.length === 0) {
			return;
		}

		removeRows = rows;
		removeOpen = true;
	}

	async function removeConfirmed(): Promise<void> {
		if (!group) {
			return;
		}

		const groupName = group.name;

		const outcome = await runEach(
			removeRows,
			(row) => api(`/iam/groups/${encodeURIComponent(groupName)}/members`, {
				method: 'DELETE',
				body: JSON.stringify({ members: [row.id] })
			}),
			(row) => row.username
		);

		selectedMembers = new Set();
		notifyEach(outcome, t('web.iamGroupDetail.usersRemoved', { count: outcome.done }), t('web.iamGroup.updateFailed'));
		await refresh();
	}

	function openEdit(): void {
		if (!group) {
			return;
		}

		editName = group.name;
		editDescription = group.description;
		editOpen = true;
	}

	const editNameError = $derived(editName && !IAM_NAME.test(editName.trim()) ? t('web.iamGroup.nameRule') : '');

	async function saveEdit(): Promise<void> {
		if (!group) {
			return;
		}

		busy = true;

		const nextName = editName.trim();
		const body: Record<string, unknown> = { description: editDescription.trim() };

		if (nextName !== group.name) {
			body.name = nextName;
		}

		try {
			const result = await patch(`/iam/groups/${encodeURIComponent(group.name)}`, body);

			editOpen = false;

			if (result.group.name !== name) {
				await goto(groupHref(result.group.name));
			}

			await refresh();
		} catch (err) {
			Notify.error(t('web.iamGroup.updateFailed'), { detail: (err as Error).message });
		} finally {
			busy = false;
		}
	}

	async function deleteConfirmed(): Promise<void> {
		if (!group) {
			return;
		}

		try {
			await del(`/iam/groups/${encodeURIComponent(group.name)}`);

			Notify.success(t('web.iamGroup.removed', { name: group.name }));
			await goto('/console/iam/groups');
		} catch (err) {
			Notify.error(t('web.iamGroup.updateFailed'), { detail: (err as Error).message });
		}
	}

	function memberActions(row: MemberRow): ContextMenuItem[] {
		const targets = selectedMembers.has(row.id) && pickedMembers.length > 1 ? pickedMembers : [row];

		return [
			{
				label: t('web.iamGroup.openAccount'),
				icon: 'circleInfo',
				action: () => goto(`/console/accounts/${encodeURIComponent(row.id)}`)
			},
			{ separator: true },
			{
				label: t('web.iamGroupDetail.removeUsers', { count: targets.length }),
				icon: 'userMinus',
				color: 'danger',
				disabled: !!denied('iam:UpdateGroup'),
				hint: denied('iam:UpdateGroup') || undefined,
				action: () => askRemove(targets)
			}
		];
	}

	const summaryCells: InfoCell[] = $derived(
		!group
			? []
			: [
					{ label: t('web.iamGroupDetail.groupName'), value: group.name },
					{ label: t('web.iamList.colCreationTime'), value: fmtDateTime(group.createdAt) },
					{ id: 'resourceId', label: t('web.iamPolicyDetail.resourceId'), colSpan: 2 },
					{ label: t('web.iamPolicyDetail.createdBy'), value: group.createdBy ?? '–' },
					{ label: t('web.iamPolicyDetail.edited'), value: fmtDateTime(group.updatedAt) },
					{ label: t('web.iam.colDescription'), value: group.description || '–', colSpan: 2 }
				]
	);

	const memberColumns: Column[] = $derived([
		{ id: 'username', label: t('web.iamList.colUserName'), sortable: true, width: 240 },
		{ id: 'displayName', label: t('web.iamList.colDisplayName'), sortable: true, width: 200 },
		{ id: 'lastSignIn', label: t('web.iamList.colLastSignIn'), sortable: true, width: 180 },
		{ id: 'created', label: t('web.iamList.colCreationTime'), sortable: true, width: 180 }
	]);

	const auditColumns: Column[] = $derived([
		{ id: 'when', label: t('web.iam.colWhen'), sortable: true, width: 180 },
		{ id: 'action', label: t('web.iam.colAction'), sortable: true, width: 200 },
		{ id: 'actor', label: t('web.iam.colActor'), sortable: true, width: 160 },
		{ id: 'detail', label: t('web.iam.colDetail') }
	]);
</script>

<svelte:head><title>{group?.name ?? name} | Luna Console</title></svelte:head>

{#if missing}
	<PageHeader title={name} description={t('web.iamGroup.kind')} />
	<Flash kind="error">
		{t('web.iamGroup.notFound', { name })}
		<a href="/console/iam/groups">{t('web.iamList.backToGroups')}</a>
	</Flash>
{:else if group}
	<PageHeader title={group.name} description={group.description || t('web.iamGroup.kind')} info>
		{#snippet actions()}
			<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="iam-group-detail" />
			<Btn
				icon="trash"
				disabled={!!denied('iam:DeleteGroup')}
				title={denied('iam:DeleteGroup') || undefined}
				onclick={() => (deleteOpen = true)}
			>
				{t('web.common.delete')}
			</Btn>
			<Btn
				variant="primary"
				icon="pen"
				disabled={!!denied('iam:UpdateGroup')}
				title={denied('iam:UpdateGroup') || undefined}
				onclick={openEdit}
			>
				{t('web.common.edit')}
			</Btn>
		{/snippet}
	</PageHeader>

	<Panel title={t('web.iamGroupDetail.summary')}>
		<InfoGrid cells={summaryCells}>
			{#snippet custom(cell)}
				{#if cell.id === 'resourceId'}
					<ResourceIdValue value={iamResourceId('group', group!.name)} label={t('web.iamPolicyDetail.resourceId')} />
				{/if}
			{/snippet}
		</InfoGrid>
	</Panel>

	<div class="gap"></div>

	<Tabs
		tabs={[
			{ id: 'users', label: t('web.iamGroupDetail.tabUsers', { count: members.length }) },
			{ id: 'permissions', label: t('web.iamGroupDetail.tabPermissions') },
			{ id: 'tags', label: t('web.iamGroupDetail.tabTags') },
			{ id: 'activity', label: t('web.iamGroupDetail.tabActivity') }
		]}
		bind:active={tab}
	/>

	<div class="tabbody">
		{#if tab === 'users'}
			<Panel
				title={t('web.iamGroupDetail.usersPanel')}
				count={members.length}
				description={t('web.iamGroup.membersTabHint')}
				flush
			>
				{#snippet actions()}
					<Btn
						icon="userMinus"
						disabled={pickedMembers.length === 0 || !!denied('iam:UpdateGroup')}
						title={pickedMembers.length === 0 ? t('web.iamGroupDetail.pickToRemove') : denied('iam:UpdateGroup') || undefined}
						onclick={() => askRemove(pickedMembers)}
					>
						{t('web.common.remove')}
					</Btn>
					<Btn
						variant="primary"
						icon="userPlus"
						disabled={!!denied('iam:UpdateGroup')}
						title={denied('iam:UpdateGroup') || undefined}
						onclick={openAdd}
					>
						{t('web.iamList.addUsers')}
					</Btn>
				{/snippet}
				<DataTable
					columns={memberColumns}
					rows={members}
					getId={(row) => row.id}
					selectable="multi"
					bind:selected={selectedMembers}
					rowActions={memberActions}
					rowLabel={(row) => row.username}
					resourceId={(row) => iamResourceId('account', row.username)}
					sortValue={(row, col) =>
						col === 'lastSignIn'
							? (row.account?.lastSignInAt ?? 0)
							: col === 'created'
								? (row.account?.createdAt ?? 0)
								: col === 'displayName'
									? (row.account?.displayName ?? '')
									: null}
					emptyTitle={t('web.iamGroupDetail.noUsers')}
					emptyText={t('web.iamGroup.noMembers')}
				>
					{#snippet cell(row, col)}
						{#if col === 'username'}
							<span class="who">
								{#if row.account}
									<AccountAvatar account={row.account} size="1.25rem" />
								{/if}
								<a href="/console/accounts/{row.id}">{row.username}</a>
							</span>
						{:else if col === 'displayName'}
							<span class:dim={!row.account?.displayName}>{row.account?.displayName || '–'}</span>
						{:else if col === 'lastSignIn'}
							<span class="dim">
								{row.account?.lastSignInAt ? fmtDateTime(row.account.lastSignInAt) : t('web.accounts.never')}
							</span>
						{:else if col === 'created'}
							<span class="dim">{row.account ? fmtDateTime(row.account.createdAt) : '–'}</span>
						{/if}
					{/snippet}
				</DataTable>
			</Panel>
		{:else if tab === 'permissions'}
			<PermissionsPolicies subject={{ kind: 'group', name: group.name }} {group} onchange={refresh} />
		{:else if tab === 'tags'}
			<ResourceMeta id={iamResourceId('group', group.name)} />
		{:else if tab === 'activity'}
			<Panel flush>
				<ResourceTable
					tableId="iam-group-audit"
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

	<Modal title={t('web.iamGroup.addMembersTitle', { name: group.name })} bind:open={addOpen} wide>
		<p class="note dim">{t('web.iamGroup.addMembersLead')}</p>
		<AccountPickTable
			tableId="iam-group-add-users"
			{accounts}
			bind:selected={addPicked}
			locked={(account) => memberIds.has(account.id)}
		/>

		{#snippet footer()}
			<Btn onclick={() => (addOpen = false)}>{t('web.common.cancel')}</Btn>
			<Btn variant="primary" loading={busy} disabled={addPicked.size === 0} onclick={() => void addConfirmed()}>
				{t('web.iamGroup.addMembersAction', { count: addPicked.size })}
			</Btn>
		{/snippet}
	</Modal>

	<Modal title={t('web.iamGroup.editTitle', { name: group.name })} bind:open={editOpen}>
		<FormGrid>
			<label class="field">
				<span class="lbl">{t('web.iamGroup.name')}</span>
				<span class="hint">{t('web.iamGroup.renameHint')}</span>
				<input class="input" type="text" spellcheck="false" autocapitalize="none" bind:value={editName} />
				{#if editNameError}<span class="err">{editNameError}</span>{/if}
			</label>
			<label class="field">
				<span class="lbl">{t('web.iamGroup.description')}</span>
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
		bind:open={removeOpen}
		title={t('web.iamGroupDetail.removeTitle', { count: removeRows.length })}
		lead={t('web.iamGroupDetail.removeLead', { names: removeRows.map((row) => row.username).join(', '), group: group.name })}
		notes={[t('web.iamGroup.removeMemberNote')]}
		confirmLabel={t('web.common.remove')}
		onconfirm={() => void removeConfirmed()}
	/>

	<ConfirmModal
		bind:open={deleteOpen}
		title={t('web.iam.deleteGroupTitle', { count: 1 })}
		lead={t('web.iam.deleteGroupLead', { names: group.name })}
		notes={[t('web.iam.deleteGroupNote')]}
		confirmLabel={t('web.common.delete')}
		onconfirm={() => void deleteConfirmed()}
	/>
{/if}

<style lang="scss">
	.tabbody {
		margin-top: 1rem;
	}

	.gap {
		height: 1rem;
	}

	.who {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}

	.note {
		margin: 0 0 1rem;
		font-size: 0.8125rem;
	}
</style>
