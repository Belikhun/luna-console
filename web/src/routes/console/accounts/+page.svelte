<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, del, patch } from '$lib/api';
	import { fmtDateTime, fmtDuration } from '$lib/format';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Tabs from '$lib/components/Tabs.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import OverviewBar from '$lib/components/OverviewBar.svelte';
	import OverviewCell from '$lib/components/OverviewCell.svelte';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { Notify } from '$lib/notifications.svelte';
	import {
		accountState,
		auditTone,
		keyAudit,
		stateLabel,
		type AccountRow,
		type AuditRow,
		type SessionRow
	} from './accounts';

	/**
	 * Console accounts: who may sign in to this console, what is signed in right
	 * now, and what has been done to those accounts.
	 *
	 * Three tabs rather than three screens. Accounts, sessions and the audit trail
	 * are one subject read three ways, and an operator investigating a sign-in moves
	 * between them in a single breath; splitting them across nav entries would make
	 * that a navigation exercise.
	 *
	 * Nothing here decides what an account may *do*. Authorization is not in this
	 * phase, so every account can reach everything, and the screen says so rather
	 * than implying a permission model it does not have.
	 */

	let accounts: AccountRow[] = $state([]);
	let sessions: SessionRow[] = $state([]);
	let audit: AuditRow[] = $state([]);
	/** Id of the account this browser is signed in as; the one no verb may lock out */
	let self: string | null = $state(null);

	let loading = $state(false);
	let lastUpdated: number | null = $state(null);
	let tab = $state('accounts');
	let selected: Set<string> = $state(new Set());
	let sessionSelected: Set<string> = $state(new Set());

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const data = await api('/accounts');

			accounts = data.accounts;
			sessions = data.sessions;
			audit = keyAudit(data.audit);
			self = data.self;
			lastUpdated = Date.now();
		} catch (err) {
			Notify.error(t('web.accounts.loadFailed'), { detail: (err as Error).message });
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void refresh();
	});

	function detailHref(row: AccountRow): string {
		return `/console/accounts/${row.id}`;
	}

	/** The selection, as rows; the Actions dropdown acts on exactly this. */
	const picked = $derived(accounts.filter((row) => selected.has(row.id)));
	const pickedSessions = $derived(sessions.filter((row) => sessionSelected.has(row.id)));

	const counts = $derived({
		enabled: accounts.filter((row) => row.enabled).length,
		locked: accounts.filter((row) => row.lockedUntil).length,
		noPassword: accounts.filter((row) => !row.hasPassword).length
	});

	/**
	 * Run one verb over a selection and report it as a single outcome. A bulk verb
	 * that raises one notification per target buries the one that failed.
	 */
	async function runBulk(
		rows: AccountRow[],
		verb: string,
		run: (row: AccountRow) => Promise<unknown>
	): Promise<void> {
		if (rows.length === 0) {
			return;
		}

		const failed: string[] = [];

		for (const row of rows) {
			try {
				await run(row);
			} catch (err) {
				failed.push(`${row.username}: ${(err as Error).message}`);
			}
		}

		const done = rows.length - failed.length;

		if (failed.length === 0) {
			Notify.success(t('web.accounts.bulkDone', { verb, count: done }));
		} else if (done === 0) {
			Notify.error(t('web.accounts.bulkFailed', { verb }), { detail: failed.join('\n') });
		} else {
			Notify.warning(t('web.accounts.bulkPartial', { verb, done, failed: failed.length }), {
				detail: failed.join('\n')
			});
		}

		await refresh();
	}

	async function setEnabled(rows: AccountRow[], enabled: boolean): Promise<void> {
		await runBulk(rows, enabled ? t('web.accounts.verbEnable') : t('web.accounts.verbDisable'), (row) =>
			patch(`/accounts/${row.id}`, { enabled })
		);
	}

	async function unlock(rows: AccountRow[]): Promise<void> {
		await runBulk(rows, t('web.accounts.verbUnlock'), (row) => patch(`/accounts/${row.id}`, { unlock: true }));
	}

	async function revokeAll(rows: AccountRow[]): Promise<void> {
		await runBulk(rows, t('web.accounts.verbRevoke'), (row) => del(`/accounts/${row.id}/sessions`));
	}

	async function remove(rows: AccountRow[]): Promise<void> {
		const names = rows.map((row) => row.username).join(', ');

		if (!confirm(t('web.accounts.deleteConfirm', { names, count: rows.length }))) {
			return;
		}

		await runBulk(rows, t('web.accounts.verbDelete'), (row) => del(`/accounts/${row.id}`));
	}

	async function revokeSession(row: SessionRow): Promise<void> {
		try {
			await del(`/accounts/${row.account}/sessions?session=${encodeURIComponent(row.id)}`);
			Notify.success(t('web.accounts.sessionClosed', { name: row.username }));
			await refresh();
		} catch (err) {
			Notify.error(t('web.accounts.sessionCloseFailed'), { detail: (err as Error).message });
		}
	}

	/**
	 * Account verbs over a selection. Every unavailable verb stays listed and says
	 * why: a menu that hides what it cannot do leaves the operator guessing whether
	 * the verb exists at all.
	 */
	function accountActions(rows: AccountRow[]): ContextMenuItem[] {
		const one = rows.length === 1 ? rows[0] : undefined;
		const toEnable = rows.filter((row) => !row.enabled);
		const toDisable = rows.filter((row) => row.enabled && row.id !== self);
		const locked = rows.filter((row) => row.lockedUntil);
		const withSessions = rows.filter((row) => row.activeSessions > 0);
		const removable = rows.filter((row) => row.id !== self);
		const selfPicked = rows.some((row) => row.id === self);

		return [
			{
				label: t('web.accounts.openAccount'),
				icon: 'circleInfo',
				disabled: !one,
				hint: one ? undefined : t('web.accounts.pickOne'),
				action: () => goto(detailHref(one!))
			},
			{
				label: t('web.accounts.setPassword'),
				icon: 'key',
				disabled: !one,
				hint: one ? undefined : t('web.accounts.pickOne'),
				action: () => goto(`${detailHref(one!)}?password=1`)
			},
			{ separator: true },
			{
				label: t('web.accounts.enableAction', { count: toEnable.length }),
				icon: 'circleCheck',
				disabled: toEnable.length === 0,
				hint: toEnable.length ? undefined : t('web.accounts.allEnabled'),
				action: () => setEnabled(toEnable, true)
			},
			{
				label: t('web.accounts.disableAction', { count: toDisable.length }),
				icon: 'ban',
				color: 'warning',
				disabled: toDisable.length === 0,
				hint: toDisable.length
					? undefined
					: selfPicked
						? t('web.accounts.notYourself')
						: t('web.accounts.allDisabled'),
				action: () => setEnabled(toDisable, false)
			},
			{
				label: t('web.accounts.unlockAction', { count: locked.length }),
				icon: 'unlock',
				disabled: locked.length === 0,
				hint: locked.length ? undefined : t('web.accounts.noneLocked'),
				action: () => unlock(locked)
			},
			{
				label: t('web.accounts.revokeAction', { count: withSessions.length }),
				icon: 'rightFromBracket',
				color: 'warning',
				disabled: withSessions.length === 0,
				hint: withSessions.length ? undefined : t('web.accounts.noSessions'),
				action: () => revokeAll(withSessions)
			},
			{ separator: true },
			{
				label: t('web.accounts.deleteAction', { count: removable.length }),
				icon: 'trash',
				color: 'danger',
				disabled: removable.length === 0,
				hint: removable.length ? undefined : t('web.accounts.notYourself'),
				action: () => remove(removable)
			}
		];
	}

	/** A right-clicked row inside the selection acts on the whole selection. */
	function rowActions(row: AccountRow): ContextMenuItem[] {
		return accountActions(selected.has(row.id) && picked.length > 1 ? picked : [row]);
	}

	/**
	 * Session verbs over a selection. The current browser's own session is listed
	 * but never a target: signing yourself out from the sessions table would look
	 * like the page had crashed.
	 */
	function sessionActions(rows: SessionRow[]): ContextMenuItem[] {
		const one = rows.length === 1 ? rows[0] : undefined;
		const closable = rows.filter((row) => !row.current);

		return [
			{
				label: t('web.accounts.openAccount'),
				icon: 'userShield',
				disabled: !one,
				hint: one ? undefined : t('web.accounts.pickOneSession'),
				action: () => goto(`/console/accounts/${one!.account}`)
			},
			{ separator: true },
			{
				label: t('web.accounts.closeSessionAction', { count: closable.length }),
				icon: 'rightFromBracket',
				color: 'danger',
				disabled: closable.length === 0,
				hint: closable.length ? undefined : t('web.accounts.ownSession'),
				action: async () => {
					for (const row of closable) {
						await revokeSession(row);
					}
				}
			}
		];
	}

	function sessionRowActions(row: SessionRow): ContextMenuItem[] {
		return sessionActions(
			sessionSelected.has(row.id) && pickedSessions.length > 1 ? pickedSessions : [row]
		);
	}

	/**
	 * The header's Actions dropdown follows the tab: each tab has its own selection
	 * and its own verbs, and the activity trail has none, so the control is disabled
	 * with the tab rather than disappearing between them.
	 */
	const headerMenu = $derived(tab === 'sessions' ? sessionActions(pickedSessions) : accountActions(picked));

	const headerDisabled = $derived(
		tab === 'activity' || (tab === 'sessions' ? pickedSessions.length === 0 : picked.length === 0)
	);

	const accountColumns: Column[] = $derived([
		{ id: 'username', label: t('web.accounts.colUsername'), sortable: true, width: 200 },
		{ id: 'state', label: t('web.common.state'), sortable: true, width: 150 },
		{ id: 'displayName', label: t('web.accounts.colDisplayName'), sortable: true, width: 180 },
		{ id: 'identities', label: t('web.accounts.colIdentities'), sortable: true, width: 150 },
		{ id: 'sessions', label: t('web.accounts.colSessions'), sortable: true, width: 130 },
		{ id: 'lastSignIn', label: t('web.accounts.colLastSignIn'), sortable: true, width: 180 },
		{ id: 'created', label: t('web.accounts.colCreated'), sortable: true, width: 180, hidden: true }
	]);

	const accountFilters: TableFilterGroup<AccountRow>[] = $derived([
		{
			id: 'state',
			label: t('web.accounts.filterState'),
			options: [
				{ value: 'any', label: t('web.accounts.anyState') },
				{ value: 'enabled', label: t('web.accounts.enabled'), match: (row) => row.enabled },
				{ value: 'disabled', label: t('web.accounts.disabled'), match: (row) => !row.enabled },
				{ value: 'locked', label: t('web.accounts.locked'), match: (row) => !!row.lockedUntil },
				{
					value: 'nopassword',
					label: t('web.accounts.noPassword'),
					match: (row) => !row.hasPassword
				}
			]
		},
		{
			id: 'signedin',
			label: t('web.accounts.filterSignedIn'),
			options: [
				{ value: 'any', label: t('web.accounts.anySession') },
				{ value: 'yes', label: t('web.accounts.hasSession'), match: (row) => row.activeSessions > 0 },
				{ value: 'no', label: t('web.accounts.noSession'), match: (row) => row.activeSessions === 0 }
			]
		}
	]);

	const sessionColumns: Column[] = $derived([
		{ id: 'username', label: t('web.accounts.colAccount'), sortable: true, width: 180 },
		{ id: 'ip', label: t('web.accounts.colAddress'), sortable: true, width: 160 },
		{ id: 'opened', label: t('web.accounts.colOpened'), sortable: true, width: 180 },
		{ id: 'lastSeen', label: t('web.accounts.colLastSeen'), sortable: true, width: 180 },
		{ id: 'expires', label: t('web.accounts.colExpires'), sortable: true, width: 150 },
		{ id: 'agent', label: t('web.accounts.colClient') }
	]);

	const auditColumns: Column[] = $derived([
		{ id: 'when', label: t('web.accounts.colWhen'), sortable: true, width: 180 },
		{ id: 'action', label: t('web.accounts.colAction'), sortable: true, width: 180 },
		{ id: 'account', label: t('web.accounts.colAccount'), sortable: true, width: 160 },
		{ id: 'actor', label: t('web.accounts.colActor'), sortable: true, width: 160 },
		{ id: 'ip', label: t('web.accounts.colAddress'), sortable: true, width: 150 },
		{ id: 'detail', label: t('web.accounts.colDetail') }
	]);

	const auditFilters: TableFilterGroup<AuditRow>[] = $derived([
		{
			id: 'kind',
			label: t('web.accounts.filterActivity'),
			options: [
				{ value: 'any', label: t('web.accounts.anyActivity') },
				{
					value: 'signin',
					label: t('web.accounts.signInActivity'),
					match: (row) => row.action.startsWith('signin') || row.action === 'signout'
				},
				{
					value: 'refused',
					label: t('web.accounts.refusedActivity'),
					match: (row) => row.action === 'signin.failed' || row.action === 'signin.locked'
				},
				{
					value: 'changes',
					label: t('web.accounts.changeActivity'),
					match: (row) => row.action.startsWith('account.') || row.action.startsWith('password')
				},
				{
					value: 'identities',
					label: t('web.accounts.identityActivity'),
					match: (row) => row.action.startsWith('identity.')
				}
			]
		}
	]);
</script>

<svelte:head><title>{t('web.nav.accounts')} | Luna Console</title></svelte:head>

<PageHeader title={t('web.nav.accounts')} count={accounts.length} description={t('web.accounts.pageDescription')} info>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="console-accounts" />
		<Dropdown label={t('web.common.actions')} disabled={headerDisabled} menu={headerMenu} />
		<Btn variant="primary" icon="userPlus" href="/console/accounts/new">
			{t('web.accounts.createAccount')}
		</Btn>
	{/snippet}
</PageHeader>

{#if accounts.length === 1 && accounts[0]?.id === self}
	<Flash kind="info">{t('web.accounts.onlyAccountNotice')}</Flash>
{/if}

<OverviewBar title={t('web.accounts.overview')}>
	<OverviewCell label={t('web.accounts.overviewAccounts')}>
		{accounts.length}
		<span class="dim">({counts.enabled} {t('web.accounts.enabled')})</span>
	</OverviewCell>
	<OverviewCell label={t('web.accounts.overviewSessions')}>{sessions.length}</OverviewCell>
	<OverviewCell label={t('web.accounts.overviewLocked')}>{counts.locked}</OverviewCell>
	<OverviewCell label={t('web.accounts.overviewNoPassword')}>{counts.noPassword}</OverviewCell>
</OverviewBar>

<Tabs
	tabs={[
		{ id: 'accounts', label: t('web.accounts.tabAccounts') },
		{ id: 'sessions', label: t('web.accounts.tabSessions') },
		{ id: 'activity', label: t('web.accounts.tabActivity') }
	]}
	bind:active={tab}
/>

<div class="tabbody">
	{#if tab === 'accounts'}
		<Panel flush>
			<ResourceTable
				tableId="console-accounts"
				initialSearch={page.url.searchParams.get('q') ?? ''}
				columns={accountColumns}
				filters={accountFilters}
				rows={accounts}
				getId={(row) => row.id}
				searchValue={(row) =>
					`${row.username} ${row.displayName} ${row.email} ${row.description}`}
				searchPlaceholder={t('web.accounts.searchPlaceholder')}
				selectable="multi"
				bind:selected
				{rowActions}
				rowLabel={(row) => row.username}
				rowDim={(row) => !row.enabled}
				noun={t('web.accounts.noun')}
				onRowClick={(row) => goto(detailHref(row))}
				sortValue={(row, col) =>
					col === 'state'
						? accountState(row)
						: col === 'lastSignIn'
							? (row.lastSignInAt ?? 0)
							: null}
				emptyTitle={t('web.accounts.emptyTitle')}
				emptyText={t('web.accounts.emptyText')}
			>
				{#snippet cell(row, col)}
					{#if col === 'username'}
						<a href={detailHref(row)}><b>{row.username}</b></a>
						{#if row.id === self}
							<span class="you">{t('web.accounts.you')}</span>
						{/if}
					{:else if col === 'state'}
						<StatusBadge
							state={accountState(row)}
							label={stateLabel(row)}
							detail={row.lockedUntil
								? t('web.accounts.lockedFor', {
										time: fmtDuration(row.lockedUntil - Date.now())
									})
								: undefined}
						/>
					{:else if col === 'displayName'}
						<span class:dim={!row.displayName}>{row.displayName || '–'}</span>
					{:else if col === 'identities'}
						{@const keys = row.identities.filter((identity) => identity.kind === 'accessKey').length}
						<span class="mono">{row.identities.length}</span>
						{#if keys}
							<span class="dim">· {t('web.accounts.keysShort', { count: keys })}</span>
						{/if}
					{:else if col === 'sessions'}
						{#if row.activeSessions}
							<span class="mono">{row.activeSessions}</span>
						{:else}
							<span class="dim">–</span>
						{/if}
					{:else if col === 'lastSignIn'}
						<span class:dim={!row.lastSignInAt}>
							{row.lastSignInAt ? fmtDateTime(row.lastSignInAt) : t('web.accounts.never')}
						</span>
					{:else if col === 'created'}
						<span class="dim">{fmtDateTime(row.createdAt)}</span>
					{/if}
				{/snippet}
			</ResourceTable>
		</Panel>
	{:else if tab === 'sessions'}
		<Panel flush>
			<ResourceTable
				tableId="console-sessions"
				columns={sessionColumns}
				rows={sessions}
				getId={(row) => row.id}
				searchValue={(row) => `${row.username} ${row.ip ?? ''} ${row.agent ?? ''}`}
				searchPlaceholder={t('web.accounts.searchSessions')}
				selectable="multi"
				bind:selected={sessionSelected}
				rowActions={sessionRowActions}
				rowLabel={(row) => `${row.username} · ${row.ip ?? t('web.accounts.noAddress')}`}
				noun={t('web.accounts.sessionNoun')}
				emptyTitle={t('web.accounts.noSessionsTitle')}
				emptyText={t('web.accounts.noSessionsText')}
			>
				{#snippet cell(row, col)}
					{#if col === 'username'}
						<a href="/console/accounts/{row.account}">{row.username}</a>
						{#if row.current}
							<span class="you">{t('web.accounts.thisBrowser')}</span>
						{/if}
					{:else if col === 'ip'}
						<span class="mono">{row.ip ?? '–'}</span>
					{:else if col === 'opened'}
						{fmtDateTime(row.createdAt)}
					{:else if col === 'lastSeen'}
						{fmtDateTime(row.lastSeenAt)}
					{:else if col === 'expires'}
						<span class:dim={row.expiresAt - Date.now() > 60 * 60 * 1000}>
							{fmtDuration(row.expiresAt - Date.now())}
						</span>
					{:else if col === 'agent'}
						<span class="dim agent">{row.agent ?? '–'}</span>
					{/if}
				{/snippet}
			</ResourceTable>
		</Panel>
	{:else}
		<Panel flush>
			<ResourceTable
				tableId="console-audit"
				columns={auditColumns}
				filters={auditFilters}
				rows={audit}
				getId={(row) => row.key}
				searchValue={(row) =>
					`${row.action} ${row.account ?? ''} ${row.actor ?? ''} ${row.ip ?? ''} ${row.detail ?? ''}`}
				searchPlaceholder={t('web.accounts.searchActivity')}
				noun={t('web.accounts.activityNoun')}
				sortValue={(row, col) => (col === 'when' ? row.t : null)}
				emptyTitle={t('web.accounts.noActivityTitle')}
				emptyText={t('web.accounts.noActivityText')}
			>
				{#snippet cell(row, col)}
					{#if col === 'when'}
						<span class="dim">{fmtDateTime(row.t)}</span>
					{:else if col === 'action'}
						<StatusBadge state={auditTone(row.action)} label={row.action} />
					{:else if col === 'account'}
						<span class:dim={!row.account}>{row.account ?? '–'}</span>
					{:else if col === 'actor'}
						<span class:dim={!row.actor}>{row.actor ?? t('web.accounts.noActor')}</span>
					{:else if col === 'ip'}
						<span class="mono dim">{row.ip ?? '–'}</span>
					{:else if col === 'detail'}
						<span class="dim">{row.detail ?? '–'}</span>
					{/if}
				{/snippet}
			</ResourceTable>
		</Panel>
	{/if}
</div>

<style lang="scss">
	.tabbody {
		margin-top: 1rem;
	}

	// "this is you": a quiet tag beside the name, not a column of its own
	.you {
		margin-left: 0.5rem;
		font-size: 0.6875rem;
		color: var(--text-secondary);
		border: var(--hairline) solid var(--border);
		border-radius: 0.75rem;
		padding: 0.0625rem 0.375rem;
	}

	// a user agent string is long and never the reason a row is being read
	.agent {
		@include ellipsis;

		display: block;
		font-size: 0.75rem;
	}
</style>
