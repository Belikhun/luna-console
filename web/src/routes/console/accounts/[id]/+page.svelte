<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { Authz } from '$lib/authz.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto, invalidateAll } from '$app/navigation';
	import { api, del, patch, post, put } from '$lib/api';
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
	import ResourceIdValue from '$lib/components/ResourceIdValue.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import AccountAvatar from '$lib/components/AccountAvatar.svelte';
	import PlayerPicker from '$lib/components/PlayerPicker.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import ResourceMeta from '$lib/components/ResourceMeta.svelte';
	import PermissionsPolicies from '$lib/components/PermissionsPolicies.svelte';
	import GroupPickTable from '$lib/components/GroupPickTable.svelte';
	import type { AccountPermissions } from '$core/iam';
	import type { InfoCell } from '$lib/components/grid';
	import type { Column } from '$lib/components/table';
	import { menuGroups, type ContextMenuItem } from '$lib/components/contextmenu';
	import { Notify } from '$lib/notifications.svelte';
	import { MIN_PASSWORD_LENGTH } from '$shared/accountrules';
	import { groupHref, iamResourceId, notifyEach, runEach, type GroupRow } from '$lib/iam';
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
	 * One console account, AWS's user screen: a summary that is always in view,
	 * then the permissions that reach the account, the groups it is in, its
	 * tags, its security credentials (password, access keys, linked Minecraft
	 * profiles, open sessions, picture) and everything done to it.
	 *
	 * An account is not one credential: a console password is what a person signs
	 * in with, an access key is what a script sends, and a linked Minecraft
	 * profile records which player this operator is. They are retired
	 * independently, and a leaked access key has to be killable without locking
	 * its owner out of the console.
	 */

	interface Detail {
		account: AccountRow;
		sessions: SessionRow[];
		audit: AuditRow[];
		/** whether this is the account the browser is signed in as */
		self: boolean;
	}

	/** One group the account is in, as its permissions report it. */
	type Membership = AccountPermissions['groups'][number];

	const TABS = ['permissions', 'groups', 'tags', 'credentials', 'activity'];

	const id = $derived(page.params.id!);

	let detail = $state<Detail | null>(null);
	let loading = $state(false);
	let missing = $state(false);
	let lastUpdated = $state<number | null>(null);
	let tab = $state(TABS.includes(page.url.searchParams.get('tab') ?? '') ? page.url.searchParams.get('tab')! : 'permissions');

	let passwordOpen = $state(false);
	let keyOpen = $state(false);
	let linkOpen = $state(false);
	let deleteOpen = $state(false);
	let busy = $state(false);

	let identityRemoveOpen = $state(false);
	/** the identity the remove dialog is about; set by the row verb, read on confirm */
	let identityToRemove = $state<IdentityRow | null>(null);

	// what the evaluator reads for this account, loaded beside the account
	let perms = $state<AccountPermissions | null>(null);
	let permsError = $state('');

	// groups tab
	let selectedGroups: Set<string> = $state(new Set());
	let leaveOpen = $state(false);
	let leaveRows: Membership[] = $state([]);
	let joinOpen = $state(false);
	let joinPicked: Set<string> = $state(new Set());
	let allGroups: GroupRow[] = $state([]);

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
	let linkAsAvatar = $state(false);

	/** the core refuses anything else, so a typed name has to be picked from the directory first */
	const linkUuidValid = $derived(/^[0-9a-fA-F-]{32,36}$/.test(linkUuid.trim()));

	// picture
	let avatarBusy = $state(false);
	let avatarPicker: HTMLInputElement | undefined = $state();

	/** px of the square an upload is cropped and shrunk to before it leaves the browser */
	const AVATAR_PX = 256;

	const minecraftIdentities = $derived(
		(detail?.account.identities ?? []).filter((identity) => identity.kind === 'minecraft' && !identity.disabled)
	);

	const avatarSourceLabel = $derived.by(() => {
		const account = detail?.account;

		if (!account) {
			return '';
		}

		if (account.avatar?.source === 'upload') {
			return t('web.accountDetail.avatarUploaded');
		}

		if (account.avatar?.source === 'minecraft') {
			return t('web.accountDetail.avatarMinecraft', { player: account.avatar.playerName ?? account.avatar.uuid });
		}

		return t('web.accountDetail.avatarInitials');
	});

	const avatarVerbs: ContextMenuItem[] = $derived([
		...minecraftIdentities.map((identity) => ({
			label: t('web.accountDetail.avatarUseSkin', { player: identity.playerName ?? identity.uuid ?? identity.label }),
			icon: 'cube',
			action: () => saveAvatar({ source: 'minecraft', identity: identity.id })
		})),
		{ label: t('web.accountDetail.avatarLinkPlayer'), icon: 'link', action: () => openLink(true) },
		{ label: t('web.accountDetail.avatarUseInitials'), icon: 'font', action: () => saveAvatar({ source: 'initials' }) },
		{ separator: true },
		{
			label: t('web.accountDetail.avatarAuto'),
			icon: 'rotate',
			disabled: !detail?.account.avatarChosen,
			hint: t('web.accountDetail.avatarAutoHint'),
			action: () => saveAvatar({ source: 'auto' })
		},
		...(minecraftIdentities.length > 0 ? [{ separator: true }] : []),
		...minecraftIdentities.map((identity) => ({
			label: t('web.accountDetail.unlinkNamed', { player: identity.playerName ?? identity.label }),
			icon: 'linkHorizontalSlash',
			color: 'danger' as const,
			action: () => removeIdentity(identity)
		}))
	]);

	async function saveAvatar(body: Record<string, unknown>): Promise<void> {
		if (!detail) {
			return;
		}

		avatarBusy = true;

		try {
			const result = await put(`/accounts/${encodeURIComponent(detail.account.id)}/avatar`, body);

			detail.account = result.account;
			Notify.success(t('web.accountDetail.avatarSaved'));

			// the top bar draws the signed-in account from the layout's data
			if (detail.self) {
				await invalidateAll();
			}
		} catch (err) {
			Notify.error(t('web.accountDetail.avatarFailed'), { detail: (err as Error).message });
		} finally {
			avatarBusy = false;
		}
	}

	/**
	 * Crop a picked image to its centred square and shrink it, in the browser:
	 * the daemon has no image decoder, and a phone photo is megabytes where the
	 * picture is shown at a few dozen pixels.
	 */
	async function squareImage(file: File): Promise<string> {
		const bitmap = await createImageBitmap(file);
		const side = Math.min(bitmap.width, bitmap.height);
		const canvas = document.createElement('canvas');

		canvas.width = AVATAR_PX;
		canvas.height = AVATAR_PX;

		const context = canvas.getContext('2d')!;

		// pixel art (a skin render, a server icon) stays sharp when it is enlarged
		context.imageSmoothingEnabled = side >= AVATAR_PX;
		context.drawImage(
			bitmap,
			(bitmap.width - side) / 2,
			(bitmap.height - side) / 2,
			side,
			side,
			0,
			0,
			AVATAR_PX,
			AVATAR_PX
		);
		bitmap.close();

		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
		const bytes = new Uint8Array(await (blob ?? new Blob()).arrayBuffer());
		let binary = '';

		for (const byte of bytes) {
			binary += String.fromCharCode(byte);
		}

		return btoa(binary);
	}

	async function onAvatarPicked(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];

		input.value = '';

		if (!file) {
			return;
		}

		try {
			await saveAvatar({ source: 'upload', data: await squareImage(file) });
		} catch (err) {
			Notify.error(t('web.accountDetail.avatarFailed'), { detail: (err as Error).message });
		}
	}

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const data = await api(`/accounts/${encodeURIComponent(id)}`);

			detail = { ...data, audit: keyAudit(data.audit) };
			missing = false;
			lastUpdated = Date.now();
			await loadPermissions();
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

	/** A failure here is shown inside the tab: the rest of the account is still worth reading. */
	async function loadPermissions(): Promise<void> {
		try {
			const data = await api<{ permissions: AccountPermissions }>(`/accounts/${encodeURIComponent(id)}/permissions`);

			perms = data.permissions;
			permsError = '';
		} catch (err) {
			perms = null;
			permsError = (err as Error).message;
		}
	}

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

	/** `asAvatar` when opened from the picture panel: the link is wanted for its face */
	function openLink(asAvatar = false): void {
		linkUuid = '';
		linkPlayer = '';
		linkAsAvatar = asAvatar;
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
			const result = await post(`/accounts/${detail!.account.id}/identities`, {
				kind: 'minecraft',
				uuid: linkUuid.trim(),
				playerName: linkPlayer
			});

			Notify.success(t('web.accountDetail.linked', { player: linkPlayer || linkUuid }));
			linkOpen = false;

			if (linkAsAvatar && result.identity?.id) {
				await saveAvatar({ source: 'minecraft', identity: result.identity.id });
			}

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
	/** Why the viewer may not use a verb (on this account, by default), or undefined when it may. */
	function refusedTo(action: string, resource: string | null = detail ? `luna:account/${detail.account.username}` : null): string | undefined {
		return Authz.can(action, resource)
			? undefined
			: t('web.common.notAllowed', { action });
	}

	const accountVerbs: ContextMenuItem[] = $derived(
		!detail
			? []
			: menuGroups(
					[
						{
							label: detail.account.enabled
								? t('web.accountDetail.disableAccount')
								: t('web.accountDetail.enableAccount'),
							icon: detail.account.enabled ? 'ban' : 'circleCheck',
							color: detail.account.enabled ? 'warning' : 'default',
							disabled: (detail.self && detail.account.enabled) || !!refusedTo('account:Administer'),
							hint: refusedTo('account:Administer')
								|| (detail.self && detail.account.enabled ? t('web.accounts.notYourself') : undefined),
							action: () => setEnabled(!detail!.account.enabled)
						},
						{
							label: t('web.accountDetail.unlockAccount'),
							icon: 'unlock',
							disabled: !detail.account.lockedUntil || !!refusedTo('account:Administer'),
							hint: refusedTo('account:Administer')
								|| (detail.account.lockedUntil ? undefined : t('web.accounts.noneLocked')),
							action: unlock
						}
					],
					[
						{
							label: t('web.accountDetail.editDetails'),
							icon: 'pen',
							action: () => goto(`/console/accounts/${detail!.account.id}/edit`)
						},
						{ label: t('web.accountDetail.setPassword'), icon: 'key', action: openPassword },
						{ label: t('web.accountDetail.linkPlayer'), icon: 'cube', action: () => openLink() }
					],
					[
						{
							label: detail.self
								? t('web.accountDetail.revokeOthers')
								: t('web.accountDetail.revokeSessions'),
							icon: 'rightFromBracket',
							color: 'danger',
							disabled: detail.sessions.length === 0,
							hint: detail.sessions.length ? undefined : t('web.accounts.noSessions'),
							action: revokeAll
						},
						{
							label: t('web.accountDetail.deleteAccount'),
							icon: 'trash',
							color: 'danger',
							disabled: detail.self || !!refusedTo('account:Delete'),
							hint: detail.self
								? t('web.accounts.notYourself')
								: refusedTo('account:Delete'),
							action: () => {
								deleteOpen = true;
							}
						}
					]
				)
	);

	/** Whether the account can sign in to the console, in AWS's "console access" words. */
	const consoleAccess = $derived.by(() => {
		const account = detail?.account;

		if (!account) {
			return { state: 'stopped', label: '' };
		}

		if (!account.enabled) {
			return { state: 'stopped', label: t('web.accountDetail.accessDisabled') };
		}

		if (account.lockedUntil) {
			return { state: 'failed', label: t('web.accountDetail.accessLocked') };
		}

		if (!account.hasPassword) {
			return { state: 'warning', label: t('web.accountDetail.accessNoPassword') };
		}

		return { state: 'ok', label: t('web.accountDetail.accessEnabled') };
	});

	const accessKeys = $derived((detail?.account.identities ?? []).filter((identity) => identity.kind === 'accessKey'));

	const summaryCells: InfoCell[] = $derived(
		!detail
			? []
			: [
					{ id: 'resourceId', label: t('web.accountDetail.resourceId'), colSpan: 2 },
					{
						label: t('web.accountDetail.created'),
						value: `${fmtDateTime(detail.account.createdAt)}${detail.account.createdBy ? ` · ${detail.account.createdBy}` : ''}`
					},
					{ id: 'access', label: t('web.accountDetail.consoleAccess') },
					{
						label: t('web.accountDetail.lastSignIn'),
						value: detail.account.lastSignInAt
							? fmtDateTime(detail.account.lastSignInAt)
							: t('web.accounts.never')
					},
					{
						label: t('web.accountDetail.accessKeys'),
						value: accessKeys.length
							? t('web.accountDetail.accessKeysActive', {
									active: accessKeys.filter((key) => !key.disabled).length,
									total: accessKeys.length
								})
							: t('web.accountDetail.accessKeysNone')
					},
					{ label: t('web.accountDetail.openSessions'), value: detail.sessions.length },
					{ label: t('web.accountDetail.failedAttempts'), value: String(detail.account.failedAttempts) },
					{ label: t('web.accountDetail.displayName'), value: detail.account.displayName || '–' },
					{ label: t('web.accountDetail.email'), value: detail.account.email || '–' },
					{ label: t('web.accountDetail.purpose'), value: detail.account.description || '–' },
					{ id: 'accountId', label: t('web.accountDetail.accountId') }
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
		return menuGroups(
			[
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
				}
			],
			[
				{
					id: 'copy-identity-id',
					label: t('web.accountDetail.copyIdentityId'),
					icon: 'copy',
					action: async () => {
						await copyText(row.id);
					}
				}
			],
			[
				{
					label: row.kind === 'minecraft'
						? t('web.accountDetail.unlinkPlayer')
						: t('web.accountDetail.removeIdentity'),
					icon: row.kind === 'minecraft' ? 'linkHorizontalSlash' : 'trash',
					color: 'danger',
					disabled: row.kind === 'password',
					hint: row.kind === 'password' ? t('web.accountDetail.replacePasswordInstead') : undefined,
					action: () => removeIdentity(row)
				}
			]
		);
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

	const pickedGroups = $derived((perms?.groups ?? []).filter((row) => selectedGroups.has(row.name)));
	const memberOf = $derived(new Set((perms?.groups ?? []).map((row) => row.name)));

	async function openJoin(): Promise<void> {
		joinPicked = new Set();
		joinOpen = true;

		try {
			const data = await api<{ groups: GroupRow[] }>('/iam/groups');

			allGroups = data.groups;
		} catch (err) {
			Notify.error(t('web.accountDetail.groupsLoadFailed'), { detail: (err as Error).message });
		}
	}

	async function joinConfirmed(): Promise<void> {
		if (!perms) {
			return;
		}

		const accountId = perms.accountId;

		busy = true;

		const outcome = await runEach(
			[...joinPicked],
			(name) => post(`/iam/groups/${encodeURIComponent(name)}/members`, { members: [accountId] }),
			(name) => name
		);

		busy = false;
		joinOpen = false;
		notifyEach(outcome, t('web.accountDetail.joinedGroups', { count: outcome.done }), t('web.accountDetail.joinFailed'));
		await loadPermissions();
	}

	function askLeave(rows: Membership[]): void {
		if (rows.length === 0) {
			return;
		}

		leaveRows = rows;
		leaveOpen = true;
	}

	async function leaveConfirmed(): Promise<void> {
		if (!perms) {
			return;
		}

		const accountId = perms.accountId;

		const outcome = await runEach(
			leaveRows,
			(row) => api(`/iam/groups/${encodeURIComponent(row.name)}/members`, {
				method: 'DELETE',
				body: JSON.stringify({ members: [accountId] })
			}),
			(row) => row.name
		);

		selectedGroups = new Set();
		notifyEach(outcome, t('web.accountDetail.leftGroups', { count: outcome.done }), t('web.accountDetail.leaveGroupsFailed'));
		await loadPermissions();
	}

	function groupActions(row: Membership): ContextMenuItem[] {
		const targets = selectedGroups.has(row.name) && pickedGroups.length > 1 ? pickedGroups : [row];

		return [
			{ label: t('web.accountDetail.openGroup'), icon: 'users', action: () => goto(groupHref(row.name)) },
			{ separator: true },
			{
				label: t('web.accountDetail.removeFromGroups', { count: targets.length }),
				icon: 'userMinus',
				color: 'danger',
				disabled: !!refusedTo('iam:UpdateGroup', null),
				hint: refusedTo('iam:UpdateGroup', null),
				action: () => askLeave(targets)
			}
		];
	}

	const groupColumns: Column[] = $derived([
		{ id: 'name', label: t('web.iamList.colGroupName'), sortable: true, width: 240 },
		{ id: 'policies', label: t('web.iamList.colAttachedPolicies') }
	]);
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

	<Panel title={t('web.accountDetail.summary')}>
		<InfoGrid cells={summaryCells}>
			{#snippet custom(cell)}
				{#if cell.id === 'resourceId'}
					<ResourceIdValue
						value={iamResourceId('account', detail!.account.username)}
						label={t('web.accountDetail.resourceId')}
					/>
				{:else if cell.id === 'access'}
					<StatusBadge state={consoleAccess.state} label={consoleAccess.label} />
				{:else if cell.id === 'accountId'}
					<span class="mono dim">{detail!.account.id}</span>
				{/if}
			{/snippet}
		</InfoGrid>
	</Panel>

	<div class="gap"></div>

	<Tabs
		tabs={[
			{ id: 'permissions', label: t('web.accountDetail.tabPermissions') },
			{ id: 'groups', label: t('web.accountDetail.tabGroups', { count: perms?.groups.length ?? 0 }) },
			{ id: 'tags', label: t('web.accountDetail.tabTags') },
			{ id: 'credentials', label: t('web.accountDetail.tabCredentials') },
			{ id: 'activity', label: t('web.accountDetail.tabActivity') }
		]}
		bind:active={tab}
	/>

	<div class="tabbody">
		{#if tab === 'permissions'}
			{#if permsError}
				<Flash kind="error">{t('web.accountDetail.permissionsLoadFailed', { detail: permsError })}</Flash>
			{:else if !perms}
				<p class="none dim">{t('web.common.loading')}</p>
			{:else}
				{#if perms.administrator}
					<Flash kind="info">
						<span class="adminrow">
							<StatusBadge state="ok" label={t('web.accountDetail.administrator')} />
							{t('web.accountDetail.administratorNotice')}
						</span>
					</Flash>
					<div class="gap"></div>
				{/if}

				<PermissionsPolicies
					subject={{ kind: 'account', username: perms.username, id: perms.accountId }}
					permissions={perms}
					onchange={loadPermissions}
				/>
			{/if}
		{:else if tab === 'groups'}
			{#if permsError}
				<Flash kind="error">{t('web.accountDetail.permissionsLoadFailed', { detail: permsError })}</Flash>
			{:else if !perms}
				<p class="none dim">{t('web.common.loading')}</p>
			{:else}
				<Panel
					title={t('web.accountDetail.groupsPanel')}
					count={perms.groups.length}
					description={t('web.accountDetail.groupsHint')}
					flush
				>
					{#snippet actions()}
						<Btn
							icon="userMinus"
							disabled={pickedGroups.length === 0 || !!refusedTo('iam:UpdateGroup', null)}
							title={refusedTo('iam:UpdateGroup', null)
								?? (pickedGroups.length === 0 ? t('web.accountDetail.pickGroups') : undefined)}
							onclick={() => askLeave(pickedGroups)}
						>
							{t('web.accountDetail.removeFromGroups', { count: pickedGroups.length })}
						</Btn>
						<Btn
							variant="primary"
							icon="userPlus"
							disabled={!!refusedTo('iam:UpdateGroup', null)}
							title={refusedTo('iam:UpdateGroup', null)}
							onclick={() => void openJoin()}
						>
							{t('web.accountDetail.addToGroups')}
						</Btn>
					{/snippet}
					<DataTable
						columns={groupColumns}
						rows={perms.groups}
						getId={(row) => row.name}
						selectable="multi"
						bind:selected={selectedGroups}
						rowActions={groupActions}
						rowLabel={(row) => row.name}
						resourceId={(row) => iamResourceId('group', row.name)}
						emptyTitle={t('web.accountDetail.noGroupsTitle')}
						emptyText={t('web.accountDetail.noGroups')}
					>
						{#snippet cell(row, col)}
							{#if col === 'name'}
								<a href={groupHref(row.name)}>{row.name}</a>
							{:else if col === 'policies'}
								<span class:dim={row.policies.length + row.inline.length === 0}>
									{[...row.policies, ...row.inline].join(', ') || '–'}
								</span>
							{/if}
						{/snippet}
					</DataTable>
				</Panel>
			{/if}
		{:else if tab === 'tags'}
			<ResourceMeta id={iamResourceId('account', detail.account.username)} />
		{:else if tab === 'credentials'}
			<Panel title={t('web.accountDetail.avatarPanel')} description={t('web.accountDetail.avatarHint')}>
				{#snippet actions()}
					<Dropdown label={t('web.accountDetail.avatarOther')} menu={avatarVerbs} disabled={avatarBusy} />
					<Btn icon="upload" loading={avatarBusy} onclick={() => avatarPicker?.click()}>
						{t('web.accountDetail.avatarUpload')}
					</Btn>
				{/snippet}
				<div class="picture">
					<AccountAvatar account={detail.account} size="4.5rem" />
					<div class="picwhat">
						<b>{detail.account.displayName || detail.account.username}</b>
						<span class="dim">{avatarSourceLabel}{detail.account.avatarChosen ? '' : ` · ${t('web.accountDetail.avatarAutomatic')}`}</span>
					</div>
				</div>
				<input
					class="picker"
					type="file"
					accept="image/png,image/jpeg,image/gif,image/webp"
					bind:this={avatarPicker}
					onchange={onAvatarPicked}
				/>
			</Panel>

			<div class="gap"></div>

			<Panel
				title={t('web.accountDetail.identitiesPanel')}
				count={detail.account.identities.length}
				description={t('web.accountDetail.identitiesHint')}
				flush
			>
				{#snippet actions()}
					<Btn icon="key" onclick={openPassword}>{t('web.accountDetail.setPassword')}</Btn>
					<Btn icon="cube" onclick={() => openLink()}>{t('web.accountDetail.linkPlayer')}</Btn>
					<Btn variant="primary" icon="terminal" onclick={openKey}>{t('web.accountDetail.createKey')}</Btn>
				{/snippet}
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
			<div class="gap"></div>

			<Panel
				title={t('web.accountDetail.sessionsPanel')}
				count={detail.sessions.length}
				description={t('web.accountDetail.sessionsHint')}
				flush
			>
				{#snippet actions()}
					<Btn
						icon="rightFromBracket"
						disabled={detail!.sessions.length === 0}
						title={detail!.sessions.length ? undefined : t('web.accounts.noSessions')}
						onclick={() => void revokeAll()}
					>
						{detail!.self ? t('web.accountDetail.revokeOthers') : t('web.accountDetail.revokeSessions')}
					</Btn>
				{/snippet}
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
		<div class="field">
			<span class="lbl">{t('web.accountDetail.linkPlayerField')}</span>
			<span class="hint">{t('web.accountDetail.linkPlayerHint')}</span>
			{#key linkOpen}
				<PlayerPicker
					bind:value={linkUuid}
					placeholder={t('web.accountDetail.linkPlaceholder')}
					onpick={(player) => (linkPlayer = player?.username ?? '')}
				/>
			{/key}
		</div>
		<label class="checkrow">
			<Checkbox
				label={t('web.accountDetail.linkAsAvatar')}
				checked={linkAsAvatar}
				onchange={(checked) => (linkAsAvatar = checked)}
			/>
			<span>{t('web.accountDetail.linkAsAvatar')}</span>
		</label>

		{#snippet footer()}
			<Btn onclick={() => (linkOpen = false)}>{t('web.common.cancel')}</Btn>
			<Btn variant="primary" disabled={!linkUuidValid} loading={busy} onclick={linkMinecraft}>
				{t('web.accountDetail.link')}
			</Btn>
		{/snippet}
	</Modal>

	<Modal title={t('web.accountDetail.joinTitle', { name: detail.account.username })} bind:open={joinOpen} wide>
		<p class="modalnote dim">{t('web.accountDetail.joinHint')}</p>
		<GroupPickTable
			tableId="account-join-groups"
			groups={allGroups}
			bind:selected={joinPicked}
			locked={(row) => memberOf.has(row.name)}
		/>

		{#snippet footer()}
			<Btn onclick={() => (joinOpen = false)}>{t('web.common.cancel')}</Btn>
			<Btn variant="primary" disabled={joinPicked.size === 0} loading={busy} onclick={() => void joinConfirmed()}>
				{t('web.accountDetail.joinAction', { count: joinPicked.size })}
			</Btn>
		{/snippet}
	</Modal>

	<ConfirmModal
		bind:open={leaveOpen}
		title={t('web.accountDetail.leaveGroupsTitle', { count: leaveRows.length })}
		lead={t('web.accountDetail.leaveGroupsLead', { account: detail.account.username, groups: leaveRows.map((row) => row.name).join(', ') })}
		notes={[t('web.accountDetail.leaveGroupsNote')]}
		confirmLabel={t('web.common.remove')}
		onconfirm={() => void leaveConfirmed()}
	/>

	<ConfirmModal
		bind:open={identityRemoveOpen}
		title={t('web.accountDetail.removeIdentityTitle', { label: identityToRemove?.label ?? '' })}
		lead={t('web.accountDetail.removeIdentityLead', { label: identityToRemove?.label ?? '' })}
		notes={[t('web.accountDetail.removeIdentityNote')]}
		confirmLabel={identityToRemove?.kind === 'minecraft'
			? t('web.accountDetail.unlinkPlayer')
			: t('web.accountDetail.removeIdentity')}
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

	.checkrow {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		margin-top: 1rem;
		font-size: 0.875rem;
		cursor: pointer;
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

	.picture {
		display: flex;
		align-items: center;
		gap: 1rem;
	}

	.picwhat {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.picker {
		display: none;
	}

	.adminrow {
		display: inline-flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
	}
</style>
