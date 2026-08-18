<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { traitsOf } from '$core/software';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { api, post } from '$lib/api';
	import { fmtDuration, fmtDateTime } from '$lib/format';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Select from '$lib/components/Select.svelte';
	import MultiSelect from '$lib/components/MultiSelect.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import type { Column } from '$lib/components/table';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import OverviewBar from '$lib/components/OverviewBar.svelte';
	import OverviewCell from '$lib/components/OverviewCell.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import type { InfoCell } from '$lib/components/grid';
	import ProgressBar from '$lib/components/ProgressBar.svelte';
	import Tabs from '$lib/components/Tabs.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import Toggle from '$lib/components/Toggle.svelte';
	import PlayerSkin3D from '$lib/components/PlayerSkin3D.svelte';
	import PlayerName from '$lib/components/PlayerName.svelte';
	import FileDrop from '$lib/components/FileDrop.svelte';
	import NodeEditorModal from '$lib/components/NodeEditorModal.svelte';
	import type { NodeSpec } from '$lib/components/nodes';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { copyText } from '$lib/clipboard';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * One player, in full: identity, skin, play history and statistics,
	 * permissions, chat/command log and moderation history; everything LunaCore
	 * has recorded about them, with the administration verbs in the header.
	 */

	interface Detail {
		uuid: string;
		username: string;
		firstSeenAtEpochMillis: number;
		lastSeenAtEpochMillis: number;
		lastServer: string;
		lastAddress: string;
		lastClientVersion: string;
		onlineMode: boolean;
		sessionCount: number;
		online: boolean;
		server: string;
		pingMillis: number;
		sessionMillis: number;
		totalPlayMillis: number;
		skinTexture: string | null;
		playtimeByServer: Array<{ server: string; playMillis: number; stints: number }>;
		sessionTotal: number;
		chatTotal: number;
		commandTotal: number;
		moderationTotal: number;
		permissions: {
			available: boolean;
			primaryGroup?: string;
			primaryGroupDisplay?: string;
			prefix?: string;
			suffix?: string;
		};
	}

	interface Session {
		id: number;
		server: string;
		connectedAtEpochMillis: number;
		disconnectedAtEpochMillis: number;
		durationMillis: number;
		open: boolean;
	}

	interface ChatEntry {
		id: number;
		server: string;
		type: string;
		content: string;
		atEpochMillis: number;
	}

	interface ModEntry {
		id: number;
		action: string;
		actor: string;
		reason: string;
		server: string;
		details: string;
		atEpochMillis: number;
	}

	interface PermNode {
		key: string;
		value: boolean;
		type: string;
		expiryEpochMillis: number;
		contexts: Array<{ key: string; value: string }>;
	}

	interface AuthInfo {
		uuid: string;
		username: string;
		online: boolean;
		authenticated: boolean;
		registered: boolean;
		locked: boolean;
		lockedUntilEpochMillis: number;
		failedAttempts: number;
		lastIp: string;
		lastLoginAtEpochMillis: number;
		createdAtEpochMillis: number;
		temporaryPassword: boolean;
		temporaryPasswordUntilEpochMillis: number;
		temporaryPasswordExpired: boolean;
		session: {
			hasSession: boolean;
			connected: boolean;
			createdAtEpochMillis: number;
			expiresAtEpochMillis: number;
			ip: string;
		};
	}

	interface VaultInfo {
		uuid: string;
		username: string;
		online: boolean;
		hasAccount: boolean;
		balanceMinor: number;
		balance: number;
		balanceFormatted: string;
		rank: number;
		accountCount: number;
		currency: { symbol: string; grouping: boolean; scale: number };
		summary: {
			transactionCount: number;
			receivedMinor: number;
			receivedFormatted: string;
			sentMinor: number;
			sentFormatted: string;
			netMinor: number;
			netFormatted: string;
			firstAtEpochMillis: number;
			lastAtEpochMillis: number;
		};
	}

	interface VaultTx {
		id: string;
		direction: 'in' | 'out' | 'self';
		counterpartyUuid: string;
		counterpartyName: string;
		system: boolean;
		amountMinor: number;
		amountFormatted: string;
		source: string;
		details: string;
		atEpochMillis: number;
	}

	/** Page size for the log tabs; "Load more" appends another page. */
	const LOG_PAGE = 100;

	/** Transactions per request; LunaVault pages this one by page index, not offset. */
	const VAULT_PAGE = 50;

	/** Default lifetime offered for a temporary password, in minutes. */
	const DEFAULT_TEMP_MINUTES = 1440;

	/** Lifetimes the dialog offers, matching what luna-auth accepts. */
	const TEMP_LIFETIMES = [
		{ value: '15', label: t('web.playerDetail.15Minutes') },
		{ value: '60', label: t('web.playerDetail.1Hour') },
		{ value: '360', label: t('web.playerDetail.6Hours') },
		{ value: '1440', label: t('web.playerDetail.24Hours') },
		{ value: '10080', label: t('web.playerDetail.7Days') },
		{ value: '43200', label: t('web.playerDetail.30Days') }
	];

	const ref = $derived(page.params.player ?? '');

	let detail: Detail | undefined = $state();
	let available = $state(true);
	let notFound = $state(false);
	let problem = $state('');
	let loading = $state(true);
	let lastUpdated: number | null = $state(null);
	let tab = $state('overview');

	let sessions: Session[] = $state([]);
	let sessionsTotal = $state(0);
	let chat: ChatEntry[] = $state([]);
	let chatTotal = $state(0);
	let chatType = $state('');
	let moderation: ModEntry[] = $state([]);
	let moderationTotal = $state(0);

	let permsAvailable = $state(true);
	let permsProblem = $state('');
	let userGroups: string[] = $state([]);
	let primaryGroup = $state('');
	let userNodes: PermNode[] = $state([]);
	let allGroups: Array<{ name: string; displayName: string }> = $state([]);
	let permsLoaded = $state(false);

	let instances: string[] = $state([]);
	let servers: string[] = $state([]);

	// header verb dialogs
	let kickOpen = $state(false);
	let kickReason = $state('');
	let messageOpen = $state(false);
	let messageText = $state('');
	let transferOpen = $state(false);
	let transferTo = $state('');
	let moderateOpen = $state(false);
	let moderateAction = $state('');
	let moderateInstances: string[] = $state([]);
	let moderateReason = $state('');
	let noteOpen = $state(false);
	let noteText = $state('');

	// change-skin dialog
	let skinOpen = $state(false);
	let skinMode = $state('upload');
	let skinFile: File | null = $state(null);
	let skinUrl = $state('');
	let skinName = $state('');
	let skinVariant = $state('');
	let skinBusy = $state(false);
	/** Bumped after a change so the canvases re-fetch the proxied PNG. */
	let skinEpoch = $state(0);

	// account & password administration
	let authInfo: AuthInfo | undefined = $state();
	let authAvailable = $state(true);
	let authProblem = $state('');
	let resetOpen = $state(false);
	let tempOpen = $state(false);
	let tempPassword = $state('');
	let tempMinutes = $state(String(DEFAULT_TEMP_MINUTES));
	let tempBusy = $state(false);
	/** The plaintext of a freshly issued password; shown once, then forgotten. */
	let issuedPassword = $state('');
	let issuedOpen = $state(false);

	// economy; balance and transactions, held by LunaVault on the proxy
	let vaultInfo: VaultInfo | undefined = $state();
	let vaultAvailable = $state(true);
	let vaultProblem = $state('');
	let vaultTx: VaultTx[] = $state([]);
	let vaultTotal = $state(0);
	/** Index of the last page fetched, so "Load more" asks for the next one. */
	let vaultPage = $state(0);

	// permissions editor state
	let groupPick = $state('');
	let nodeKey = $state('');
	let nodeGrant = $state(true);
	let nodeServer = $state('');
	let nodeEditorOpen = $state(false);
	let nodeBeingEdited: PermNode | null = $state(null);

	async function refresh(): Promise<void> {
		try {
			const data = await api(`/players/${encodeURIComponent(ref)}`);

			if (data.available === false) {
				available = false;
				notFound = false;
				problem = data.error ?? 'LunaCore is unreachable';
			} else {
				available = true;
				detail = data as Detail;
				lastUpdated = Date.now();
			}
		} catch (err) {
			// the route answers 404 for a player the directory has never seen
			notFound = true;
			problem = (err as Error).message;
		}

		loading = false;

		// the account state is loaded eagerly rather than with its tab: the header
		// verbs need to know whether the account is locked or has a password.
		// The balance is eager for the same reason; it sits in the overview bar.
		await Promise.all([
			loadAuth(),
			loadVault(),
			loadTab(tab, true),
			permsLoaded ? loadPermissions() : Promise.resolve()
		]);
	}

	async function loadAuth(): Promise<void> {
		try {
			const data = await api(`/players/${encodeURIComponent(ref)}/auth`);

			if (data.available === false) {
				authAvailable = false;
				authProblem = data.error ?? 'luna-auth is unavailable';
				return;
			}

			authAvailable = true;
			authInfo = data as AuthInfo;
		} catch (err) {
			authAvailable = false;
			authProblem = (err as Error).message;
		}
	}

	async function loadVault(): Promise<void> {
		try {
			const data = await api(`/players/${encodeURIComponent(ref)}/vault`);

			if (data.available === false) {
				vaultAvailable = false;
				vaultProblem = data.error ?? 'LunaVault is unavailable';
				return;
			}

			vaultAvailable = true;
			vaultInfo = data as VaultInfo;
		} catch (err) {
			vaultAvailable = false;
			vaultProblem = (err as Error).message;
		}
	}

	async function loadVaultTransactions(reset: boolean): Promise<void> {
		const wanted = reset ? 0 : vaultPage + 1;
		const data = await api(
			`/players/${encodeURIComponent(ref)}/vault/transactions?page=${wanted}&pageSize=${VAULT_PAGE}`
		);

		if (data.available === false) {
			return;
		}

		vaultTotal = data.totalCount ?? 0;
		vaultPage = data.page ?? 0;
		vaultTx = reset ? (data.entries ?? []) : [...vaultTx, ...(data.entries ?? [])];
	}

	async function loadSessions(reset: boolean): Promise<void> {
		const offset = reset ? 0 : sessions.length;
		const data = await api(`/players/${encodeURIComponent(ref)}/sessions?limit=${LOG_PAGE}&offset=${offset}`);

		if (data.available === false) {
			return;
		}

		sessionsTotal = data.total ?? 0;
		sessions = reset ? (data.sessions ?? []) : [...sessions, ...(data.sessions ?? [])];
	}

	async function loadChat(reset: boolean): Promise<void> {
		const offset = reset ? 0 : chat.length;
		const type = chatType ? `&type=${chatType}` : '';
		const data = await api(`/players/${encodeURIComponent(ref)}/chat?limit=${LOG_PAGE}&offset=${offset}${type}`);

		if (data.available === false) {
			return;
		}

		chatTotal = data.total ?? 0;
		chat = reset ? (data.entries ?? []) : [...chat, ...(data.entries ?? [])];
	}

	async function loadModeration(reset: boolean): Promise<void> {
		const offset = reset ? 0 : moderation.length;
		const data = await api(`/players/${encodeURIComponent(ref)}/moderation?limit=${LOG_PAGE}&offset=${offset}`);

		if (data.available === false) {
			return;
		}

		moderationTotal = data.total ?? 0;
		moderation = reset ? (data.entries ?? []) : [...moderation, ...(data.entries ?? [])];
	}

	async function loadPermissions(): Promise<void> {
		permsLoaded = true;

		const [user, groups] = await Promise.all([
			api(`/players/${encodeURIComponent(ref)}/permissions`),
			api('/permissions/groups')
		]);

		if (user.available === false) {
			permsAvailable = false;
			permsProblem = user.error ?? 'LuckPerms is unavailable';
			return;
		}

		permsAvailable = true;
		primaryGroup = user.primaryGroup ?? '';
		userGroups = user.groups ?? [];
		userNodes = user.nodes ?? [];
		allGroups = groups.available === false ? [] : (groups.groups ?? []);

		if (!groupPick && allGroups.length > 0) {
			groupPick = allGroups[0]?.name ?? '';
		}
	}

	/** Fetch the data a tab renders, the first time it is opened. */
	async function loadTab(id: string, force = false): Promise<void> {
		if (id === 'sessions' && (force || sessions.length === 0)) {
			await loadSessions(true);
		} else if (id === 'chat' && (force || chat.length === 0)) {
			await loadChat(true);
		} else if (id === 'moderation' && (force || moderation.length === 0)) {
			await loadModeration(true);
		} else if (id === 'permissions' && (force || !permsLoaded)) {
			await loadPermissions();
		} else if (id === 'economy' && (force || vaultTx.length === 0)) {
			await loadVaultTransactions(true);
		}
	}

	$effect(() => {
		void loadTab(tab);
	});

	onMount(() => {
		void refresh();

		void api('/instances').then((data) => {
			instances = data.instances
				.filter((inst: any) => !traitsOf(inst.software).isProxy && inst.name !== 'proxy')
				.map((inst: any) => inst.name)
				.sort();
			servers = [
				...instances,
				...data.externals.map((inst: any) => inst.name)
			].sort();
			transferTo = servers[0] ?? '';
		});
	});

	const identityCells: InfoCell[] = $derived(
		detail
			? [
					{ id: 'uuid', label: t('web.playerDetail.uuid'), value: detail.uuid, style: 'mono', copyable: true },
					{
						label: t('web.playerDetail.accountType'),
						value: detail.onlineMode ? 'Premium (Mojang)' : 'Offline / proxy-authenticated'
					},
					{ label: t('web.playerDetail.firstSeen'), value: detail.firstSeenAtEpochMillis ? fmtDateTime(detail.firstSeenAtEpochMillis) : '–' },
					{
						label: t('web.playerDetail.lastSeen'),
						value: detail.online ? 'online now' : detail.lastSeenAtEpochMillis ? fmtDateTime(detail.lastSeenAtEpochMillis) : '–'
					},
					{
						label: detail.online ? 'Current backend' : 'Last backend',
						value: (detail.online ? detail.server : detail.lastServer) || '–',
						...(detail.online || detail.lastServer
							? { href: `/instances/${detail.online ? detail.server : detail.lastServer}` }
							: {})
					},
					{ label: t('web.playerDetail.lastAddress'), value: detail.lastAddress || '–', style: 'mono' },
					{ label: t('web.playerDetail.clientVersion'), value: detail.lastClientVersion || '–' },
					{
						label: t('web.playerDetail.permissionGroup'),
						value: detail.permissions.available
							? detail.permissions.primaryGroupDisplay || detail.permissions.primaryGroup || '–'
							: 'LuckPerms unavailable',
						// the display name is what LuckPerms shows; the group's own name
						// is what its detail screen is keyed by
						...(detail.permissions.available && detail.permissions.primaryGroup
							? { href: `/permissions/${encodeURIComponent(detail.permissions.primaryGroup)}` }
							: {})
					}
				]
			: []
	);

	/** Administration verbs in the header; live ones first, then the lists. */
	function headerActions(): ContextMenuItem[] {
		const offline = !detail?.online;

		return [
			{
				label: t('web.playerDetail.sendAMessage'),
				icon: 'paperPlane',
				disabled: offline,
				hint: offline ? 'player is offline' : undefined,
				action: () => {
					messageOpen = true;
				}
			},
			{
				label: t('web.playerDetail.moveToAnotherBackend'),
				icon: 'rightLeft',
				disabled: offline,
				hint: offline ? 'player is offline' : undefined,
				action: () => {
					transferOpen = true;
				}
			},
			{
				label: t('web.playerDetail.disconnectFromTheNetwork'),
				icon: 'userSlash',
				color: 'danger',
				disabled: offline,
				hint: offline ? 'player is offline' : undefined,
				action: () => {
					kickOpen = true;
				}
			},
			{ separator: true },
			{ label: t('web.playerDetail.addToWhitelist'), icon: 'userTick', action: () => openModerate('whitelist-add') },
			{ label: t('web.playerDetail.removeFromWhitelist'), icon: 'userMinus', action: () => openModerate('whitelist-remove') },
			{ label: t('web.playerDetail.grantOperator'), icon: 'userCog', action: () => openModerate('op') },
			{ label: t('web.playerDetail.revokeOperator'), icon: 'userLock', action: () => openModerate('deop') },
			{ separator: true },
			{
				label: t('web.playerDetail.changeSkin'),
				icon: 'wandMagicSparkles',
				action: () => {
					skinMode = 'upload';
					skinFile = null;
					skinUrl = '';
					skinName = '';
					skinVariant = '';
					skinOpen = true;
				}
			},
			{ separator: true },
			...passwordActions(),
			{ separator: true },
			{ label: t('web.playerDetail.ban'), icon: 'gavel', color: 'danger', action: () => openModerate('ban') },
			{ label: t('web.playerDetail.pardon'), icon: 'handshake', action: () => openModerate('pardon') },
			{ separator: true },
			{
				label: t('web.playerDetail.recordAModerationNote'),
				icon: 'note',
				action: () => {
					noteOpen = true;
				}
			}
		];
	}

	/**
	 * The password verbs. Each unavailable one keeps its place and says why -
	 * "unlock" on an account that is not locked is information, not clutter.
	 */
	function passwordActions(): ContextMenuItem[] {
		const gone = !authAvailable;
		const reason = gone ? 'luna-auth is unavailable' : undefined;

		return [
			{
				label: t('web.playerDetail.issueATemporaryPassword'),
				icon: 'key',
				disabled: gone,
				hint: reason,
				action: () => {
					tempPassword = '';
					tempMinutes = String(DEFAULT_TEMP_MINUTES);
					tempOpen = true;
				}
			},
			{
				label: t('web.playerDetail.resetPassword'),
				icon: 'rotate',
				color: 'danger',
				disabled: gone || !authInfo?.registered,
				hint: reason ?? (authInfo?.registered ? undefined : 'the player has no password'),
				action: () => {
					resetOpen = true;
				}
			},
			{
				label: t('web.playerDetail.unlockAccount'),
				icon: 'lockOpen',
				disabled: gone || !authInfo?.locked,
				hint: reason ?? (authInfo?.locked ? undefined : 'the account is not locked'),
				action: () => void doAuth('unlock', 'Unlocking account…', 'Account unlocked')
			},
			{
				label: t('web.playerDetail.endAuthenticatedSession'),
				icon: 'userLock',
				disabled: gone || !(authInfo?.authenticated || authInfo?.session.hasSession),
				hint: reason ?? (authInfo?.authenticated || authInfo?.session.hasSession ? undefined : 'no session to end'),
				action: () => void doAuth('logout', 'Ending session…', 'Session ended; the player must log in again')
			}
		];
	}

	const ACTION_LABELS: Record<string, string> = {
		'whitelist-add': 'Add to whitelist',
		'whitelist-remove': 'Remove from whitelist',
		op: 'Grant operator',
		deop: 'Revoke operator',
		ban: 'Ban',
		pardon: 'Pardon'
	};

	function openModerate(action: string): void {
		moderateAction = action;
		moderateInstances = [...instances];
		moderateReason = '';
		moderateOpen = true;
	}

	async function act(run: () => Promise<any>, pending: string, done: string): Promise<void> {
		const note = Notify.loading(pending);

		try {
			const result = await run();

			if (result?.ok === false) {
				throw new Error(result.error ?? 'the action failed');
			}

			note.set({ level: 'success', message: done, closeable: true });

			await refresh();
		} catch (err) {
			note.set({ level: 'error', message: pending, detail: (err as Error).message, closeable: true });
		}
	}

	async function doKick(): Promise<void> {
		kickOpen = false;

		await act(
			() => post('/luna/admin', { action: 'kick', player: detail?.uuid ?? detail?.username, reason: kickReason }),
			`Disconnecting ${detail?.username}…`,
			`${detail?.username} disconnected`
		);

		kickReason = '';
	}

	async function doMessage(): Promise<void> {
		const text = messageText.trim();

		messageOpen = false;

		if (!text) {
			return;
		}

		await act(
			() => post('/luna/admin', { action: 'message', player: detail?.uuid ?? detail?.username, message: text }),
			`Sending a message to ${detail?.username}…`,
			`Message delivered to ${detail?.username}`
		);

		messageText = '';
	}

	async function doTransfer(): Promise<void> {
		transferOpen = false;

		await act(
			() =>
				post('/luna/admin', {
					action: 'transfer',
					// resolve by profile id; two profiles can share the name
					player: detail?.uuid ?? detail?.username,
					server: transferTo
				}),
			`Moving ${detail?.username} to ${transferTo}…`,
			`${detail?.username} moved to ${transferTo}`
		);
	}

	async function doModerate(): Promise<void> {
		moderateOpen = false;

		const label = ACTION_LABELS[moderateAction] ?? moderateAction;

		let unconfirmed: string[] = [];

		await act(
			async () => {
				const result = await post('/players/moderate', {
					action: moderateAction,
					targets: [{ name: detail?.username, uuid: detail?.uuid }],
					instances: moderateInstances,
					reason: moderateReason
				});

				const outcomes: any[] = result.outcomes ?? [];
				const failed = outcomes.filter((outcome) => !outcome.ok);

				if (failed.length > 0) {
					throw new Error(failed.map((outcome: any) => `${outcome.instance}: ${outcome.error}`).join('; '));
				}

				unconfirmed = outcomes
					.filter((outcome) => outcome.verified === false)
					.map((outcome) => String(outcome.instance));

				return result;
			},
			`${label} ${detail?.username}…`,
			`${label} applied on ${moderateInstances.length} instance(s)`
		);

		if (unconfirmed.length > 0) {
			Notify.warning(t('web.players.someUnconfirmed', { label, count: unconfirmed.length }), {
				detail: unconfirmed.join(', '),
				closeable: true
			});
		}

		await loadModeration(true);
	}

	const skinModeValid = $derived.by(() => {
		if (skinMode === 'upload') {
			return skinFile !== null;
		}

		if (skinMode === 'url') {
			return /^https?:\/\/.+/.test(skinUrl.trim());
		}

		if (skinMode === 'name') {
			return /^[A-Za-z0-9_]{1,16}$/.test(skinName.trim());
		}

		return true;
	});

	async function doChangeSkin(): Promise<void> {
		skinBusy = true;

		const note = Notify.loading(
			skinMode === 'reset'
				? `Resetting ${detail?.username}'s skin…`
				: `Changing ${detail?.username}'s skin…`
		);

		try {
			const body: Record<string, unknown> = { mode: skinMode };

			if (skinMode === 'upload') {
				const { fileToBase64 } = await import('$lib/api');

				body.fileBase64 = await fileToBase64(skinFile!);
			} else if (skinMode === 'url') {
				body.url = skinUrl.trim();
			} else if (skinMode === 'name') {
				body.skin = skinName.trim();
			}

			if (skinVariant && (skinMode === 'upload' || skinMode === 'url')) {
				body.variant = skinVariant;
			}

			const result = await post(`/players/${encodeURIComponent(ref)}/skin`, body);

			if (result.ok === false) {
				throw new Error(result.error ?? 'the skin change was refused');
			}

			skinOpen = false;
			skinEpoch = Date.now();

			note.set({
				level: 'success',
				message:
					skinMode === 'reset'
						? `${detail?.username}'s skin reset; their own skin applies again`
						: `${detail?.username}'s skin changed${detail?.online ? ' and applied live' : '; it applies on their next login'}`,
				closeable: true
			});

			await refresh();
			await loadModeration(true);
		} catch (err) {
			note.set({
				level: 'error',
				message: t('web.playerDetail.skinChangeFailed'),
				detail: (err as Error).message,
				closeable: true
			});
		}

		skinBusy = false;
	}

	async function doNote(): Promise<void> {
		const text = noteText.trim();

		noteOpen = false;

		if (!text) {
			return;
		}

		await act(
			() => post(`/players/${encodeURIComponent(ref)}/moderation`, { action: 'note', reason: text }),
			'Recording note…',
			'Moderation note recorded'
		);

		noteText = '';
		await loadModeration(true);
	}

	// --------------------------------------------------------- account security

	/** Run a password verb that needs no dialog and carries no secret back. */
	async function doAuth(action: string, pending: string, done: string): Promise<void> {
		await act(() => post(`/players/${encodeURIComponent(ref)}/auth`, { action }), pending, done);

		await loadAuth();
	}

	async function doReset(): Promise<void> {
		resetOpen = false;

		await doAuth(
			'reset',
			`Resetting ${detail?.username}'s password…`,
			`Password cleared; ${detail?.username} registers a new one with /register`
		);

		await loadModeration(true);
	}

	/**
	 * Issue a temporary password. The plaintext only exists in this response, so
	 * it goes straight into a dialog for the operator to pass on; reloading the
	 * page cannot bring it back.
	 */
	async function doTemporary(): Promise<void> {
		tempBusy = true;

		const note = Notify.loading(t('web.playerDetail.issuingTempPassword', { name: detail?.username ?? '' }));

		try {
			const chosen = tempPassword.trim();
			const result = await post(`/players/${encodeURIComponent(ref)}/auth`, {
				action: 'temporary',
				expiresInMinutes: Number(tempMinutes),
				...(chosen ? { password: chosen } : {})
			});

			if (result.ok === false) {
				throw new Error(result.error ?? 'the proxy refused the change');
			}

			tempOpen = false;
			issuedPassword = result.data?.password ?? chosen;
			issuedOpen = true;

			note.set({
				level: 'success',
				message: t('web.playerDetail.tempPasswordIssued', { name: detail?.username ?? '' }),
				closeable: true
			});

			await loadAuth();
			await loadModeration(true);
		} catch (err) {
			note.set({
				level: 'error',
				message: t('web.playerDetail.couldNotIssueATemporary'),
				detail: (err as Error).message,
				closeable: true
			});
		}

		tempBusy = false;
	}

	const authCells: InfoCell[] = $derived(
		authInfo
			? [
					{
						label: t('web.playerDetail.password'),
						value: !authInfo.registered
							? 'None; not registered'
							: authInfo.temporaryPassword
								? `Temporary, expires ${fmtDateTime(authInfo.temporaryPasswordUntilEpochMillis)}`
								: 'Set by the player'
					},
					{ label: t('web.playerDetail.signedIn'), value: authInfo.authenticated ? 'Yes' : 'No' },
					{
						label: t('web.playerDetail.accountLock'),
						value: authInfo.locked
							? `Locked until ${fmtDateTime(authInfo.lockedUntilEpochMillis)}`
							: 'Not locked'
					},
					{ label: t('web.playerDetail.failedAttempts'), value: authInfo.failedAttempts },
					{
						label: t('web.playerDetail.lastLogin'),
						value: authInfo.lastLoginAtEpochMillis ? fmtDateTime(authInfo.lastLoginAtEpochMillis) : '–'
					},
					{ label: t('web.playerDetail.lastAddress'), value: authInfo.lastIp || '–', style: 'mono' },
					{
						label: t('web.playerDetail.registeredOn'),
						value: authInfo.createdAtEpochMillis ? fmtDateTime(authInfo.createdAtEpochMillis) : '–'
					},
					{
						label: t('web.playerDetail.resumableSession'),
						value: authInfo.session.hasSession
							? `Until ${fmtDateTime(authInfo.session.expiresAtEpochMillis)}`
							: 'None'
					}
				]
			: []
	);

	// ------------------------------------------------------------------ economy

	const vaultCells: InfoCell[] = $derived(
		vaultInfo
			? [
					{ label: t('web.playerDetail.balance'), value: vaultInfo.balanceFormatted },
					{
						label: t('web.playerDetail.leaderboardRank'),
						value: vaultInfo.rank ? `#${vaultInfo.rank} of ${vaultInfo.accountCount}` : '–'
					},
					{ label: t('web.playerDetail.transactions'), value: vaultInfo.summary.transactionCount },
					{ label: t('web.playerDetail.totalReceived'), value: vaultInfo.summary.receivedFormatted },
					{ label: t('web.playerDetail.totalSpent'), value: vaultInfo.summary.sentFormatted },
					{
						label: t('web.playerDetail.firstTransaction'),
						value: vaultInfo.summary.firstAtEpochMillis
							? fmtDateTime(vaultInfo.summary.firstAtEpochMillis)
							: '–'
					},
					{
						label: t('web.playerDetail.lastTransaction'),
						value: vaultInfo.summary.lastAtEpochMillis
							? fmtDateTime(vaultInfo.summary.lastAtEpochMillis)
							: '–'
					}
				]
			: []
	);

	const txCols: Column[] = $derived([
		{ id: 'time', label: t('web.playerDetail.time'), width: 180, sortable: true },
		{ id: 'direction', label: t('web.playerDetail.direction'), width: 120 },
		{ id: 'amount', label: t('web.playerDetail.amount'), width: 150, sortable: true },
		{ id: 'counterparty', label: t('web.playerDetail.counterparty'), minWidth: 160 },
		{ id: 'source', label: t('web.playerDetail.source'), width: 140 },
		{ id: 'details', label: t('web.playerDetail.details') }
	]);

	// ------------------------------------------------------------- permissions

	async function editGroups(action: 'add' | 'remove' | 'set', group: string): Promise<void> {
		await act(
			() => post(`/players/${encodeURIComponent(ref)}/permissions`, { op: 'group', action, group }),
			`Updating groups…`,
			`Group ${group} ${action === 'add' ? 'added' : action === 'remove' ? 'removed' : 'set as the only group'}`
		);

		await loadPermissions();
	}

	async function addNode(): Promise<void> {
		const key = nodeKey.trim();

		if (!key) {
			return;
		}

		await act(
			() =>
				post(`/players/${encodeURIComponent(ref)}/permissions`, {
					op: 'node',
					action: 'add',
					key,
					value: nodeGrant,
					...(nodeServer ? { contexts: { server: nodeServer } } : {})
				}),
			`Adding ${key}…`,
			`Node ${key} added`
		);

		nodeKey = '';
		await loadPermissions();
	}

	async function removeNode(node: PermNode): Promise<void> {
		const contexts: Record<string, string> = {};

		for (const pair of node.contexts) {
			contexts[pair.key] = pair.value;
		}

		await act(
			() =>
				post(`/players/${encodeURIComponent(ref)}/permissions`, {
					op: 'node',
					action: 'remove',
					key: node.key,
					contexts
				}),
			`Removing ${node.key}…`,
			`Node ${node.key} removed`
		);

		await loadPermissions();
	}

	function openNodeEditor(node: PermNode | null): void {
		nodeBeingEdited = node;
		nodeEditorOpen = true;
	}

	/** Apply the node editor's result to the user: an edit removes the original first. */
	async function saveUserNode(spec: NodeSpec): Promise<void> {
		const original = nodeBeingEdited;
		const userPath = `/players/${encodeURIComponent(ref)}/permissions`;

		await act(
			async () => {
				if (original) {
					const originalContexts: Record<string, string> = {};

					for (const pair of original.contexts) {
						originalContexts[pair.key] = pair.value;
					}

					await post(userPath, {
						op: 'node',
						action: 'remove',
						key: original.key,
						contexts: originalContexts
					});
				}

				return await post(userPath, {
					op: 'node',
					action: 'add',
					key: spec.key,
					value: spec.value,
					...(spec.expirySeconds > 0 ? { expirySeconds: spec.expirySeconds } : {}),
					...(Object.keys(spec.contexts).length > 0 ? { contexts: spec.contexts } : {})
				});
			},
			original ? `Saving ${spec.key}…` : `Adding ${spec.key}…`,
			original ? `Node ${spec.key} saved` : `Node ${spec.key} added`
		);

		await loadPermissions();
	}

	const sessionCols: Column[] = $derived([
		{ id: 'connected', label: t('web.playerDetail.connected'), sortable: true },
		{ id: 'server', label: t('web.playerDetail.backend'), sortable: true },
		{ id: 'duration', label: t('web.playerDetail.duration'), sortable: true },
		{ id: 'ended', label: t('web.playerDetail.disconnected') }
	]);

	const chatCols: Column[] = $derived([
		{ id: 'time', label: t('web.playerDetail.time'), width: 180, sortable: true },
		{ id: 'type', label: t('web.playerDetail.type'), width: 140 },
		{ id: 'server', label: t('web.playerDetail.backend'), width: 130 },
		{ id: 'content', label: t('web.playerDetail.content') }
	]);

	const modCols: Column[] = $derived([
		{ id: 'time', label: t('web.playerDetail.time'), width: 180, sortable: true },
		{ id: 'action', label: t('web.playerDetail.action'), width: 150 },
		{ id: 'actor', label: t('web.playerDetail.by'), width: 130 },
		{ id: 'server', label: t('web.playerDetail.where'), width: 140 },
		{ id: 'reason', label: t('web.playerDetail.reason') }
	]);

	const nodeCols: Column[] = $derived([
		{ id: 'key', label: t('web.playerDetail.node2'), minWidth: 240 },
		{ id: 'value', label: t('web.playerDetail.value'), width: 110 },
		{ id: 'type', label: t('web.playerDetail.type'), width: 130 },
		{ id: 'contexts', label: t('web.playerDetail.contexts') },
		{ id: 'expiry', label: t('web.playerDetail.expires') }
	]);

	function nodeActions(node: PermNode): ContextMenuItem[] {
		return [
			{
				label: t('web.playerDetail.editNode'),
				icon: 'pen',
				action: () => openNodeEditor(node)
			},
			{ separator: true },
			{
				label: t('web.playerDetail.removeNode'),
				icon: 'trash',
				color: 'danger',
				action: () => void removeNode(node)
			}
		];
	}
</script>

<svelte:head><title>{detail?.username ?? 'Player'} | Luna Console</title></svelte:head>

<PageHeader title={detail?.username ?? ref} info description={detail?.uuid ?? ''}>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="player-detail" />
		<Dropdown label={t('web.playerDetail.actions')} disabled={!detail} menu={headerActions()} />
	{/snippet}
</PageHeader>

{#if notFound}
	<Flash kind="error">
		<b>{t('web.playerDetail.unknownPlayer')}</b> {t('web.playerDetail.theDirectoryHasNo')} <code>{ref}</code>. Profiles are
		{t('web.playerDetail.createdOnAPlayer')}
	</Flash>
{:else if !available}
	<Flash kind="warning">
		<b>{t('web.playerDetail.lunacoreIsNotAnswering')}</b> {problem}. The proxy may be stopped, or running a build
		{t('web.playerDetail.withoutThePlayerDirectory')}
	</Flash>
{:else if detail}
	<OverviewBar title={t('web.playerDetail.playerOverview')}>
		<OverviewCell label={t('web.playerDetail.status')}>
			{#if detail.online}
				<StatusBadge state="ok" label="Online; {detail.server}" />
			{:else}
				<StatusBadge state="stopped" label={t('web.playerDetail.offline')} />
			{/if}
		</OverviewCell>
		<OverviewCell label={t('web.playerDetail.balance')}>
			{#if vaultAvailable && vaultInfo}
				<span class="balance">{vaultInfo.balanceFormatted}</span>
			{:else}
				<span class="dim">–</span>
			{/if}
		</OverviewCell>
		<OverviewCell label={t('web.playerDetail.totalPlaytime')}>
			{detail.totalPlayMillis ? fmtDuration(detail.totalPlayMillis) : '–'}
		</OverviewCell>
		<OverviewCell label={t('web.playerDetail.sessions')}>
			{detail.sessionCount}
		</OverviewCell>
		<OverviewCell label={t('web.playerDetail.chatMessages')}>
			{detail.chatTotal}
		</OverviewCell>
		<OverviewCell label={t('web.playerDetail.commands')}>
			{detail.commandTotal}
		</OverviewCell>
		<OverviewCell label={t('web.playerDetail.moderationEntries')}>
			{detail.moderationTotal}
		</OverviewCell>
	</OverviewBar>

	<div class="columns">
		<Panel title={t('web.playerDetail.skin')} description={t('web.playerDetail.pickAPoseDragThe')}>
			<div class="skin">
				<PlayerSkin3D player={detail.uuid} bust={skinEpoch} />
			</div>
		</Panel>

		<Panel title={t('web.playerDetail.identity')}>
			<InfoGrid cells={identityCells} columns={[2, 2, 1]} />
		</Panel>
	</div>

	<Tabs
		tabs={[
			{ id: 'overview', label: t('web.playerDetail.overview') },
			{ id: 'account', label: t('web.playerDetail.account') },
			{ id: 'economy', label: t('web.playerDetail.economy') },
			{ id: 'sessions', label: t('web.playerDetail.playHistory') },
			{ id: 'chat', label: t('web.playerDetail.chatCommands') },
			{ id: 'permissions', label: t('web.playerDetail.permissions') },
			{ id: 'moderation', label: t('web.playerDetail.moderation') }
		]}
		bind:active={tab}
	/>

	<div class="tabbody">
		{#if tab === 'overview'}
			<Panel
				title={t('web.playerDetail.playtimeByBackend')}
				description={t('web.playerDetail.closedPlaySessionsOnlyThe')}
			>
				{#if detail.playtimeByServer.length > 0}
					{@const maxPlay = Math.max(...detail.playtimeByServer.map((entry) => entry.playMillis))}
					<div class="playtimes">
						{#each detail.playtimeByServer as entry}
							<div class="playrow">
								<a class="server" href="/instances/{entry.server}">{entry.server || 'unknown'}</a>
								<ProgressBar
									compact
									value={entry.playMillis}
									max={maxPlay}
									color="success"
									right="{fmtDuration(entry.playMillis)} · {entry.stints} session(s)"
								/>
							</div>
						{/each}
					</div>
				{:else}
					<p class="dim">{t('web.playerDetail.noCompletedPlaySessions')}</p>
				{/if}
			</Panel>
		{:else if tab === 'account'}
			{#if !authAvailable}
				<Flash kind="warning">
					<b>{t('web.playerDetail.lunaAuthIsNot')}</b> {authProblem}. Password administration needs the
					{t('web.playerDetail.pluginRunningOnThe')}
				</Flash>
			{:else if authInfo}
				{#if authInfo.temporaryPasswordExpired}
					<Flash kind="warning">
						This player's temporary password has <b>{t('web.playerDetail.expired')}</b>. Their account has no password
						{t('web.playerDetail.untilTheyRegisterA')}
					</Flash>
				{:else if authInfo.temporaryPassword}
					<Flash kind="info">
						This player is using a <b>{t('web.playerDetail.temporaryPassword')}</b>, issued by an administrator. It stops
						working on {fmtDateTime(authInfo.temporaryPasswordUntilEpochMillis)}, after which the
						{t('web.playerDetail.accountHasNoPassword')}
					</Flash>
				{:else if !authInfo.registered}
					<Flash kind="info">
						{t('web.playerDetail.thisPlayerHasNever')}
						<code>{t('web.playerDetail.register')}</code>, or you can issue a temporary one for them.
					</Flash>
				{/if}

				<Panel
					title={t('web.playerDetail.authentication')}
					description={t('web.playerDetail.heldByLunaAuthOn')}
				>
					<InfoGrid cells={authCells} columns={[4, 2, 1]} />
				</Panel>
			{/if}
		{:else if tab === 'economy'}
			{#if !vaultAvailable}
				<Flash kind="warning">
					<b>{t('web.playerDetail.lunavaultIsNotAnswering')}</b> {vaultProblem}. Balances and transactions come from
					{t('web.playerDetail.thePluginOnThe')}
				</Flash>
			{:else}
				{#if vaultInfo && !vaultInfo.hasAccount}
					<Flash kind="info">
						{t('web.playerDetail.thisPlayerHasNo')}
					</Flash>
				{/if}

				<Panel
					title={t('web.playerDetail.wallet')}
					description={t('web.playerDetail.heldByLunavaultOnThe')}
				>
					<InfoGrid cells={vaultCells} columns={[4, 2, 1]} />
				</Panel>

				<Panel flush>
					<ResourceTable
						tableId="player-transactions"
						columns={txCols}
						rows={vaultTx}
						getId={(entry) => entry.id}
						searchValue={(entry) => `${entry.counterpartyName} ${entry.source} ${entry.details}`}
						searchPlaceholder={t('web.playerDetail.findInTransactions')}
						noun={t('web.playerDetail.transaction')}
						pageSize={25}
						sortValue={(entry, col) =>
							col === 'time'
								? entry.atEpochMillis
								: col === 'amount'
									? entry.amountMinor
									: null}
						emptyTitle={t('web.playerDetail.noTransactions')}
						emptyText={t('web.playerDetail.everyPaymentRewardAndAdmin')}
					>
						{#snippet cell(entry, col)}
							{#if col === 'time'}
								<span class="mono dim">{fmtDateTime(entry.atEpochMillis)}</span>
							{:else if col === 'direction'}
								<StatusBadge
									state={entry.direction === 'in'
										? 'passed'
										: entry.direction === 'out'
											? 'warning'
											: 'stopped'}
									label={entry.direction === 'in'
										? 'received'
										: entry.direction === 'out'
											? 'paid'
											: 'adjusted'}
								/>
							{:else if col === 'amount'}
								<span class="amount {entry.direction}">
									{entry.direction === 'in' ? '+' : entry.direction === 'out' ? '−' : '±'}{entry
										.amountFormatted}
								</span>
							{:else if col === 'counterparty'}
								{#if entry.system}
									<span class="dim">{t('web.playerDetail.system')}</span>
								{:else if entry.counterpartyUuid}
									<PlayerName
										player={entry.counterpartyUuid}
										name={entry.counterpartyName}
									/>
								{:else}
									{entry.counterpartyName}
								{/if}
							{:else if col === 'source'}
								<span class="mono">{entry.source || '–'}</span>
							{:else if col === 'details'}
								{entry.details || '–'}
							{/if}
						{/snippet}
					</ResourceTable>
					{#if vaultTx.length < vaultTotal}
						<div class="more">
							<Btn onclick={() => void loadVaultTransactions(false)}>
								Load more ({vaultTx.length}/{vaultTotal})
							</Btn>
						</div>
					{/if}
				</Panel>
			{/if}
		{:else if tab === 'sessions'}
			<Panel flush>
				<ResourceTable
					tableId="player-sessions"
					columns={sessionCols}
					rows={sessions}
					getId={(session) => String(session.id)}
					searchValue={(session) => session.server}
					searchPlaceholder={t('web.playerDetail.findBackend')}
					noun={t('web.playerDetail.session')}
					pageSize={25}
					sortValue={(session, col) =>
						col === 'connected'
							? session.connectedAtEpochMillis
							: col === 'server'
								? session.server
								: col === 'duration'
									? session.durationMillis
									: null}
					emptyTitle={t('web.playerDetail.noSessionsRecorded')}
					emptyText={t('web.playerDetail.playSessionsAreRecordedFrom')}
				>
					{#snippet cell(session, col)}
						{#if col === 'connected'}
							{fmtDateTime(session.connectedAtEpochMillis)}
						{:else if col === 'server'}
							<a href="/instances/{session.server}">{session.server}</a>
						{:else if col === 'duration'}
							{#if session.open}
								<StatusBadge state="ok" label={t('web.playerDetail.ongoing')} />
							{:else}
								{fmtDuration(session.durationMillis)}
							{/if}
						{:else if col === 'ended'}
							{session.open ? '–' : fmtDateTime(session.disconnectedAtEpochMillis)}
						{/if}
					{/snippet}
				</ResourceTable>
				{#if sessions.length < sessionsTotal}
					<div class="more">
						<Btn onclick={() => void loadSessions(false)}>
							Load more ({sessions.length}/{sessionsTotal})
						</Btn>
					</div>
				{/if}
			</Panel>
		{:else if tab === 'chat'}
			<Panel flush>
				<ResourceTable
					tableId="player-chat"
					columns={chatCols}
					rows={chat}
					getId={(entry) => String(entry.id)}
					searchValue={(entry) => `${entry.content} ${entry.server} ${entry.type}`}
					searchPlaceholder={t('web.playerDetail.findInMessages')}
					noun={t('web.playerDetail.entry')}
					pageSize={50}
					sortValue={(entry, col) => (col === 'time' ? entry.atEpochMillis : null)}
					emptyTitle={t('web.playerDetail.nothingRecorded')}
					emptyText={t('web.playerDetail.chatAndCommandsAreRecorded')}
				>
					{#snippet toolbar()}
						<Select
							label={t('web.playerDetail.filterType')}
							bind:value={chatType}
							width="14rem"
							options={[
								{ value: '', label: t('web.playerDetail.chatAndCommands') },
								{ value: 'chat', label: t('web.playerDetail.chatOnly') },
								{ value: 'command', label: t('web.playerDetail.commandsOnly') }
							]}
							onchange={() => void loadChat(true)}
						/>
					{/snippet}
					{#snippet cell(entry, col)}
						{#if col === 'time'}
							<span class="mono dim">{fmtDateTime(entry.atEpochMillis)}</span>
						{:else if col === 'type'}
							<StatusBadge
								state={entry.type === 'command' ? 'warning' : 'passed'}
								label={entry.type}
							/>
						{:else if col === 'server'}
							{entry.server || '–'}
						{:else if col === 'content'}
							<span class="mono content">{entry.type === 'command' ? '/' : ''}{entry.content}</span>
						{/if}
					{/snippet}
				</ResourceTable>
				{#if chat.length < chatTotal}
					<div class="more">
						<Btn onclick={() => void loadChat(false)}>Load more ({chat.length}/{chatTotal})</Btn>
					</div>
				{/if}
			</Panel>
		{:else if tab === 'permissions'}
			{#if !permsAvailable}
				<Flash kind="warning">
					<b>{t('web.playerDetail.luckpermsIsNotAnswering')}</b> {permsProblem}
				</Flash>
			{:else}
				<Panel
					title={t('web.playerDetail.groups')}
					description={t('web.playerDetail.primaryGroupIsTheOne')}
				>
					<div class="groups">
						{#each userGroups as group}
							<span class="group" class:primary={group === primaryGroup}>
								<a href="/permissions/{encodeURIComponent(group)}">{group}</a>
								{#if group === primaryGroup}
									<span class="tagnote">{t('web.playerDetail.primary')}</span>
								{/if}
								<button
									class="chipbtn"
									title="Remove from {group}"
									onclick={() => void editGroups('remove', group)}
								>×</button>
							</span>
						{:else}
							<span class="dim">{t('web.playerDetail.noGroupMembershipsLuckperms')}</span>
						{/each}
					</div>
					<div class="groupadd">
						<Select
							bind:value={groupPick}
							options={allGroups.map((group) => ({ value: group.name, label: group.name }))}
							width="14rem"
						/>
						<Btn icon="plus" onclick={() => void editGroups('add', groupPick)} disabled={!groupPick}>
							{t('web.playerDetail.addGroup')}
						</Btn>
						<Btn onclick={() => void editGroups('set', groupPick)} disabled={!groupPick}>
							{t('web.playerDetail.setAsOnlyGroup')}
						</Btn>
					</div>
				</Panel>
				<div class="gap"></div>
				<Panel flush title={t('web.playerDetail.permissionNodes')} count={userNodes.length}>
					<div class="nodeadd">
						<input class="input" bind:value={nodeKey} placeholder={t('web.playerDetail.permissionNodeKey')} />
						<label class="grant">
							<Toggle checked={nodeGrant} onchange={(checked) => (nodeGrant = checked)} />
							<span>{nodeGrant ? 'granted' : 'negated'}</span>
						</label>
						<Select
							bind:value={nodeServer}
							options={[
								{ value: '', label: t('web.playerDetail.everyServer') },
								...servers.map((name) => ({ value: name, label: `server=${name}` }))
							]}
							width="13rem"
						/>
						<Btn variant="primary" icon="plus" onclick={addNode} disabled={!nodeKey.trim()}>{t('web.playerDetail.addNode')}</Btn>
					</div>
					<ResourceTable
						tableId="player-nodes"
						columns={nodeCols}
						rows={userNodes}
						getId={(node) => `${node.key}|${node.contexts.map((pair) => `${pair.key}=${pair.value}`).join(',')}`}
						searchValue={(node) => node.key}
						searchPlaceholder={t('web.playerDetail.findNode')}
						noun={t('web.playerDetail.node')}
						pageSize={25}
						rowActions={nodeActions}
						rowLabel={(node) => node.key}
						emptyTitle={t('web.playerDetail.noNodesOnThisUser')}
						emptyText={t('web.playerDetail.directNodesOnlyPermissionsInherited')}
					>
						{#snippet cell(node, col)}
							{#if col === 'key'}
								<span class="mono">{node.key}</span>
							{:else if col === 'value'}
								<StatusBadge state={node.value ? 'passed' : 'failed'} label={node.value ? 'true' : 'false'} />
							{:else if col === 'type'}
								<span class="dim">{node.type}</span>
							{:else if col === 'contexts'}
								{#if node.contexts.length > 0}
									<span class="mono dim">
										{node.contexts.map((pair) => `${pair.key}=${pair.value}`).join(', ')}
									</span>
								{:else}
									<span class="dim">{t('web.playerDetail.global')}</span>
								{/if}
							{:else if col === 'expiry'}
								{node.expiryEpochMillis ? fmtDateTime(node.expiryEpochMillis) : 'never'}
							{/if}
						{/snippet}
					</ResourceTable>
				</Panel>
			{/if}
		{:else if tab === 'moderation'}
			<Panel flush>
				<ResourceTable
					tableId="player-moderation"
					columns={modCols}
					rows={moderation}
					getId={(entry) => String(entry.id)}
					searchValue={(entry) => `${entry.action} ${entry.actor} ${entry.reason} ${entry.server}`}
					searchPlaceholder={t('web.playerDetail.findEntry')}
					noun={t('web.playerDetail.entry')}
					pageSize={25}
					sortValue={(entry, col) => (col === 'time' ? entry.atEpochMillis : null)}
					emptyTitle={t('web.playerDetail.aCleanRecord')}
					emptyText={t('web.playerDetail.kicksBansWhitelistAndOperator')}
				>
					{#snippet cell(entry, col)}
						{#if col === 'time'}
							<span class="mono dim">{fmtDateTime(entry.atEpochMillis)}</span>
						{:else if col === 'action'}
							<StatusBadge
								state={['ban', 'kick', 'ban-ip', 'bans-add'].includes(entry.action) ? 'failed' : 'passed'}
								label={entry.action}
							/>
						{:else if col === 'actor'}
							{entry.actor || '–'}
						{:else if col === 'server'}
							{entry.server || 'network'}
						{:else if col === 'reason'}
							{entry.reason || entry.details || '–'}
						{/if}
					{/snippet}
				</ResourceTable>
				{#if moderation.length < moderationTotal}
					<div class="more">
						<Btn onclick={() => void loadModeration(false)}>
							Load more ({moderation.length}/{moderationTotal})
						</Btn>
					</div>
				{/if}
			</Panel>
		{/if}
	</div>
{/if}

<Modal title="Disconnect {detail?.username ?? 'player'}" bind:open={kickOpen}>
	<p>{t('web.playerDetail.theyAreRemovedFrom')}</p>
	<label class="field">
		<span class="lbl">{t('web.playerDetail.reasonShownToThe')}</span>
		<input class="input" bind:value={kickReason} placeholder={t('web.playerDetail.eGRestartingTheLobby')} />
	</label>
	{#snippet footer()}
		<Btn onclick={() => (kickOpen = false)}>{t('web.playerDetail.cancel')}</Btn>
		<Btn variant="danger" onclick={doKick}>{t('web.playerDetail.disconnect')}</Btn>
	{/snippet}
</Modal>

<Modal title="Message {detail?.username ?? 'player'}" bind:open={messageOpen}>
	<label class="field">
		<span class="lbl">{t('web.playerDetail.message')}</span>
		<input class="input" bind:value={messageText} placeholder={t('web.playerDetail.typeAMessage')} />
	</label>
	{#snippet footer()}
		<Btn onclick={() => (messageOpen = false)}>{t('web.playerDetail.cancel')}</Btn>
		<Btn variant="primary" disabled={!messageText.trim()} onclick={doMessage}>{t('web.playerDetail.send')}</Btn>
	{/snippet}
</Modal>

<Modal title="Move {detail?.username ?? 'player'}" bind:open={transferOpen}>
	<div class="field">
		<span class="lbl">{t('web.playerDetail.destinationBackend')}</span>
		<Select
			bind:value={transferTo}
			width="100%"
			options={servers
				.filter((name) => name !== detail?.server)
				.map((name) => ({ value: name, label: name }))}
		/>
	</div>
	{#snippet footer()}
		<Btn onclick={() => (transferOpen = false)}>{t('web.playerDetail.cancel')}</Btn>
		<Btn variant="primary" disabled={!transferTo} onclick={doTransfer}>{t('web.playerDetail.move')}</Btn>
	{/snippet}
</Modal>

<Modal title="{ACTION_LABELS[moderateAction] ?? moderateAction}: {detail?.username ?? ref}" bind:open={moderateOpen}>
	<div class="field">
		<span class="lbl">{t('web.playerDetail.instances')}</span>
		<span class="hint">{t('web.playerDetail.theChangeIsApplied')}</span>
		<MultiSelect
			bind:value={moderateInstances}
			width="100%"
			options={instances.map((name) => ({ value: name, label: name }))}
		/>
	</div>
	{#if moderateAction === 'ban'}
		<label class="field">
			<span class="lbl">{t('web.playerDetail.reason')}</span>
			<span class="hint">{t('web.playerDetail.recordedInTheModeration')}</span>
			<input class="input" bind:value={moderateReason} placeholder={t('web.playerDetail.eGGriefingOnSurvival')} />
		</label>
	{/if}
	{#snippet footer()}
		<Btn onclick={() => (moderateOpen = false)}>{t('web.playerDetail.cancel')}</Btn>
		<Btn
			variant={moderateAction === 'ban' ? 'danger' : 'primary'}
			disabled={moderateInstances.length === 0}
			onclick={doModerate}
		>
			{ACTION_LABELS[moderateAction] ?? 'Apply'}
		</Btn>
	{/snippet}
</Modal>

<NodeEditorModal
	bind:open={nodeEditorOpen}
	node={nodeBeingEdited}
	{servers}
	onsubmit={(spec) => void saveUserNode(spec)}
/>

<Modal title="Change {detail?.username ?? 'player'}'s skin" bind:open={skinOpen}>
	<div class="field">
		<span class="lbl">{t('web.playerDetail.source')}</span>
		<Select
			bind:value={skinMode}
			width="100%"
			options={[
				{ value: 'upload', label: t('web.playerDetail.uploadASkinFilePng') },
				{ value: 'url', label: t('web.playerDetail.imageUrl') },
				{ value: 'name', label: t('web.playerDetail.mirrorAMojangAccount') },
				{ value: 'reset', label: t('web.playerDetail.resetBackToTheirOwn') }
			]}
		/>
	</div>

	{#if skinMode === 'upload'}
		<div class="field">
			<span class="lbl">{t('web.playerDetail.skinFile')}</span>
			<span class="hint">
				{t('web.playerDetail.a6464Or')}
			</span>
			<FileDrop bind:file={skinFile} accept=".png" hint={t('web.playerDetail.dropASkinPngHere')} />
		</div>
	{:else if skinMode === 'url'}
		<label class="field">
			<span class="lbl">{t('web.playerDetail.imageUrl')}</span>
			<span class="hint">{t('web.playerDetail.mustBePubliclyReachable')}</span>
			<input class="input mono" bind:value={skinUrl} placeholder={t('web.playerDetail.httpsSkinPng')} />
		</label>
	{:else if skinMode === 'name'}
		<label class="field">
			<span class="lbl">{t('web.playerDetail.mojangAccount')}</span>
			<span class="hint">{t('web.playerDetail.thePlayerGetsThis')}</span>
			<input class="input" bind:value={skinName} placeholder={t('web.playerDetail.eGNotch')} />
		</label>
	{:else}
		<p>
			{t('web.playerDetail.skinsrestorerForgetsTheStored')}
		</p>
	{/if}

	{#if skinMode === 'upload' || skinMode === 'url'}
		<div class="field">
			<span class="lbl">{t('web.playerDetail.armModel')}</span>
			<Select
				bind:value={skinVariant}
				width="100%"
				options={[
					{ value: '', label: t('web.playerDetail.detectAutomatically') },
					{ value: 'classic', label: t('web.playerDetail.classic4PxArms') },
					{ value: 'slim', label: t('web.playerDetail.slim3PxArms') }
				]}
			/>
		</div>
	{/if}

	{#snippet footer()}
		<Btn onclick={() => (skinOpen = false)}>{t('web.playerDetail.cancel')}</Btn>
		<Btn
			variant={skinMode === 'reset' ? 'danger' : 'primary'}
			disabled={!skinModeValid || skinBusy}
			loading={skinBusy}
			onclick={doChangeSkin}
		>
			{skinMode === 'reset' ? 'Reset skin' : 'Change skin'}
		</Btn>
	{/snippet}
</Modal>

<Modal title="Reset {detail?.username ?? 'player'}'s password" bind:open={resetOpen}>
	<p>
		The password on file is cleared. {detail?.username} keeps their profile, playtime and
		permissions, but cannot log in until they set a new password with <code>{t('web.playerDetail.register')}</code>.
	</p>
	<p class="dim">
		{t('web.playerDetail.ifTheyNeedTo')}
	</p>
	{#snippet footer()}
		<Btn onclick={() => (resetOpen = false)}>{t('web.playerDetail.cancel')}</Btn>
		<Btn variant="danger" onclick={doReset}>{t('web.playerDetail.resetPassword')}</Btn>
	{/snippet}
</Modal>

<Modal title="Temporary password for {detail?.username ?? 'player'}" bind:open={tempOpen}>
	<label class="field">
		<span class="lbl">{t('web.playerDetail.password')}</span>
		<span class="hint">
			{t('web.playerDetail.leaveEmptyAndThe')}
		</span>
		<input class="input mono" bind:value={tempPassword} placeholder={t('web.playerDetail.generateOneForMe')} />
	</label>

	<div class="field">
		<span class="lbl">{t('web.playerDetail.validFor')}</span>
		<span class="hint">
			{t('web.playerDetail.whenItExpiresThe')}
		</span>
		<Select bind:value={tempMinutes} width="100%" options={TEMP_LIFETIMES} />
	</div>

	{#if authInfo?.online}
		<p class="dim">
			{detail?.username} is online and will be disconnected, so the new password applies on their
			{t('web.playerDetail.nextLogin')}
		</p>
	{/if}

	{#snippet footer()}
		<Btn onclick={() => (tempOpen = false)}>{t('web.playerDetail.cancel')}</Btn>
		<Btn
			variant="primary"
			disabled={tempBusy || (tempPassword.trim().length > 0 && tempPassword.trim().length < 6)}
			loading={tempBusy}
			onclick={doTemporary}
		>
			{t('web.playerDetail.issuePassword')}
		</Btn>
	{/snippet}
</Modal>

<Modal title={t('web.playerDetail.temporaryPasswordIssued')} bind:open={issuedOpen}>
	<p>
		Give this to {detail?.username}. Only its hash is stored, so this is the one and only time it
		{t('web.playerDetail.canBeReadReopening')}
	</p>
	<div class="issued">
		<code>{issuedPassword}</code>
		<Btn icon="copy" onclick={() => void copyText(issuedPassword)}>{t('web.playerDetail.copy')}</Btn>
	</div>
	{#snippet footer()}
		<Btn variant="primary" onclick={() => (issuedOpen = false)}>{t('web.playerDetail.done')}</Btn>
	{/snippet}
</Modal>

<Modal title={t('web.playerDetail.recordAModerationNote')} bind:open={noteOpen}>
	<label class="field">
		<span class="lbl">{t('web.playerDetail.note')}</span>
		<span class="hint">{t('web.playerDetail.storedInThePlayer')}</span>
		<input class="input" bind:value={noteText} placeholder={t('web.playerDetail.eGWarnedAboutChat')} />
	</label>
	{#snippet footer()}
		<Btn onclick={() => (noteOpen = false)}>{t('web.playerDetail.cancel')}</Btn>
		<Btn variant="primary" disabled={!noteText.trim()} onclick={doNote}>{t('web.playerDetail.record')}</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.columns {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 1rem;
		margin: 1rem 0;
		align-items: stretch;

		@include below($bp-medium) {
			grid-template-columns: 1fr;
		}
	}

	.skin {
		display: flex;
		justify-content: center;
		padding: 0.5rem 1.5rem;
	}

	.tabbody {
		margin-top: 1rem;
	}

	// the one moment the password is readable, so it is given the room to be read
	.issued {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-top: 1rem;

		code {
			flex: 1;
			background: var(--bg-terminal);
			border-radius: 0.375rem;
			padding: 0.75rem 1rem;
			font-family: var(--font-mono);
			font-size: 1.25rem;
			letter-spacing: 0.125rem;
			user-select: all;
		}
	}

	.playtimes {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.playrow {
		display: grid;
		grid-template-columns: 10rem 1fr;
		align-items: center;
		gap: 1rem;

		@include below($bp-narrow) {
			grid-template-columns: 1fr;
			gap: 0.25rem;
		}
	}

	.gap {
		height: 1rem;
	}

	.more {
		display: flex;
		justify-content: center;
		padding: 0.75rem;
		border-top: 0.1rem solid var(--border-divider);
	}

	.content {
		word-break: break-word;
	}

	.balance {
		font-weight: 700;
		color: var(--text-heading);
	}

	// the sign already says which way the money went; the colour is there so a
	// column of transactions reads at a glance, not to carry the meaning alone
	.amount {
		font-variant-numeric: tabular-nums;
		white-space: nowrap;

		&.in {
			color: var(--success);
		}

		&.out {
			color: var(--warning);
		}

		// an admin adjusting their own balance: no direction to colour
		&.self {
			color: var(--text-secondary);
		}
	}

	.groups {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-bottom: 1rem;
	}

	.group {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.25rem 0.75rem;
		background: var(--bg-panel-raised);
		border: 0.1rem solid var(--border-divider);
		border-radius: var(--radius-button);

		&.primary {
			border-color: var(--link);
		}
	}

	.tagnote {
		font-size: 0.75rem;
		color: var(--link);
	}

	.chipbtn {
		border: none;
		background: none;
		color: var(--text-secondary);
		font-size: 1rem;
		line-height: 1;
		cursor: pointer;
		padding: 0 0.125rem;

		&:hover {
			color: var(--error);
		}
	}

	.groupadd {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.nodeadd {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		padding: 0.75rem 1rem;
		border-bottom: 0.1rem solid var(--border-divider);

		.input {
			flex: 1;
			min-width: 14rem;
		}
	}

	.grant {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--text-secondary);
	}
</style>
