<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
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
	import DataTable from '$lib/components/DataTable.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import AccountAvatar from '$lib/components/AccountAvatar.svelte';
	import PlayerPicker from '$lib/components/PlayerPicker.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import Select from '$lib/components/Select.svelte';
	import MultiSelect from '$lib/components/MultiSelect.svelte';
	import ResourceMeta from '$lib/components/ResourceMeta.svelte';
	import PolicyEditor from '$lib/components/PolicyEditor.svelte';
	import { IAM_SERVICES, actionLabelKey, actionsOf, type IamActionSpec } from '$shared/iam/actions';
	import { builtinPolicy } from '$shared/iam/builtin';
	import type { AccountPermissions, InlineView, PolicySummary, SimulationResult } from '$core/iam';
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

	// permissions tab: what the evaluator reads for this account, loaded beside the account
	let perms = $state<AccountPermissions | null>(null);
	let permsError = $state('');
	let permsBusy = $state(false);

	let attachOpen = $state(false);
	let attachPick = $state<string[]>([]);
	let policyCatalog = $state<PolicySummary[]>([]);

	let inlineOpen = $state(false);
	let inlineEditing = $state(false);
	let inlineName = $state('');
	let inlineYaml = $state('');
	let inlineRemoveOpen = $state(false);
	let inlineToRemove = $state<InlineView | null>(null);

	let leaveOpen = $state(false);
	let groupToLeave = $state<AccountPermissions['groups'][number] | null>(null);

	// simulator
	let simService = $state(IAM_SERVICES[0] ?? 'instance');
	let simAction = $state('');
	let simResource = $state('');
	let simBusy = $state(false);
	let simResult = $state<SimulationResult | null>(null);

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
					{ label: t('web.accountDetail.linkPlayer'), icon: 'cube', action: () => openLink() },
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
				label: row.kind === 'minecraft'
					? t('web.accountDetail.unlinkPlayer')
					: t('web.accountDetail.removeIdentity'),
				icon: row.kind === 'minecraft' ? 'linkHorizontalSlash' : 'trash',
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

	async function openAttach(): Promise<void> {
		attachPick = [];
		attachOpen = true;

		try {
			const data = await api<{ policies: PolicySummary[] }>('/iam/policies');

			policyCatalog = data.policies;
		} catch (err) {
			Notify.error(t('web.accountDetail.policiesLoadFailed'), { detail: (err as Error).message });
		}
	}

	/** Policies the account does not hold directly yet; the attach dialog's choices. */
	const attachable = $derived(
		policyCatalog
			.filter((policy) => !(perms?.policies ?? []).includes(policy.name))
			.map((policy) => ({ value: policy.name, label: policy.name }))
	);

	async function attachPicked(): Promise<void> {
		if (!perms || attachPick.length === 0) {
			return;
		}

		permsBusy = true;

		const failed: string[] = [];

		for (const policy of attachPick) {
			try {
				await post('/iam/attachments', { account: perms.username, policy });
			} catch (err) {
				failed.push(`${policy}: ${(err as Error).message}`);
			}
		}

		permsBusy = false;

		if (failed.length === 0) {
			Notify.success(t('web.accountDetail.attached', { count: attachPick.length }));
			attachOpen = false;
		} else {
			Notify.warning(t('web.accountDetail.attachPartial', { failed: failed.length }), { detail: failed.join('\n') });
		}

		await loadPermissions();
	}

	async function detach(policy: string): Promise<void> {
		if (!perms) {
			return;
		}

		try {
			await api('/iam/attachments', {
				method: 'DELETE',
				body: JSON.stringify({ account: perms.username, policy })
			});
			Notify.success(t('web.accountDetail.detached', { policy }));
			await loadPermissions();
		} catch (err) {
			Notify.error(t('web.accountDetail.detachFailed', { policy }), { detail: (err as Error).message });
		}
	}

	function askLeave(group: AccountPermissions['groups'][number]): void {
		groupToLeave = group;
		leaveOpen = true;
	}

	async function leaveConfirmed(): Promise<void> {
		const group = groupToLeave;

		if (!group || !perms) {
			return;
		}

		try {
			await api(`/iam/groups/${encodeURIComponent(group.name)}/members`, {
				method: 'DELETE',
				body: JSON.stringify({ members: [perms.accountId] })
			});
			Notify.success(t('web.accountDetail.leftGroup', { group: group.name }));
			await loadPermissions();
		} catch (err) {
			Notify.error(t('web.accountDetail.leaveFailed', { group: group.name }), { detail: (err as Error).message });
		}
	}

	function openInline(existing: InlineView | null): void {
		inlineEditing = existing !== null;
		inlineName = existing?.name ?? '';
		inlineYaml = existing?.yaml ?? 'Version: 1\nStatement:\n  - Effect: Allow\n    Action: []\n    Resource: "*"\n';
		inlineOpen = true;
	}

	const inlineReady = $derived(inlineName.trim() !== '' && inlineYaml.trim() !== '');

	async function saveInline(): Promise<void> {
		if (!perms || !inlineReady) {
			return;
		}

		permsBusy = true;

		try {
			await put('/iam/inline', { account: perms.username, name: inlineName.trim(), yaml: inlineYaml });
			Notify.success(t('web.accountDetail.inlineSaved', { name: inlineName.trim() }));
			inlineOpen = false;
			await loadPermissions();
		} catch (err) {
			Notify.error(t('web.accountDetail.inlineSaveFailed'), { detail: (err as Error).message });
		} finally {
			permsBusy = false;
		}
	}

	function askRemoveInline(row: InlineView): void {
		inlineToRemove = row;
		inlineRemoveOpen = true;
	}

	async function removeInlineConfirmed(): Promise<void> {
		const row = inlineToRemove;

		if (!row || !perms) {
			return;
		}

		try {
			await api('/iam/inline', {
				method: 'DELETE',
				body: JSON.stringify({ account: perms.username, name: row.name })
			});
			Notify.success(t('web.accountDetail.inlineRemoved', { name: row.name }));
			await loadPermissions();
		} catch (err) {
			Notify.error(t('web.accountDetail.inlineRemoveFailed', { name: row.name }), { detail: (err as Error).message });
		}
	}

	/** The catalog's own words for an action, or just its name when the locale has none. */
	function actionLabel(spec: IamActionSpec): string {
		const key = actionLabelKey(spec);
		const label = t(key);

		return label === key
			? spec.name
			: `${spec.verb} · ${label}`;
	}

	const serviceOptions = $derived(IAM_SERVICES.map((name) => ({ value: name, label: name })));

	const actionOptions = $derived(actionsOf(simService).map((spec) => ({ value: spec.name, label: actionLabel(spec) })));

	// a service change leaves the old verb behind; the first of the new service is the sensible pick
	$effect(() => {
		const first = actionsOf(simService)[0];

		if (first && !actionsOf(simService).some((spec) => spec.name === simAction)) {
			simAction = first.name;
		}
	});

	async function simulate(): Promise<void> {
		if (!perms || !simAction) {
			return;
		}

		simBusy = true;

		try {
			simResult = await post<SimulationResult>('/iam/simulate', {
				account: perms.username,
				action: simAction,
				resource: simResource.trim() || undefined
			});
		} catch (err) {
			simResult = null;
			Notify.error(t('web.accountDetail.simulateFailed'), { detail: (err as Error).message });
		} finally {
			simBusy = false;
		}
	}

	const reasonLabels: Record<string, string> = $derived({
		allow: t('web.accountDetail.reasonAllow'),
		'explicit-deny': t('web.accountDetail.reasonExplicitDeny'),
		'implicit-deny': t('web.accountDetail.reasonImplicitDeny'),
		root: t('web.accountDetail.reasonRoot')
	});

	const sourceLabels: Record<string, string> = $derived({
		builtin: t('web.accountDetail.sourceBuiltin'),
		managed: t('web.accountDetail.sourceManaged'),
		inline: t('web.accountDetail.sourceInline')
	});

	const groupColumns: Column[] = $derived([
		{ id: 'name', label: t('web.accountDetail.colGroup'), sortable: true, width: 220 },
		{ id: 'policies', label: t('web.accountDetail.colGroupPolicies') },
		{ id: 'inline', label: t('web.accountDetail.colGroupInline'), width: 160 }
	]);

	const policyColumns: Column[] = $derived([
		{ id: 'name', label: t('web.accountDetail.colPolicy'), sortable: true, width: 260 },
		{ id: 'kind', label: t('web.accountDetail.colPolicyKind'), sortable: true, width: 140 },
		{ id: 'description', label: t('web.accountDetail.colPolicyDescription') }
	]);

	const inlineColumns: Column[] = $derived([
		{ id: 'name', label: t('web.accountDetail.colInline'), sortable: true, width: 240 },
		{ id: 'statements', label: t('web.accountDetail.colStatements'), width: 120 },
		{ id: 'updated', label: t('web.accountDetail.colUpdated'), sortable: true, width: 180 },
		{ id: 'updatedBy', label: t('web.accountDetail.colUpdatedBy'), sortable: true }
	]);

	function groupActions(row: AccountPermissions['groups'][number]): ContextMenuItem[] {
		return [
			{ label: t('web.accountDetail.openGroup'), icon: 'users', action: () => goto(`/console/iam/groups/${encodeURIComponent(row.name)}`) },
			{ separator: true },
			{ label: t('web.accountDetail.leaveGroup'), icon: 'userMinus', color: 'danger', action: () => askLeave(row) }
		];
	}

	function policyActions(row: { name: string }): ContextMenuItem[] {
		return [
			{ label: t('web.accountDetail.openPolicy'), icon: 'shieldHalved', action: () => goto(`/console/iam/policies/${encodeURIComponent(row.name)}`) },
			{ separator: true },
			{ label: t('web.accountDetail.detachPolicy'), icon: 'unlink', color: 'danger', action: () => detach(row.name) }
		];
	}

	function inlineActions(row: InlineView): ContextMenuItem[] {
		return [
			{ label: t('web.common.edit'), icon: 'pen', action: () => openInline(row) },
			{ separator: true },
			{ label: t('web.accountDetail.removeInline'), icon: 'trash', color: 'danger', action: () => askRemoveInline(row) }
		];
	}

	/** The attached names as rows, with what the catalog says about each built-in. */
	const policyRows = $derived(
		(perms?.policies ?? []).map((name) => ({
			name,
			builtin: builtinPolicy(name) !== undefined,
			description: builtinPolicy(name) ? t(builtinPolicy(name)!.descriptionKey) : ''
		}))
	);
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
			{ id: 'permissions', label: t('web.accountDetail.tabPermissions') },
			{ id: 'identities', label: t('web.accountDetail.tabIdentities') },
			{ id: 'sessions', label: t('web.accountDetail.tabSessions') },
			{ id: 'activity', label: t('web.accountDetail.tabActivity') }
		]}
		bind:active={tab}
	/>

	<div class="tabbody">
		{#if tab === 'details'}
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

			<ResourceMeta id="luna:account/{detail.account.username}" />
		{:else if tab === 'permissions'}
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
				{/if}

				<Panel
					title={t('web.accountDetail.groupsPanel')}
					count={perms.groups.length}
					description={t('web.accountDetail.groupsHint')}
					flush
				>
					{#if perms.groups.length}
						<DataTable
							columns={groupColumns}
							rows={perms.groups}
							getId={(row) => row.id}
							rowActions={groupActions}
							rowLabel={(row) => row.name}
						>
							{#snippet cell(row, col)}
								{#if col === 'name'}
									<a href="/console/iam/groups/{encodeURIComponent(row.name)}"><b>{row.name}</b></a>
								{:else if col === 'policies'}
									<span class:dim={row.policies.length === 0}>{row.policies.join(', ') || '–'}</span>
								{:else if col === 'inline'}
									<span class:dim={row.inline.length === 0}>{row.inline.join(', ') || '–'}</span>
								{/if}
							{/snippet}
						</DataTable>
					{:else}
						<p class="none dim">{t('web.accountDetail.noGroups')}</p>
					{/if}
				</Panel>

				<div class="gap"></div>

				<Panel
					title={t('web.accountDetail.policiesPanel')}
					count={policyRows.length}
					description={t('web.accountDetail.policiesHint')}
					flush
				>
					{#snippet actions()}
						<Btn icon="plus" onclick={() => void openAttach()}>{t('web.accountDetail.attachPolicy')}</Btn>
					{/snippet}
					{#if policyRows.length}
						<DataTable
							columns={policyColumns}
							rows={policyRows}
							getId={(row) => row.name}
							rowActions={policyActions}
							rowLabel={(row) => row.name}
						>
							{#snippet cell(row, col)}
								{#if col === 'name'}
									<a href="/console/iam/policies/{encodeURIComponent(row.name)}"><b>{row.name}</b></a>
								{:else if col === 'kind'}
									{#if row.builtin}
										<StatusBadge state="info" label={t('web.accountDetail.builtin')} />
									{:else}
										<span class="dim">{t('web.accountDetail.managed')}</span>
									{/if}
								{:else if col === 'description'}
									<span class="dim">{row.description || '–'}</span>
								{/if}
							{/snippet}
						</DataTable>
					{:else}
						<p class="none dim">{t('web.accountDetail.noPolicies')}</p>
					{/if}
				</Panel>

				<div class="gap"></div>

				<Panel
					title={t('web.accountDetail.inlinePanel')}
					count={perms.inline.length}
					description={t('web.accountDetail.inlineHint')}
					flush
				>
					{#snippet actions()}
						<Btn icon="plus" onclick={() => openInline(null)}>{t('web.accountDetail.addInline')}</Btn>
					{/snippet}
					{#if perms.inline.length}
						<DataTable
							columns={inlineColumns}
							rows={perms.inline}
							getId={(row) => row.name}
							rowActions={inlineActions}
							rowLabel={(row) => row.name}
							onRowClick={(row) => openInline(row)}
						>
							{#snippet cell(row, col)}
								{#if col === 'name'}
									<b class="mono">{row.name}</b>
								{:else if col === 'statements'}
									{row.document.Statement.length}
								{:else if col === 'updated'}
									<span class="dim">{fmtDateTime(row.updatedAt)}</span>
								{:else if col === 'updatedBy'}
									<span class:dim={!row.updatedBy}>{row.updatedBy ?? '–'}</span>
								{/if}
							{/snippet}
						</DataTable>
					{:else}
						<p class="none dim">{t('web.accountDetail.noInline')}</p>
					{/if}
				</Panel>

				<div class="gap"></div>

				<Panel title={t('web.accountDetail.simulatePanel')} description={t('web.accountDetail.simulateHint')}>
					<div class="simrow">
						<Select label={t('web.accountDetail.simService')} bind:value={simService} options={serviceOptions} width="11rem" searchable />
						<Select label={t('web.accountDetail.simAction')} bind:value={simAction} options={actionOptions} width="20rem" searchable />
						<input
							class="input mono simresource"
							type="text"
							placeholder="luna:instance/survival"
							bind:value={simResource}
							onkeydown={(event) => {
								if (event.key === 'Enter') {
									void simulate();
								}
							}}
						/>
						<Btn variant="primary" icon="play" loading={simBusy} disabled={!simAction} onclick={() => void simulate()}>
							{t('web.accountDetail.simRun')}
						</Btn>
					</div>

					{#if simResult}
						<div class="simresult">
							<StatusBadge
								state={simResult.verdict.allowed ? 'ok' : 'failed'}
								label={simResult.verdict.allowed ? t('web.accountDetail.simAllowed') : t('web.accountDetail.simDenied')}
							/>
							<span class="simreason">{reasonLabels[simResult.verdict.reason] ?? simResult.verdict.reason}</span>
							<span class="mono dim simreq">
								{simResult.request.action}
								{#if simResult.request.resource}
									{t('web.accountDetail.simOn')} {simResult.request.resource}
								{/if}
							</span>
							{#if simResult.verdict.matched}
								<span class="simmatch">
									{t('web.accountDetail.simMatched', {
										kind: sourceLabels[simResult.verdict.matched.source.kind] ?? simResult.verdict.matched.source.kind,
										name: simResult.verdict.matched.source.name
									})}
									{#if simResult.verdict.matched.source.group}
										{t('web.accountDetail.simViaGroup', { group: simResult.verdict.matched.source.group })}
									{/if}
									<span class="mono">
										{simResult.verdict.matched.sid
											? t('web.accountDetail.simSid', { sid: simResult.verdict.matched.sid })
											: t('web.accountDetail.simStatement', { index: simResult.verdict.matched.index + 1 })}
									</span>
								</span>
							{/if}
							{#if simResult.resource}
								<span class="dim simfacts">
									{t('web.accountDetail.simResourceFacts', {
										creator: simResult.resource.createdBy ?? '–',
										tags: Object.entries(simResult.resource.tags).map(([key, value]) => `${key}=${value}`).join(', ') || '–'
									})}
								</span>
							{/if}
						</div>
					{/if}
				</Panel>
			{/if}
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

	<Modal title={t('web.accountDetail.attachTitle')} bind:open={attachOpen}>
		<p class="modalnote dim">{t('web.accountDetail.attachHint')}</p>
		<div class="field">
			<span class="lbl">{t('web.accountDetail.attachField')}</span>
			<MultiSelect bind:value={attachPick} options={attachable} width="100%" placeholder={t('web.accountDetail.attachPlaceholder')} />
		</div>

		{#snippet footer()}
			<Btn onclick={() => (attachOpen = false)}>{t('web.common.cancel')}</Btn>
			<Btn variant="primary" disabled={attachPick.length === 0} loading={permsBusy} onclick={() => void attachPicked()}>
				{t('web.accountDetail.attachAction', { count: attachPick.length })}
			</Btn>
		{/snippet}
	</Modal>

	<Modal
		title={inlineEditing ? t('web.accountDetail.inlineEditTitle', { name: inlineName }) : t('web.accountDetail.inlineAddTitle')}
		bind:open={inlineOpen}
		wide
	>
		<p class="modalnote dim">{t('web.accountDetail.inlineModalHint')}</p>
		<label class="field">
			<span class="lbl">{t('web.accountDetail.inlineName')}</span>
			<input class="input mono" type="text" bind:value={inlineName} disabled={inlineEditing} />
		</label>
		<div class="field">
			<span class="lbl">{t('web.accountDetail.inlineDocument')}</span>
			<PolicyEditor bind:value={inlineYaml} />
		</div>

		{#snippet footer()}
			<Btn onclick={() => (inlineOpen = false)}>{t('web.common.cancel')}</Btn>
			<Btn variant="primary" disabled={!inlineReady} loading={permsBusy} onclick={() => void saveInline()}>
				{t('web.common.save')}
			</Btn>
		{/snippet}
	</Modal>

	<ConfirmModal
		bind:open={inlineRemoveOpen}
		title={t('web.accountDetail.inlineRemoveTitle', { name: inlineToRemove?.name ?? '' })}
		lead={t('web.accountDetail.inlineRemoveLead', { name: inlineToRemove?.name ?? '', account: detail.account.username })}
		confirmLabel={t('web.accountDetail.removeInline')}
		onconfirm={() => void removeInlineConfirmed()}
	/>

	<ConfirmModal
		bind:open={leaveOpen}
		title={t('web.accountDetail.leaveTitle', { group: groupToLeave?.name ?? '' })}
		lead={t('web.accountDetail.leaveLead', { account: detail.account.username, group: groupToLeave?.name ?? '' })}
		confirmLabel={t('web.accountDetail.leaveGroup')}
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

	.simrow {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
	}

	.simresource {
		flex: 1 1 16rem;
		min-width: 12rem;
	}

	// the verdict reads as one line: badge, reason, then what decided it
	.simresult {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
		margin-top: 1rem;
		padding-top: 1rem;
		border-top: var(--hairline) solid var(--border-divider);
		font-size: 0.8125rem;
	}

	.simreq {
		font-size: 0.75rem;
	}

	.simmatch {
		display: inline-flex;
		gap: 0.375rem;
		flex-wrap: wrap;
	}

	.simfacts {
		flex-basis: 100%;
		font-size: 0.75rem;
	}
</style>
