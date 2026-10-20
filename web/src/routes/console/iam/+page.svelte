<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { api } from '$lib/api';
	import { fmtDateTime } from '$lib/format';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import OverviewBar from '$lib/components/OverviewBar.svelte';
	import OverviewCell from '$lib/components/OverviewCell.svelte';
	import type { Column } from '$lib/components/table';
	import { Authz } from '$lib/authz.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import {
		attachedCount,
		groupHref,
		iamAuditLabel,
		iamAuditTone,
		keyIamAudit,
		policyHref,
		type GroupRow,
		type IamAuditRow,
		type PolicyRow
	} from '$lib/iam';
	import type { AccountSummary } from '$core/accounts';
	import type { InlinePolicyCounts } from '$core/iam';

	/**
	 * The access management dashboard, AWS's IAM Dashboard: what is wrong with
	 * the way access is set up right now, how many of each thing exist, the tools,
	 * and the latest changes. Every fact here is computed from the lists the
	 * other screens show, so it can never disagree with them.
	 */

	/** The built-in policy that grants everything; core's `ADMINISTRATOR_POLICY`. */
	const ADMINISTRATOR = 'AdministratorAccess';

	/** Recent changes shown here; the full trail has its own screen. */
	const RECENT = 8;

	interface Recommendation {
		id: string;
		ok: boolean;
		text: string;
		/** where the operator goes to act on it */
		href?: string;
		link?: string;
	}

	let accounts: AccountSummary[] = $state([]);
	let groups: GroupRow[] = $state([]);
	let policies: PolicyRow[] = $state([]);
	let audit: IamAuditRow[] = $state([]);
	let inline = $state<InlinePolicyCounts | null>(null);
	let loading = $state(false);
	let loaded = $state(false);
	let lastUpdated: number | null = $state(null);

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const [accountData, groupData, policyData] = await Promise.all([
				api<{ accounts: AccountSummary[] }>('/accounts'),
				api<{ groups: GroupRow[] }>('/iam/groups'),
				api<{ policies: PolicyRow[] }>('/iam/policies')
			]);

			accounts = accountData.accounts;
			groups = groupData.groups;
			policies = policyData.policies;
			lastUpdated = Date.now();
		} catch (err) {
			Notify.error(t('web.iam.loadFailed'), { detail: (err as Error).message });
		} finally {
			loading = false;
			loaded = true;
		}

		// the trail and the inline count are extras: either failing leaves the rest standing
		const [auditData, overview] = await Promise.allSettled([
			api<{ audit: IamAuditRow[] }>(`/iam/audit?limit=${RECENT}`),
			api<{ inline: InlinePolicyCounts }>('/iam/overview')
		]);

		audit = auditData.status === 'fulfilled'
			? keyIamAudit(auditData.value.audit)
			: [];

		inline = overview.status === 'fulfilled'
			? overview.value.inline
			: null;
	}

	onMount(() => {
		void refresh();
	});

	const administrator = $derived(policies.find((policy) => policy.name === ADMINISTRATOR));

	/** Groups carrying the administrator policy; every member is an administrator. */
	const adminGroups = $derived(
		groups.filter((group) => group.policies.some((name) => name.toLowerCase() === ADMINISTRATOR.toLowerCase()))
	);

	/** Enabled accounts the administrator policy reaches, directly or through a group; core's own rule. */
	const administrators = $derived(
		accounts.filter(
			(account) =>
				account.enabled &&
				((administrator?.attachedTo.accounts ?? []).includes(account.username) ||
					adminGroups.some((group) => group.members.some((member) => member.id === account.id)))
		)
	);

	const directAdmins = $derived(administrator?.attachedTo.accounts ?? []);

	const noPassword = $derived(accounts.filter((account) => account.enabled && !account.hasPassword));

	const ungrouped = $derived(
		accounts.filter((account) => !groups.some((group) => group.members.some((member) => member.id === account.id)))
	);

	const unusedPolicies = $derived(policies.filter((policy) => !policy.builtin && attachedCount(policy) === 0));

	const locked = $derived(accounts.filter((account) => account.enabled && account.lockedUntil));

	const managedCount = $derived(policies.filter((policy) => !policy.builtin).length);
	const builtinCount = $derived(policies.length - managedCount);

	const recommendations: Recommendation[] = $derived.by(() => {
		if (!loaded) {
			return [];
		}

		const out: Recommendation[] = [];
		const adminCount = administrators.length;

		out.push({
			id: 'admins',
			ok: adminCount > 1,
			text: adminCount === 0
				? t('web.iamDashboard.recNoAdmin')
				: adminCount === 1
					? t('web.iamDashboard.recOneAdmin', { name: administrators[0]!.username })
					: t('web.iamDashboard.recAdmins', { count: adminCount }),
			href: policyHref(ADMINISTRATOR),
			link: t('web.iamDashboard.viewPolicy')
		});

		out.push({
			id: 'direct',
			ok: directAdmins.length === 0,
			text: directAdmins.length === 0
				? t('web.iamDashboard.recNoDirectAdmin')
				: t('web.iamDashboard.recDirectAdmin', { count: directAdmins.length, names: directAdmins.join(', ') }),
			href: directAdmins.length ? policyHref(ADMINISTRATOR) : undefined,
			link: t('web.iamDashboard.viewEntities')
		});

		out.push({
			id: 'password',
			ok: noPassword.length === 0,
			text: noPassword.length === 0
				? t('web.iamDashboard.recPasswords')
				: t('web.iamDashboard.recNoPassword', { count: noPassword.length, names: noPassword.map((account) => account.username).join(', ') }),
			href: noPassword.length ? '/console/accounts' : undefined,
			link: t('web.iamDashboard.viewUsers')
		});

		out.push({
			id: 'groups',
			ok: ungrouped.length === 0,
			text: ungrouped.length === 0
				? t('web.iamDashboard.recGrouped')
				: t('web.iamDashboard.recUngrouped', { count: ungrouped.length, names: ungrouped.map((account) => account.username).join(', ') }),
			href: ungrouped.length ? '/console/iam/groups' : undefined,
			link: t('web.iamDashboard.viewGroups')
		});

		out.push({
			id: 'unused',
			ok: unusedPolicies.length === 0,
			text: unusedPolicies.length === 0
				? t('web.iamDashboard.recPoliciesUsed')
				: t('web.iamDashboard.recUnused', { count: unusedPolicies.length, names: unusedPolicies.map((policy) => policy.name).join(', ') }),
			href: unusedPolicies.length ? '/console/iam/policies' : undefined,
			link: t('web.iamDashboard.viewPolicies')
		});

		if (locked.length > 0) {
			out.push({
				id: 'locked',
				ok: false,
				text: t('web.iamDashboard.recLocked', { count: locked.length, names: locked.map((account) => account.username).join(', ') }),
				href: '/console/accounts',
				link: t('web.iamDashboard.viewUsers')
			});
		}

		return out;
	});

	const warnings = $derived(recommendations.filter((entry) => !entry.ok).length);

	const auditColumns: Column[] = $derived([
		{ id: 'when', label: t('web.iam.colWhen'), width: 180 },
		{ id: 'action', label: t('web.iam.colAction'), width: 200 },
		{ id: 'actor', label: t('web.iam.colActor'), width: 140 },
		{ id: 'target', label: t('web.iam.colTarget') }
	]);
</script>

<svelte:head><title>{t('web.iamDashboard.title')} | Luna Console</title></svelte:head>

<PageHeader title={t('web.iamDashboard.title')} description={t('web.iamDashboard.description')} info>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="iam-dashboard" />
		<Btn
			icon="users"
			href="/console/iam/groups/new"
			disabled={!Authz.can('iam:CreateGroup')}
			title={Authz.can('iam:CreateGroup') ? undefined : t('web.common.notAllowed', { action: 'iam:CreateGroup' })}
		>
			{t('web.iamList.createGroup')}
		</Btn>
		<Btn
			variant="primary"
			icon="plus"
			href="/console/iam/policies/new"
			disabled={!Authz.can('iam:CreatePolicy')}
			title={Authz.can('iam:CreatePolicy') ? undefined : t('web.common.notAllowed', { action: 'iam:CreatePolicy' })}
		>
			{t('web.iamList.createPolicy')}
		</Btn>
	{/snippet}
</PageHeader>

<OverviewBar title={t('web.iamDashboard.resources')}>
	<OverviewCell label={t('web.iamDashboard.users')}>
		<a class="count" href="/console/accounts">{loaded ? accounts.length : '–'}</a>
	</OverviewCell>
	<OverviewCell label={t('web.iamDashboard.groups')}>
		<a class="count" href="/console/iam/groups">{loaded ? groups.length : '–'}</a>
	</OverviewCell>
	<OverviewCell label={t('web.iamDashboard.policies')}>
		<a class="count" href="/console/iam/policies">{loaded ? policies.length : '–'}</a>
		{#if loaded}
			<span class="dim">{t('web.iamDashboard.policyKinds', { managed: managedCount, builtin: builtinCount })}</span>
		{/if}
	</OverviewCell>
	<OverviewCell label={t('web.iamDashboard.inline')}>
		{#if inline}
			<span class="count">{inline.accounts + inline.groups}</span>
			<span class="dim">{t('web.iamDashboard.inlineKinds', { accounts: inline.accounts, groups: inline.groups })}</span>
		{:else}
			<span class="dim">–</span>
		{/if}
	</OverviewCell>
</OverviewBar>

<div class="grid">
	<Panel
		title={t('web.iamDashboard.recommendations')}
		count={loaded ? warnings : undefined}
		description={t('web.iamDashboard.recommendationsHint')}
	>
		{#if !loaded}
			<p class="dim none">{t('web.common.loading')}</p>
		{:else}
			<ul class="recs">
				{#each recommendations as entry (entry.id)}
					<li class:ok={entry.ok}>
						<span class="mark">
							<Icon
								name={entry.ok ? 'circleCheck' : 'triangleExclamation'}
								size="1rem"
								style="solid"
								color={entry.ok ? 'var(--success)' : 'var(--warning)'}
							/>
						</span>
						<span class="text">{entry.text}</span>
						{#if entry.href && entry.link}
							<a class="go" href={entry.href}>{entry.link}</a>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</Panel>

	<div class="side">
		<Panel title={t('web.iamDashboard.tools')}>
			<ul class="tools">
				<li>
					<Icon name="flaskVial" size="1rem" style="solid" />
					<span>
						<a href="/console/iam/simulator">{t('web.iamDashboard.simulator')}</a>
						<span class="dim">{t('web.iamDashboard.simulatorHint')}</span>
					</span>
				</li>
				<li>
					<Icon name="tags" size="1rem" style="solid" />
					<span>
						<a href="/console/resources">{t('web.iamDashboard.resourcesTool')}</a>
						<span class="dim">{t('web.iamDashboard.resourcesToolHint')}</span>
					</span>
				</li>
				<li>
					<Icon name="clockRotateLeft" size="1rem" style="solid" />
					<span>
						<a href="/console/iam/activity">{t('web.iamDashboard.activityTool')}</a>
						<span class="dim">{t('web.iamDashboard.activityToolHint')}</span>
					</span>
				</li>
			</ul>
		</Panel>
	</div>
</div>

<div class="gap"></div>

<Panel title={t('web.iamDashboard.recent')} description={t('web.iamDashboard.recentHint')} flush>
	{#snippet actions()}
		<Btn icon="clockRotateLeft" href="/console/iam/activity">{t('web.iamDashboard.viewActivity')}</Btn>
	{/snippet}
	<DataTable
		columns={auditColumns}
		rows={audit}
		getId={(row) => row.key}
		loading={!loaded}
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
			{:else if col === 'target'}
				{#if row.target?.startsWith('group ')}
					<a href={groupHref(row.target.slice(6))}>{row.target}</a>
				{:else if row.target && row.action.startsWith('policy.') && row.action !== 'policy.delete'}
					<a href={policyHref(row.target)}>{row.target}</a>
				{:else}
					<span class:dim={!row.target}>{row.target ?? '–'}</span>
				{/if}
				{#if row.detail}
					<span class="dim"> · {row.detail}</span>
				{/if}
			{/if}
		{/snippet}
	</DataTable>
</Panel>

<style lang="scss">
	.grid {
		display: grid;
		grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
		gap: 1rem;
		margin-top: 1rem;
		align-items: start;

		@include below($bp-medium) {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.side {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.gap {
		height: 1rem;
	}

	.count {
		font-size: 1.5rem;
		font-weight: 700;
		margin-right: 0.5rem;
	}

	.none {
		margin: 0;
		font-size: 0.875rem;
	}

	.recs {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		list-style: none;

		li {
			display: flex;
			align-items: flex-start;
			gap: 0.75rem;
			padding: 0.625rem 0;
			border-bottom: 0.1rem solid var(--border-divider);
			font-size: 0.875rem;

			&:last-child {
				border-bottom: none;
			}
		}
	}

	.mark {
		display: inline-flex;
		padding-top: 0.125rem;
	}

	.text {
		flex: 1;
		min-width: 0;
	}

	.go {
		flex: none;
		font-size: 0.8125rem;
	}

	.tools {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
		margin: 0;
		padding: 0;
		list-style: none;

		li {
			display: flex;
			align-items: flex-start;
			gap: 0.75rem;
			color: var(--text-secondary);

			> span {
				display: flex;
				flex-direction: column;
				gap: 0.125rem;
				font-size: 0.875rem;
			}
		}

		.dim {
			font-size: 0.8125rem;
		}
	}
</style>
