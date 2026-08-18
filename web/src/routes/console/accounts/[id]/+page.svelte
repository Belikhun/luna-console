<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, del, patch, post } from '$lib/api';
	import { copyText } from '$lib/clipboard';
	import { fmtDateTime, fmtDuration } from '$lib/format';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Tabs from '$lib/components/Tabs.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import FormGrid from '$lib/components/FormGrid.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import type { InfoCell } from '$lib/components/grid';
	import type { Column } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { Notify } from '$lib/notifications.svelte';
	import { MIN_PASSWORD_LENGTH } from '$shared/accountrules';
	import {
		accountState,
		auditTone,
		identityIcon,
		identityLabel,
		keyAudit,
		stateLabel,
		type AccountRow,
		type AuditRow,
		type IdentityRow,
		type SessionRow
	} from '../accounts';

	/**
	 * One console account: its fields, the credentials attached to it, the sessions
	 * open under it, and everything that has been done to it.
	 *
	 * The identities tab is the substance. An account is not one credential: a
	 * console password is what a person signs in with, an access key is what a
	 * script sends, and a linked Minecraft profile records which player this
	 * operator is. They are retired independently, and a leaked access key has to be
	 * killable without locking its owner out of the console.
	 */

	interface Detail {
		account: AccountRow;
		sessions: SessionRow[];
		audit: AuditRow[];
		/** whether this is the account the browser is signed in as */
		self: boolean;
	}

	const id = $derived(page.params.id!);

	let detail = $state<Detail | null>(null);
	let loading = $state(false);
	let missing = $state(false);
	let lastUpdated = $state<number | null>(null);
	let tab = $state('details');

	let passwordOpen = $state(false);
	let keyOpen = $state(false);
	let linkOpen = $state(false);
	let deleteOpen = $state(false);
	let busy = $state(false);

	let identityRemoveOpen = $state(false);
	/** the identity the remove dialog is about; set by the row verb, read on confirm */
	let identityToRemove = $state<IdentityRow | null>(null);

	// password form
	let currentPassword = $state('');
	let newPassword = $state('');
	let confirmPassword = $state('');

	// access key form; `mintedSecret` is the one moment the secret exists in a page
	let keyLabel = $state('');
	let mintedSecret = $state('');
	let copied = $state(false);

	// minecraft link form
	let linkUuid = $state('');
	let linkPlayer = $state('');

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const data = await api(`/accounts/${encodeURIComponent(id)}`);

			detail = { ...data, audit: keyAudit(data.audit) };
			missing = false;
			lastUpdated = Date.now();
		} catch (err) {
			missing = true;
			Notify.error(t('web.common.loadFailedNamed', { name: id }), {
				detail: (err as Error).message
			});
		} finally {
			loading = false;
		}
	}

	onMount(async () => {
		await refresh();

		// the Accounts screen links here with ?password=1 for its "Set password" verb,
		// so the row action lands on the form rather than on the screen holding it
		if (page.url.searchParams.get('password')) {
			openPassword();
		}
	});

	function openPassword(): void {
		currentPassword = '';
		newPassword = '';
		confirmPassword = '';
		passwordOpen = true;
	}

	function openKey(): void {
		keyLabel = '';
		mintedSecret = '';
		copied = false;
		keyOpen = true;
	}

	function openLink(): void {
		linkUuid = '';
		linkPlayer = '';
		linkOpen = true;
	}

	const passwordError = $derived.by(() => {
		if (!newPassword) {
			return '';
		}

		if (newPassword.length < MIN_PASSWORD_LENGTH) {
			return t('web.accountNew.passwordRule', { min: MIN_PASSWORD_LENGTH });
		}

		if (confirmPassword && newPassword !== confirmPassword) {
			return t('web.accountNew.mismatch');
		}

		return '';
	});

	const passwordReady = $derived(
		!!newPassword &&
			newPassword === confirmPassword &&
			!passwordError &&
			(!detail?.self || !!currentPassword)
	);

	async function savePassword(): Promise<void> {
		busy = true;

		try {
			const result = await post(`/accounts/${detail!.account.id}/password`, {
				current: detail!.self ? currentPassword : undefined,
				password: newPassword
			});

			Notify.success(t('web.accountDetail.passwordSet', { name: detail!.account.username }), {
				detail: t('web.accountDetail.sessionsClosed', { count: result.sessionsClosed })
			});
			passwordOpen = false;
			await refresh();
		} catch (err) {
			Notify.error(t('web.accountDetail.passwordFailed'), { detail: (err as Error).message });
		} finally {
			busy = false;
		}
	}

	async function createKey(): Promise<void> {
		busy = true;

		try {
			const result = await post(`/accounts/${detail!.account.id}/identities`, {
				kind: 'accessKey',
				label: keyLabel
			});

			mintedSecret = result.secret;
			await refresh();
		} catch (err) {
			Notify.error(t('web.accountDetail.keyFailed'), { detail: (err as Error).message });
		} finally {
			busy = false;
		}
	}

	async function linkMinecraft(): Promise<void> {
		busy = true;

		try {
			await post(`/accounts/${detail!.account.id}/identities`, {
				kind: 'minecraft',
				uuid: linkUuid,
				playerName: linkPlayer
			});

			Notify.success(t('web.accountDetail.linked', { player: linkPlayer || linkUuid }));
			linkOpen = false;
			await refresh();
		} catch (err) {
			Notify.error(t('web.accountDetail.linkFailed'), { detail: (err as Error).message });
		} finally {
			busy = false;
		}
	}

	async function setEnabled(enabled: boolean): Promise<void> {
		try {
			await patch(`/accounts/${detail!.account.id}`, { enabled });
			Notify.success(
				enabled
					? t('web.accountDetail.enabled', { name: detail!.account.username })
					: t('web.accountDetail.disabled', { name: detail!.account.username })
			);
			await refresh();
		} catch (err) {
			Notify.error(t('web.accountDetail.saveFailed'), { detail: (err as Error).message });
		}
	}

	async function unlock(): Promise<void> {
		try {
			await patch(`/accounts/${detail!.account.id}`, { unlock: true });
			Notify.success(t('web.accountDetail.unlocked', { name: detail!.account.username }));
			await refresh();
		} catch (err) {
			Notify.error(t('web.accountDetail.saveFailed'), { detail: (err as Error).message });
		}
	}

	async function revokeSession(row: SessionRow): Promise<void> {
		try {
			await del(`/accounts/${detail!.account.id}/sessions?session=${encodeURIComponent(row.id)}`);
			Notify.success(t('web.accounts.sessionClosed', { name: row.username }));
			await refresh();
		} catch (err) {
			Notify.error(t('web.accounts.sessionCloseFailed'), { detail: (err as Error).message });
		}
	}

	async function revokeAll(): Promise<void> {
		try {
			const result = await del(`/accounts/${detail!.account.id}/sessions`);

			Notify.success(t('web.accountDetail.sessionsRevoked', { count: result.closed }));
			await refresh();
		} catch (err) {
			Notify.error(t('web.accounts.sessionCloseFailed'), { detail: (err as Error).message });
		}
	}

	async function toggleIdentity(row: IdentityRow): Promise<void> {
		try {
			await patch(`/accounts/${detail!.account.id}/identities`, {
				identity: row.id,
				disabled: !row.disabled
			});
			await refresh();
		} catch (err) {
			Notify.error(t('web.accountDetail.identityFailed'), { detail: (err as Error).message });
		}
	}

	function removeIdentity(row: IdentityRow): void {
		identityToRemove = row;
		identityRemoveOpen = true;
	}

	async function removeIdentityConfirmed(): Promise<void> {
		const row = identityToRemove;

		if (!row) {
			return;
		}

		try {
			await del(`/accounts/${detail!.account.id}/identities?identity=${encodeURIComponent(row.id)}`);
			Notify.success(t('web.accountDetail.identityRemoved', { label: row.label }));
			await refresh();
		} catch (err) {
			Notify.error(t('web.accountDetail.identityFailed'), { detail: (err as Error).message });
		}
	}

	async function removeAccountConfirmed(): Promise<void> {
		try {
			await del(`/accounts/${detail!.account.id}`);
			Notify.success(t('web.accountDetail.deleted', { name: detail!.account.username }));
			await goto('/console/accounts');
		} catch (err) {
			Notify.error(t('web.accountDetail.deleteFailed'), { detail: (err as Error).message });
		}
	}

	/** The account's own verbs; the header's Actions dropdown. */
	const accountVerbs: ContextMenuItem[] = $derived(
		!detail
			? []
			: [
					{
						label: t('web.accountDetail.editDetails'),
						icon: 'pen',
						action: () => goto(`/console/accounts/${detail!.account.id}/edit`)
					},
					{ label: t('web.accountDetail.setPassword'), icon: 'key', action: openPassword },
					{ label: t('web.accountDetail.linkPlayer'), icon: 'cube', action: openLink },
					{ separator: true },
					{
						label: detail.account.enabled
							? t('web.accountDetail.disableAccount')
							: t('web.accountDetail.enableAccount'),
						icon: detail.account.enabled ? 'ban' : 'circleCheck',
						color: detail.account.enabled ? 'warning' : 'default',
						disabled: detail.self && detail.account.enabled,
						hint: detail.self && detail.account.enabled ? t('web.accounts.notYourself') : undefined,
						action: () => setEnabled(!detail!.account.enabled)
					},
					{
						label: t('web.accountDetail.unlockAccount'),
						icon: 'unlock',
						disabled: !detail.account.lockedUntil,
						hint: detail.account.lockedUntil ? undefined : t('web.accounts.noneLocked'),
						action: unlock
					},
					{
						label: detail.self
							? t('web.accountDetail.revokeOthers')
							: t('web.accountDetail.revokeSessions'),
						icon: 'rightFromBracket',
						color: 'warning',
						disabled: detail.sessions.length === 0,
						hint: detail.sessions.length ? undefined : t('web.accounts.noSessions'),
						action: revokeAll
					},
					{ separator: true },
					{
						label: t('web.accountDetail.deleteAccount'),
						icon: 'trash',
						color: 'danger',
						disabled: detail.self,
						hint: detail.self ? t('web.accounts.notYourself') : undefined,
						action: () => {
							deleteOpen = true;
						}
					}
				]
	);

	const summaryCells: InfoCell[] = $derived(
		!detail
			? []
			: [
					{ label: t('web.accountDetail.username'), value: detail.account.username, copyable: true },
					{ id: 'state', label: t('web.common.state') },
					{ label: t('web.accountDetail.displayName'), value: detail.account.displayName || '–' },
					{ label: t('web.accountDetail.email'), value: detail.account.email || '–' },
					{
						label: t('web.accountDetail.purpose'),
						value: detail.account.description || '–',
						colSpan: 2
					},
					{ id: 'accountId', label: t('web.accountDetail.accountId') },
					{
						label: t('web.accountDetail.created'),
						value: `${fmtDateTime(detail.account.createdAt)}${detail.account.createdBy ? ` · ${detail.account.createdBy}` : ''}`
					},
					{
						label: t('web.accountDetail.lastSignIn'),
						value: detail.account.lastSignInAt
							? fmtDateTime(detail.account.lastSignInAt)
							: t('web.accounts.never')
					},
					{
						label: t('web.accountDetail.failedAttempts'),
						value: String(detail.account.failedAttempts)
					},
					{ id: 'sessions', label: t('web.accountDetail.openSessions') }
				]
	);

	const identityColumns: Column[] = $derived([
		{ id: 'kind', label: t('web.accountDetail.colKind'), sortable: true, width: 170 },
		{ id: 'label', label: t('web.accountDetail.colLabel'), sortable: true, width: 220 },
		{ id: 'state', label: t('web.common.state'), sortable: true, width: 130 },
		{ id: 'created', label: t('web.accountDetail.colCreated'), sortable: true, width: 180 },
		{ id: 'lastUsed', label: t('web.accountDetail.colLastUsed'), sortable: true, width: 180 },
		{ id: 'id', label: t('web.accountDetail.colId') }
	]);

	const sessionColumns: Column[] = $derived([
		{ id: 'ip', label: t('web.accounts.colAddress'), sortable: true, width: 160 },
		{ id: 'opened', label: t('web.accounts.colOpened'), sortable: true, width: 180 },
		{ id: 'lastSeen', label: t('web.accounts.colLastSeen'), sortable: true, width: 180 },
		{ id: 'expires', label: t('web.accounts.colExpires'), sortable: true, width: 140 },
		{ id: 'agent', label: t('web.accounts.colClient') }
	]);

	const auditColumns: Column[] = $derived([
		{ id: 'when', label: t('web.accounts.colWhen'), sortable: true, width: 180 },
		{ id: 'action', label: t('web.accounts.colAction'), sortable: true, width: 180 },
		{ id: 'actor', label: t('web.accounts.colActor'), sortable: true, width: 160 },
		{ id: 'ip', label: t('web.accounts.colAddress'), sortable: true, width: 150 },
		{ id: 'detail', label: t('web.accounts.colDetail') }
	]);

	function identityActions(row: IdentityRow): ContextMenuItem[] {
		return [
			{
				label: row.disabled
					? t('web.accountDetail.enableIdentity')
					: t('web.accountDetail.disableIdentity'),
				icon: row.disabled ? 'circleCheck' : 'ban',
				// a disabled password identity is an account nobody can sign in as, which
				// is what "disable the account" is for; the state stays visible either way
				disabled: row.kind === 'password' && !row.disabled && detail?.self,
				hint: row.kind === 'password' && !row.disabled && detail?.self
					? t('web.accountDetail.notYourPassword')
					: undefined,
				action: () => toggleIdentity(row)
			},
			{
				label: t('web.accountDetail.copyIdentityId'),
				icon: 'copy',
				action: async () => {
					await copyText(row.id);
				}
			},
			{ separator: true },
			{
				label: t('web.accountDetail.removeIdentity'),
				icon: 'trash',
				color: 'danger',
				disabled: row.kind === 'password',
				hint: row.kind === 'password' ? t('web.accountDetail.replacePasswordInstead') : undefined,
				action: () => removeIdentity(row)
			}
		];
	}

	function sessionActions(row: SessionRow): ContextMenuItem[] {
		return [
			{
				label: t('web.accounts.closeSessionAction', { count: 1 }),
				icon: 'rightFromBracket',
				color: 'danger',
				disabled: row.current,
				hint: row.current ? t('web.accounts.ownSession') : undefined,
				action: () => revokeSession(row)
			}
		];
	}

	async function copySecret(): Promise<void> {
		copied = await copyText(mintedSecret);
	}
</script>

<svelte:head><title>{detail?.account.username ?? id} | Luna Console</title></svelte:head>

{#if missing}
	<PageHeader title={id} description={t('web.accountDetail.consoleAccount')} />
	<Flash kind="error">
		{t('web.accountDetail.notFound', { name: id })}
		<a href="/console/accounts">{t('web.accountDetail.backToAccounts')}</a>
	</Flash>
{:else if detail}
	<PageHeader
		title={detail.account.username}
		description={detail.account.description || t('web.accountDetail.consoleAccount')}
		info
	>
		{#snippet extra()}
			<StatusBadge state={accountState(detail!.account)} label={stateLabel(detail!.account)} />
			{#if detail!.self}
				<StatusBadge state="info" label={t('web.accountDetail.thisIsYou')} detail={t('web.accountDetail.thisIsYouDetail')} />
			{/if}
		{/snippet}
		{#snippet actions()}
			<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="account-detail" />
			<Dropdown label={t('web.common.actions')} menu={accountVerbs} />
			<Btn icon="pen" href="/console/accounts/{detail!.account.id}/edit">
				{t('web.accountDetail.editDetails')}
			</Btn>
			<Btn variant="primary" icon="terminal" onclick={openKey}>
				{t('web.accountDetail.createKey')}
			</Btn>
		{/snippet}
	</PageHeader>

	{#if detail.account.mustChangePassword}
		<Flash kind="warning">{t('web.accountDetail.mustChangeNotice')}</Flash>
	{/if}

	{#if !detail.account.hasPassword}
		<Flash kind="warning">{t('web.accountDetail.noPasswordNotice')}</Flash>
	{/if}

	{#if detail.account.lockedUntil}
		<Flash kind="error">
			{t('web.accountDetail.lockedNotice', {
				time: fmtDuration(detail.account.lockedUntil - Date.now()),
				attempts: detail.account.failedAttempts
			})}
		</Flash>
	{/if}

	<Tabs
		tabs={[
			{ id: 'details', label: t('web.accountDetail.tabDetails') },
			{ id: 'identities', label: t('web.accountDetail.tabIdentities') },
			{ id: 'sessions', label: t('web.accountDetail.tabSessions') },
			{ id: 'activity', label: t('web.accountDetail.tabActivity') }
		]}
		bind:active={tab}
	/>

	<div class="tabbody">
		{#if tab === 'details'}
			<Panel title={t('web.accountDetail.summary')}>
				<InfoGrid cells={summaryCells}>
					{#snippet custom(cell)}
						{#if cell.id === 'state'}
							<StatusBadge
								state={accountState(detail!.account)}
								label={stateLabel(detail!.account)}
							/>
						{:else if cell.id === 'accountId'}
							<span class="mono dim">{detail!.account.id}</span>
						{:else if cell.id === 'sessions'}
							{detail!.sessions.length}
						{/if}
					{/snippet}
				</InfoGrid>
			</Panel>

			<div class="gap"></div>

			<Flash kind="info">{t('web.accountDetail.noPermissionsNotice')}</Flash>
		{:else if tab === 'identities'}
			<Panel
				title={t('web.accountDetail.identitiesPanel')}
				count={detail.account.identities.length}
				description={t('web.accountDetail.identitiesHint')}
				flush
			>
				{#if detail.account.identities.length}
					<DataTable
						columns={identityColumns}
						rows={detail.account.identities}
						getId={(row) => row.id}
						rowActions={identityActions}
						rowLabel={(row) => row.label}
						rowDim={(row) => row.disabled}
					>
						{#snippet cell(row, col)}
							{#if col === 'kind'}
								<span class="kind">
									<Icon name={identityIcon(row.kind)} size="0.875rem" style="solid" />
									{identityLabel(row.kind)}
								</span>
							{:else if col === 'label'}
								<b>{row.label}</b>
								{#if row.uuid}
									<span class="mono dim uuid">{row.uuid}</span>
								{/if}
							{:else if col === 'state'}
								<StatusBadge
									state={row.disabled ? 'stopped' : 'ok'}
									label={row.disabled ? t('web.accounts.disabled') : t('web.accounts.active')}
								/>
							{:else if col === 'created'}
								{fmtDateTime(row.createdAt)}
							{:else if col === 'lastUsed'}
								<span class:dim={!row.lastUsedAt}>
									{row.lastUsedAt ? fmtDateTime(row.lastUsedAt) : t('web.accountDetail.neverUsed')}
								</span>
							{:else if col === 'id'}
								<span class="mono dim">{row.id}</span>
							{/if}
						{/snippet}
					</DataTable>
				{:else}
					<p class="none dim">{t('web.accountDetail.noIdentities')}</p>
				{/if}
			</Panel>
		{:else if tab === 'sessions'}
			<Panel
				title={t('web.accountDetail.sessionsPanel')}
				count={detail.sessions.length}
				description={t('web.accountDetail.sessionsHint')}
				flush
			>
				{#if detail.sessions.length}
					<DataTable
						columns={sessionColumns}
						rows={detail.sessions}
						getId={(row) => row.id}
						rowActions={sessionActions}
						rowLabel={(row) => row.ip ?? t('web.accounts.noAddress')}
					>
						{#snippet cell(row, col)}
							{#if col === 'ip'}
								<span class="mono">{row.ip ?? '–'}</span>
								{#if row.current}
									<span class="you">{t('web.accounts.thisBrowser')}</span>
								{/if}
							{:else if col === 'opened'}
								{fmtDateTime(row.createdAt)}
							{:else if col === 'lastSeen'}
								{fmtDateTime(row.lastSeenAt)}
							{:else if col === 'expires'}
								{fmtDuration(row.expiresAt - Date.now())}
							{:else if col === 'agent'}
								<span class="dim agent">{row.agent ?? '–'}</span>
							{/if}
						{/snippet}
					</DataTable>
				{:else}
					<p class="none dim">{t('web.accountDetail.noSessions')}</p>
				{/if}
			</Panel>
		{:else}
			<Panel
				title={t('web.accountDetail.activityPanel')}
				count={detail.audit.length}
				description={t('web.accountDetail.activityHint')}
				flush
			>
				{#if detail.audit.length}
					<DataTable
						columns={auditColumns}
						rows={detail.audit}
						getId={(row) => row.key}
					>
						{#snippet cell(row, col)}
							{#if col === 'when'}
								<span class="dim">{fmtDateTime(row.t)}</span>
							{:else if col === 'action'}
								<StatusBadge state={auditTone(row.action)} label={row.action} />
							{:else if col === 'actor'}
								<span class:dim={!row.actor}>{row.actor ?? t('web.accounts.noActor')}</span>
							{:else if col === 'ip'}
								<span class="mono dim">{row.ip ?? '–'}</span>
							{:else if col === 'detail'}
								<span class="dim">{row.detail ?? '–'}</span>
							{/if}
						{/snippet}
					</DataTable>
				{:else}
					<p class="none dim">{t('web.accountDetail.noActivity')}</p>
				{/if}
			</Panel>
		{/if}
	</div>

	<Modal title={t('web.accountDetail.passwordTitle')} bind:open={passwordOpen}>
		{#if detail.self}
			<Flash kind="info">{t('web.accountDetail.ownPasswordNotice')}</Flash>
			<label class="field">
				<span class="lbl">{t('web.accountDetail.currentPassword')}</span>
				<input
					class="input"
					type="password"
					autocomplete="current-password"
					bind:value={currentPassword}
				/>
			</label>
		{:else}
			<Flash kind="warning">
				{t('web.accountDetail.resetNotice', { name: detail.account.username })}
			</Flash>
		{/if}

		<label class="field">
			<span class="lbl">{t('web.login.newPassword')}</span>
			<span class="hint">{t('web.accountNew.passwordRule', { min: MIN_PASSWORD_LENGTH })}</span>
			<input class="input" type="password" autocomplete="new-password" bind:value={newPassword} />
		</label>
		<label class="field">
			<span class="lbl">{t('web.login.confirmPassword')}</span>
			<input class="input" type="password" autocomplete="new-password" bind:value={confirmPassword} />
			{#if passwordError}<span class="err">{passwordError}</span>{/if}
		</label>

		{#snippet footer()}
			<Btn onclick={() => (passwordOpen = false)}>{t('web.common.cancel')}</Btn>
			<Btn variant="primary" disabled={!passwordReady} loading={busy} onclick={savePassword}>
				{t('web.accountDetail.setPassword')}
			</Btn>
		{/snippet}
	</Modal>

	<Modal title={t('web.accountDetail.keyTitle')} bind:open={keyOpen}>
		{#if mintedSecret}
			<Flash kind="warning">{t('web.accountDetail.keyOnceOnly')}</Flash>
			<div class="secret">
				<code class="mono">{mintedSecret}</code>
				<Btn icon={copied ? 'circleCheck' : 'copy'} onclick={copySecret}>
					{copied ? t('web.common.copied') : t('web.common.copy')}
				</Btn>
			</div>
		{:else}
			<p class="modalnote dim">{t('web.accountDetail.keyHint')}</p>
			<label class="field">
				<span class="lbl">{t('web.accountDetail.keyLabel')}</span>
				<span class="hint">{t('web.accountDetail.keyLabelHint')}</span>
				<input class="input" type="text" bind:value={keyLabel} />
			</label>
		{/if}

		{#snippet footer()}
			{#if mintedSecret}
				<Btn variant="primary" onclick={() => (keyOpen = false)}>{t('web.common.done')}</Btn>
			{:else}
				<Btn onclick={() => (keyOpen = false)}>{t('web.common.cancel')}</Btn>
				<Btn variant="primary" loading={busy} onclick={createKey}>
					{t('web.accountDetail.createKey')}
				</Btn>
			{/if}
		{/snippet}
	</Modal>

	<Modal title={t('web.accountDetail.linkTitle')} bind:open={linkOpen}>
		<p class="modalnote dim">{t('web.accountDetail.linkHint')}</p>
		<FormGrid>
			<label class="field">
				<span class="lbl">{t('web.accountDetail.playerUuid')}</span>
				<input class="input mono" type="text" spellcheck="false" bind:value={linkUuid} />
			</label>
			<label class="field">
				<span class="lbl">{t('web.accountDetail.playerName')}</span>
				<input class="input" type="text" spellcheck="false" bind:value={linkPlayer} />
			</label>
		</FormGrid>

		{#snippet footer()}
			<Btn onclick={() => (linkOpen = false)}>{t('web.common.cancel')}</Btn>
			<Btn variant="primary" disabled={!linkUuid} loading={busy} onclick={linkMinecraft}>
				{t('web.accountDetail.link')}
			</Btn>
		{/snippet}
	</Modal>

	<ConfirmModal
		bind:open={identityRemoveOpen}
		title={t('web.accountDetail.removeIdentityTitle', { label: identityToRemove?.label ?? '' })}
		lead={t('web.accountDetail.removeIdentityLead', { label: identityToRemove?.label ?? '' })}
		notes={[t('web.accountDetail.removeIdentityNote')]}
		confirmLabel={t('web.accountDetail.removeIdentity')}
		onconfirm={() => void removeIdentityConfirmed()}
	/>

	<ConfirmModal
		bind:open={deleteOpen}
		title={t('web.accountDetail.deleteTitle', { name: detail.account.username })}
		lead={t('web.accountDetail.deleteLead', { name: detail.account.username })}
		notes={[t('web.accountDetail.deleteNote')]}
		confirmLabel={t('web.common.delete')}
		onconfirm={() => void removeAccountConfirmed()}
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
		font-size: 0.8125rem;
	}

	.modalnote {
		margin: 0 0 1rem;
		font-size: 0.8125rem;
	}

	.kind {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}

	.uuid {
		margin-left: 0.5rem;
		font-size: 0.75rem;
	}

	.you {
		margin-left: 0.5rem;
		font-size: 0.6875rem;
		color: var(--text-secondary);
		border: var(--hairline) solid var(--border);
		border-radius: 0.75rem;
		padding: 0.0625rem 0.375rem;
	}

	.agent {
		@include ellipsis;

		display: block;
		font-size: 0.75rem;
	}

	// the one place a credential is ever on screen: wide, monospaced and next to
	// the only control that matters, because the operator has one chance to take it
	.secret {
		display: flex;
		align-items: center;
		gap: 0.75rem;

		code {
			flex: 1;
			min-width: 0;
			overflow-wrap: anywhere;
			background: var(--bg-input);
			border: 0.1rem solid var(--border-input);
			border-radius: var(--radius-input);
			padding: 0.5rem 0.75rem;
			font-size: 0.8125rem;
		}
	}
</style>
