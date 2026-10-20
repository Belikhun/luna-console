<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, del, patch, post, put } from '$lib/api';
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
	import MultiSelect from '$lib/components/MultiSelect.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import PolicyEditor from '$lib/components/PolicyEditor.svelte';
	import { POLICY_TEMPLATE, type PolicyValidation } from '$lib/components/policyeditor';
	import type { InfoCell } from '$lib/components/grid';
	import type { Column } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { Notify } from '$lib/notifications.svelte';
	import { clearCrumbLabel, setCrumbLabel } from '$lib/crumbs.svelte';
	import type { AccountSummary } from '$core/accounts';
	import type { GroupMember, InlineView } from '$core/iam';
	import {
		IAM_NAME,
		groupHref,
		iamAuditLabel,
		iamAuditTone,
		keyIamAudit,
		policyHref,
		policyKindLabel,
		type GroupRow,
		type IamAuditRow,
		type PolicyRow
	} from '../../iam';

	/**
	 * One group: who is in it, which policies it carries (attached by name, or
	 * written inline on the group itself), and what was done to it. A member
	 * gets everything the group carries, which is the whole point of a group.
	 */

	const name = $derived(page.params.name ?? '');

	let group = $state<GroupRow | null>(null);
	let audit: IamAuditRow[] = $state([]);
	let accounts: AccountSummary[] = $state([]);
	let catalog: PolicyRow[] = $state([]);
	let missing = $state(false);
	let loading = $state(false);
	let lastUpdated: number | null = $state(null);
	let tab = $state(page.url.searchParams.get('tab') ?? 'details');

	let editOpen = $state(false);
	let editName = $state('');
	let editDescription = $state('');

	let addMembersOpen = $state(false);
	let membersToAdd: string[] = $state([]);

	let removeMemberOpen = $state(false);
	let memberToRemove: GroupMember | null = $state(null);

	let attachOpen = $state(false);
	let policiesToAttach: string[] = $state([]);

	let inlineOpen = $state(false);
	let inlineName = $state('');
	let inlineYaml = $state('');
	let inlineEditing = $state(false);
	let inlineValidation = $state<PolicyValidation | null>(null);

	let removeInlineOpen = $state(false);
	let inlineToRemove: InlineView | null = $state(null);

	let deleteOpen = $state(false);
	let busy = $state(false);

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const [data, accountData, policyData] = await Promise.all([
				api(`/iam/groups/${encodeURIComponent(name)}`),
				api('/accounts'),
				api('/iam/policies')
			]);

			group = data.group;
			audit = keyIamAudit(data.audit);
			accounts = accountData.accounts;
			catalog = policyData.policies;
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
	}

	$effect(() => {
		if (!group) {
			return;
		}

		const path = groupHref(name);

		setCrumbLabel(path, group.name);

		return () => clearCrumbLabel(path);
	});

	onMount(() => {
		void refresh();
	});

	/** The group's attached policies as rows, with what the catalog knows about each */
	const attachedRows = $derived.by(() => {
		if (!group) {
			return [];
		}

		return group.policies.map((policyName) => {
			const known = catalog.find((policy) => policy.name.toLowerCase() === policyName.toLowerCase());

			return { name: policyName, policy: known ?? null };
		});
	});

	type AttachedRow = (typeof attachedRows)[number];

	const memberOptions = $derived.by(() => {
		const present = new Set((group?.members ?? []).map((member) => member.id));

		return accounts
			.filter((account) => !present.has(account.id))
			.map((account) => ({ value: account.id, label: account.username }));
	});

	const attachOptions = $derived.by(() => {
		const present = new Set((group?.policies ?? []).map((policyName) => policyName.toLowerCase()));

		return catalog
			.filter((policy) => !present.has(policy.name.toLowerCase()))
			.map((policy) => ({ value: policy.name, label: `${policy.name} (${policyKindLabel(policy)})` }));
	});

	const editNameError = $derived(editName && !IAM_NAME.test(editName.trim()) ? t('web.iamGroup.nameRule') : '');
	const inlineNameError = $derived(inlineName && !IAM_NAME.test(inlineName.trim()) ? t('web.iamGroup.nameRule') : '');

	const inlineNameTaken = $derived(
		!inlineEditing && !!group && group.inline.some((inline) => inline.name.toLowerCase() === inlineName.trim().toLowerCase())
	);

	const inlineReady = $derived(!!inlineName.trim() && !inlineNameError && !inlineNameTaken && !!inlineValidation?.ok);

	function openEdit(): void {
		if (!group) {
			return;
		}

		editName = group.name;
		editDescription = group.description;
		editOpen = true;
	}

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

	function openAddMembers(): void {
		membersToAdd = [];
		addMembersOpen = true;
	}

	async function addMembers(): Promise<void> {
		if (!group || membersToAdd.length === 0) {
			return;
		}

		busy = true;

		try {
			await post(`/iam/groups/${encodeURIComponent(group.name)}/members`, { members: membersToAdd });

			Notify.success(t('web.iamGroup.membersAdded', { count: membersToAdd.length }));
			addMembersOpen = false;
			await refresh();
		} catch (err) {
			Notify.error(t('web.iamGroup.updateFailed'), { detail: (err as Error).message });
		} finally {
			busy = false;
		}
	}

	function askRemoveMember(member: GroupMember): void {
		memberToRemove = member;
		removeMemberOpen = true;
	}

	async function removeMemberConfirmed(): Promise<void> {
		if (!group || !memberToRemove) {
			return;
		}

		const member = memberToRemove;

		try {
			await api(`/iam/groups/${encodeURIComponent(group.name)}/members`, {
				method: 'DELETE',
				body: JSON.stringify({ members: [member.id] })
			});

			Notify.success(t('web.iamGroup.memberRemoved', { name: member.username }));
			await refresh();
		} catch (err) {
			Notify.error(t('web.iamGroup.updateFailed'), { detail: (err as Error).message });
		}
	}

	function openAttach(): void {
		policiesToAttach = [];
		attachOpen = true;
	}

	async function attachPolicies(): Promise<void> {
		if (!group || policiesToAttach.length === 0) {
			return;
		}

		busy = true;

		const failed: string[] = [];

		for (const policyName of policiesToAttach) {
			try {
				await post('/iam/attachments', { group: group.name, policy: policyName });
			} catch (err) {
				failed.push(`${policyName}: ${(err as Error).message}`);
			}
		}

		busy = false;
		attachOpen = false;

		if (failed.length === 0) {
			Notify.success(t('web.iamGroup.attached', { count: policiesToAttach.length }));
		} else {
			Notify.error(t('web.iamGroup.attachFailed'), { detail: failed.join('\n') });
		}

		await refresh();
	}

	async function detach(policyName: string): Promise<void> {
		if (!group) {
			return;
		}

		try {
			await api('/iam/attachments', {
				method: 'DELETE',
				body: JSON.stringify({ group: group.name, policy: policyName })
			});

			Notify.success(t('web.iamGroup.detached', { name: policyName }));
			await refresh();
		} catch (err) {
			Notify.error(t('web.iamGroup.updateFailed'), { detail: (err as Error).message });
		}
	}

	function openInline(existing: InlineView | null): void {
		inlineEditing = existing !== null;
		inlineName = existing?.name ?? '';
		inlineYaml = existing?.yaml ?? POLICY_TEMPLATE;
		inlineValidation = null;
		inlineOpen = true;
	}

	async function saveInline(): Promise<void> {
		if (!group || !inlineReady) {
			return;
		}

		busy = true;

		try {
			await put('/iam/inline', { group: group.name, name: inlineName.trim(), yaml: inlineYaml });

			Notify.success(t('web.iamGroup.inlineSaved', { name: inlineName.trim() }));
			inlineOpen = false;
			await refresh();
		} catch (err) {
			Notify.error(t('web.iamGroup.updateFailed'), { detail: (err as Error).message });
		} finally {
			busy = false;
		}
	}

	function askRemoveInline(inline: InlineView): void {
		inlineToRemove = inline;
		removeInlineOpen = true;
	}

	async function removeInlineConfirmed(): Promise<void> {
		if (!group || !inlineToRemove) {
			return;
		}

		const inline = inlineToRemove;

		try {
			await api('/iam/inline', {
				method: 'DELETE',
				body: JSON.stringify({ group: group.name, name: inline.name })
			});

			Notify.success(t('web.iamGroup.inlineRemoved', { name: inline.name }));
			await refresh();
		} catch (err) {
			Notify.error(t('web.iamGroup.updateFailed'), { detail: (err as Error).message });
		}
	}

	async function removeConfirmed(): Promise<void> {
		if (!group) {
			return;
		}

		try {
			await del(`/iam/groups/${encodeURIComponent(group.name)}`);

			Notify.success(t('web.iamGroup.removed', { name: group.name }));
			await goto('/console/iam?tab=groups');
		} catch (err) {
			Notify.error(t('web.iamGroup.updateFailed'), { detail: (err as Error).message });
		}
	}

	const verbs: ContextMenuItem[] = $derived(
		!group
			? []
			: [
					{ label: t('web.iamGroup.editDetails'), icon: 'pen', action: openEdit },
					{ label: t('web.iamGroup.addMembers'), icon: 'userPlus', action: openAddMembers },
					{ label: t('web.iamGroup.attachPolicy'), icon: 'link', action: openAttach },
					{ label: t('web.iamGroup.addInline'), icon: 'fileLines', action: () => openInline(null) },
					{ separator: true },
					{
						label: t('web.iam.deleteGroupAction', { count: 1 }),
						icon: 'trash',
						color: 'danger',
						action: () => {
							deleteOpen = true;
						}
					}
				]
	);

	function memberActions(row: GroupMember): ContextMenuItem[] {
		return [
			{
				label: t('web.iamGroup.openAccount'),
				icon: 'circleInfo',
				action: () => goto(`/console/accounts/${row.id}`)
			},
			{ separator: true },
			{
				label: t('web.iamGroup.removeMember'),
				icon: 'userMinus',
				color: 'danger',
				action: () => askRemoveMember(row)
			}
		];
	}

	function attachedActions(row: AttachedRow): ContextMenuItem[] {
		return [
			{
				label: t('web.iam.openPolicy'),
				icon: 'circleInfo',
				disabled: !row.policy,
				hint: row.policy ? undefined : t('web.iamGroup.policyUnknown'),
				action: () => goto(policyHref(row.name))
			},
			{ separator: true },
			{
				label: t('web.iamGroup.detach'),
				icon: 'unlink',
				color: 'danger',
				action: () => detach(row.name)
			}
		];
	}

	function inlineActions(row: InlineView): ContextMenuItem[] {
		return [
			{ label: t('web.iamGroup.editInline'), icon: 'pen', action: () => openInline(row) },
			{ separator: true },
			{
				label: t('web.iamGroup.removeInline'),
				icon: 'trash',
				color: 'danger',
				action: () => askRemoveInline(row)
			}
		];
	}

	const summaryCells: InfoCell[] = $derived(
		!group
			? []
			: [
					{ label: t('web.iam.colName'), value: group.name, copyable: true },
					{ id: 'groupId', label: t('web.iamGroup.groupId') },
					{ label: t('web.iam.colDescription'), value: group.description || '–', colSpan: 2 },
					{ label: t('web.iam.colMembers'), value: group.members.length },
					{ label: t('web.iam.colPolicies'), value: group.policies.length },
					{ label: t('web.iamGroup.inlineCount'), value: group.inline.length },
					{
						label: t('web.iam.colCreated'),
						value: `${fmtDateTime(group.createdAt)}${group.createdBy ? ` · ${group.createdBy}` : ''}`
					},
					{
						label: t('web.iam.colUpdated'),
						value: `${fmtDateTime(group.updatedAt)}${group.updatedBy ? ` · ${group.updatedBy}` : ''}`
					}
				]
	);

	const memberColumns: Column[] = $derived([
		{ id: 'username', label: t('web.iamGroup.colUsername'), sortable: true, width: 240 },
		{ id: 'id', label: t('web.iamGroup.colAccountId'), width: 260 }
	]);

	const attachedColumns: Column[] = $derived([
		{ id: 'name', label: t('web.iam.colName'), sortable: true, width: 240 },
		{ id: 'kind', label: t('web.iam.colKind'), sortable: true, width: 120 },
		{ id: 'statements', label: t('web.iam.colStatements'), sortable: true, width: 110 },
		{ id: 'description', label: t('web.iam.colDescription') }
	]);

	const inlineColumns: Column[] = $derived([
		{ id: 'name', label: t('web.iam.colName'), sortable: true, width: 240 },
		{ id: 'statements', label: t('web.iam.colStatements'), sortable: true, width: 110 },
		{ id: 'updated', label: t('web.iam.colUpdated'), sortable: true, width: 220 }
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
		<a href="/console/iam?tab=groups">{t('web.iam.back')}</a>
	</Flash>
{:else if group}
	<PageHeader title={group.name} description={group.description || t('web.iamGroup.kind')} info>
		{#snippet actions()}
			<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="iam-group-detail" />
			<Dropdown label={t('web.common.actions')} menu={verbs} />
			<Btn icon="pen" onclick={openEdit}>{t('web.iamGroup.editDetails')}</Btn>
			<Btn variant="primary" icon="userPlus" onclick={openAddMembers}>{t('web.iamGroup.addMembers')}</Btn>
		{/snippet}
	</PageHeader>

	<Tabs
		tabs={[
			{ id: 'details', label: t('web.iamGroup.tabDetails') },
			{ id: 'members', label: t('web.iamGroup.tabMembers') },
			{ id: 'policies', label: t('web.iamGroup.tabPolicies') },
			{ id: 'activity', label: t('web.iamGroup.tabActivity') }
		]}
		bind:active={tab}
	/>

	<div class="tabbody">
		{#if tab === 'details'}
			<Panel title={t('web.iamGroup.summary')}>
				<InfoGrid cells={summaryCells}>
					{#snippet custom(cell)}
						{#if cell.id === 'groupId'}
							<span class="mono dim">{group!.id}</span>
						{/if}
					{/snippet}
				</InfoGrid>
			</Panel>
		{:else if tab === 'members'}
			<Panel
				title={t('web.iamGroup.membersPanel')}
				count={group.members.length}
				description={t('web.iamGroup.membersTabHint')}
				flush
			>
				{#snippet actions()}
					<Btn icon="userPlus" onclick={openAddMembers}>{t('web.iamGroup.addMembers')}</Btn>
				{/snippet}
				{#if group.members.length}
					<DataTable
						columns={memberColumns}
						rows={group.members}
						getId={(row) => row.id}
						rowActions={memberActions}
						rowLabel={(row) => row.username}
						onRowClick={(row) => goto(`/console/accounts/${row.id}`)}
					>
						{#snippet cell(row, col)}
							{#if col === 'username'}
								<a href="/console/accounts/{row.id}"><b>{row.username}</b></a>
							{:else if col === 'id'}
								<span class="mono dim">{row.id}</span>
							{/if}
						{/snippet}
					</DataTable>
				{:else}
					<p class="none dim">{t('web.iamGroup.noMembers')}</p>
				{/if}
			</Panel>
		{:else if tab === 'policies'}
			<Panel
				title={t('web.iamGroup.attachedPanel')}
				count={group.policies.length}
				description={t('web.iamGroup.attachedHint')}
				flush
			>
				{#snippet actions()}
					<Btn icon="link" onclick={openAttach}>{t('web.iamGroup.attachPolicy')}</Btn>
				{/snippet}
				{#if attachedRows.length}
					<DataTable
						columns={attachedColumns}
						rows={attachedRows}
						getId={(row) => row.name}
						rowActions={attachedActions}
						rowLabel={(row) => row.name}
						sortValue={(row, col) =>
							col === 'kind'
								? (row.policy?.builtin ? 0 : 1)
								: col === 'statements'
									? (row.policy?.document.Statement.length ?? 0)
									: null}
					>
						{#snippet cell(row, col)}
							{#if col === 'name'}
								{#if row.policy}
									<a href={policyHref(row.name)}><b>{row.name}</b></a>
								{:else}
									<b>{row.name}</b>
								{/if}
							{:else if col === 'kind'}
								{#if row.policy}
									<StatusBadge state={row.policy.builtin ? 'info' : 'ok'} label={policyKindLabel(row.policy)} />
								{:else}
									<StatusBadge state="warning" label={t('web.iamGroup.policyUnknown')} />
								{/if}
							{:else if col === 'statements'}
								<span class="mono">{row.policy?.document.Statement.length ?? '–'}</span>
							{:else if col === 'description'}
								<span class="dim text">{row.policy?.description || '–'}</span>
							{/if}
						{/snippet}
					</DataTable>
				{:else}
					<p class="none dim">{t('web.iamGroup.noAttached')}</p>
				{/if}
			</Panel>

			<div class="gap"></div>

			<Panel
				title={t('web.iamGroup.inlinePanel')}
				count={group.inline.length}
				description={t('web.iamGroup.inlineHint')}
				flush
			>
				{#snippet actions()}
					<Btn icon="plus" onclick={() => openInline(null)}>{t('web.iamGroup.addInline')}</Btn>
				{/snippet}
				{#if group.inline.length}
					<DataTable
						columns={inlineColumns}
						rows={group.inline}
						getId={(row) => row.name}
						rowActions={inlineActions}
						rowLabel={(row) => row.name}
						onRowClick={(row) => openInline(row)}
						sortValue={(row, col) =>
							col === 'statements'
								? row.document.Statement.length
								: col === 'updated'
									? row.updatedAt
									: null}
					>
						{#snippet cell(row, col)}
							{#if col === 'name'}
								<b>{row.name}</b>
							{:else if col === 'statements'}
								<span class="mono">{row.document.Statement.length}</span>
							{:else if col === 'updated'}
								<span class="dim">{fmtDateTime(row.updatedAt)}{row.updatedBy ? ` · ${row.updatedBy}` : ''}</span>
							{/if}
						{/snippet}
					</DataTable>
				{:else}
					<p class="none dim">{t('web.iamGroup.noInline')}</p>
				{/if}
			</Panel>
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

	<Modal title={t('web.iamGroup.addMembersTitle', { name: group.name })} bind:open={addMembersOpen}>
		<p class="modalnote">{t('web.iamGroup.addMembersLead')}</p>
		{#if memberOptions.length}
			<div class="field">
				<span class="lbl">{t('web.iamGroup.members')}</span>
				<MultiSelect
					options={memberOptions}
					bind:value={membersToAdd}
					width="100%"
					placeholder={t('web.iamGroup.noMembersPicked')}
				/>
			</div>
		{:else}
			<Flash kind="info">{t('web.iamGroup.everyoneIn')}</Flash>
		{/if}

		{#snippet footer()}
			<Btn onclick={() => (addMembersOpen = false)}>{t('web.common.cancel')}</Btn>
			<Btn variant="primary" loading={busy} disabled={membersToAdd.length === 0} onclick={addMembers}>
				{t('web.iamGroup.addMembersAction', { count: membersToAdd.length })}
			</Btn>
		{/snippet}
	</Modal>

	<Modal title={t('web.iamGroup.attachTitle', { name: group.name })} bind:open={attachOpen}>
		<p class="modalnote">{t('web.iamGroup.attachLead')}</p>
		{#if attachOptions.length}
			<div class="field">
				<span class="lbl">{t('web.iamGroup.policies')}</span>
				<MultiSelect
					options={attachOptions}
					bind:value={policiesToAttach}
					width="100%"
					placeholder={t('web.iamGroup.noPoliciesPicked')}
				/>
			</div>
		{:else}
			<Flash kind="info">{t('web.iamGroup.everythingAttached')}</Flash>
		{/if}

		{#snippet footer()}
			<Btn onclick={() => (attachOpen = false)}>{t('web.common.cancel')}</Btn>
			<Btn variant="primary" loading={busy} disabled={policiesToAttach.length === 0} onclick={attachPolicies}>
				{t('web.iamGroup.attachAction', { count: policiesToAttach.length })}
			</Btn>
		{/snippet}
	</Modal>

	<Modal
		title={inlineEditing ? t('web.iamGroup.editInlineTitle', { name: inlineName }) : t('web.iamGroup.addInlineTitle')}
		bind:open={inlineOpen}
		wide
	>
		<label class="field">
			<span class="lbl">{t('web.iamGroup.inlineName')}</span>
			<span class="hint">{t('web.iamGroup.inlineNameHint')}</span>
			<input
				class="input"
				type="text"
				spellcheck="false"
				autocapitalize="none"
				disabled={inlineEditing}
				bind:value={inlineName}
			/>
			{#if inlineNameError}
				<span class="err">{inlineNameError}</span>
			{:else if inlineNameTaken}
				<span class="err">{t('web.iamGroup.inlineNameTaken')}</span>
			{/if}
		</label>

		<PolicyEditor
			bind:value={inlineYaml}
			path="iam/{inlineName.trim() || 'inline'}.yaml"
			height="20rem"
			onvalidate={(result) => (inlineValidation = result)}
			onsave={saveInline}
		/>

		{#snippet footer()}
			<Btn onclick={() => (inlineOpen = false)}>{t('web.common.cancel')}</Btn>
			<Btn variant="primary" icon="floppyDisk" loading={busy} disabled={!inlineReady} onclick={saveInline}>
				{t('web.common.save')}
			</Btn>
		{/snippet}
	</Modal>

	<ConfirmModal
		bind:open={removeMemberOpen}
		title={t('web.iamGroup.removeMemberTitle')}
		lead={t('web.iamGroup.removeMemberLead', { name: memberToRemove?.username ?? '', group: group.name })}
		notes={[t('web.iamGroup.removeMemberNote')]}
		confirmLabel={t('web.common.remove')}
		onconfirm={() => void removeMemberConfirmed()}
	/>

	<ConfirmModal
		bind:open={removeInlineOpen}
		title={t('web.iamGroup.removeInlineTitle')}
		lead={t('web.iamGroup.removeInlineLead', { name: inlineToRemove?.name ?? '', group: group.name })}
		notes={[t('web.iamGroup.removeInlineNote')]}
		confirmLabel={t('web.common.remove')}
		onconfirm={() => void removeInlineConfirmed()}
	/>

	<ConfirmModal
		bind:open={deleteOpen}
		title={t('web.iam.deleteGroupTitle', { count: 1 })}
		lead={t('web.iam.deleteGroupLead', { names: group.name })}
		notes={[t('web.iam.deleteGroupNote')]}
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

	.none {
		margin: 0;
		padding: 1rem 1.25rem;
		font-size: 0.875rem;
	}

	.modalnote {
		margin: 0 0 0.75rem;
		font-size: 0.8125rem;
	}

	.text {
		@include ellipsis;

		display: block;
	}
</style>
