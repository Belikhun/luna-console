<script lang="ts">
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
	import FileDrop from '$lib/components/FileDrop.svelte';
	import NodeEditorModal from '$lib/components/NodeEditorModal.svelte';
	import type { NodeSpec } from '$lib/components/nodes';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { copyText } from '$lib/clipboard';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * One player, in full: identity, skin, play history and statistics,
	 * permissions, chat/command log and moderation history — everything LunaCore
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

	/** Page size for the log tabs; "Load more" appends another page. */
	const LOG_PAGE = 100;

	/** Default lifetime offered for a temporary password, in minutes. */
	const DEFAULT_TEMP_MINUTES = 1440;

	/** Lifetimes the dialog offers, matching what luna-auth accepts. */
	const TEMP_LIFETIMES = [
		{ value: '15', label: '15 minutes' },
		{ value: '60', label: '1 hour' },
		{ value: '360', label: '6 hours' },
		{ value: '1440', label: '24 hours' },
		{ value: '10080', label: '7 days' },
		{ value: '43200', label: '30 days' }
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
	/** The plaintext of a freshly issued password — shown once, then forgotten. */
	let issuedPassword = $state('');
	let issuedOpen = $state(false);

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
		// verbs need to know whether the account is locked or has a password
		await Promise.all([
			loadAuth(),
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
		}
	}

	$effect(() => {
		void loadTab(tab);
	});

	onMount(() => {
		void refresh();

		void api('/instances').then((data) => {
			instances = data.instances
				.filter((inst: any) => inst.software !== 'velocity' && inst.name !== 'proxy')
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
					{ id: 'uuid', label: 'UUID', value: detail.uuid, style: 'mono', copyable: true },
					{
						label: 'Account type',
						value: detail.onlineMode ? 'Premium (Mojang)' : 'Offline / proxy-authenticated'
					},
					{ label: 'First seen', value: detail.firstSeenAtEpochMillis ? fmtDateTime(detail.firstSeenAtEpochMillis) : '–' },
					{
						label: 'Last seen',
						value: detail.online ? 'online now' : detail.lastSeenAtEpochMillis ? fmtDateTime(detail.lastSeenAtEpochMillis) : '–'
					},
					{
						label: detail.online ? 'Current backend' : 'Last backend',
						value: (detail.online ? detail.server : detail.lastServer) || '–',
						...(detail.online || detail.lastServer
							? { href: `/instances/${detail.online ? detail.server : detail.lastServer}` }
							: {})
					},
					{ label: 'Last address', value: detail.lastAddress || '–', style: 'mono' },
					{ label: 'Client version', value: detail.lastClientVersion || '–' },
					{
						label: 'Permission group',
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

	/** Administration verbs in the header — live ones first, then the lists. */
	function headerActions(): ContextMenuItem[] {
		const offline = !detail?.online;

		return [
			{
				label: 'Send a message',
				icon: 'paperPlane',
				disabled: offline,
				hint: offline ? 'player is offline' : undefined,
				action: () => {
					messageOpen = true;
				}
			},
			{
				label: 'Move to another backend',
				icon: 'rightLeft',
				disabled: offline,
				hint: offline ? 'player is offline' : undefined,
				action: () => {
					transferOpen = true;
				}
			},
			{
				label: 'Disconnect from the network',
				icon: 'userSlash',
				color: 'danger',
				disabled: offline,
				hint: offline ? 'player is offline' : undefined,
				action: () => {
					kickOpen = true;
				}
			},
			{ separator: true },
			{ label: 'Add to whitelist…', icon: 'userTick', action: () => openModerate('whitelist-add') },
			{ label: 'Remove from whitelist…', icon: 'userMinus', action: () => openModerate('whitelist-remove') },
			{ label: 'Grant operator…', icon: 'userCog', action: () => openModerate('op') },
			{ label: 'Revoke operator…', icon: 'userLock', action: () => openModerate('deop') },
			{ separator: true },
			{
				label: 'Change skin…',
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
			{ label: 'Ban…', icon: 'gavel', color: 'danger', action: () => openModerate('ban') },
			{ label: 'Pardon…', icon: 'handshake', action: () => openModerate('pardon') },
			{ separator: true },
			{
				label: 'Record a moderation note',
				icon: 'note',
				action: () => {
					noteOpen = true;
				}
			}
		];
	}

	/**
	 * The password verbs. Each unavailable one keeps its place and says why —
	 * "unlock" on an account that is not locked is information, not clutter.
	 */
	function passwordActions(): ContextMenuItem[] {
		const gone = !authAvailable;
		const reason = gone ? 'luna-auth is unavailable' : undefined;

		return [
			{
				label: 'Issue a temporary password…',
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
				label: 'Reset password…',
				icon: 'rotate',
				color: 'danger',
				disabled: gone || !authInfo?.registered,
				hint: reason ?? (authInfo?.registered ? undefined : 'the player has no password'),
				action: () => {
					resetOpen = true;
				}
			},
			{
				label: 'Unlock account',
				icon: 'lockOpen',
				disabled: gone || !authInfo?.locked,
				hint: reason ?? (authInfo?.locked ? undefined : 'the account is not locked'),
				action: () => void doAuth('unlock', 'Unlocking account…', 'Account unlocked')
			},
			{
				label: 'End authenticated session',
				icon: 'userLock',
				disabled: gone || !(authInfo?.authenticated || authInfo?.session.hasSession),
				hint: reason ?? (authInfo?.authenticated || authInfo?.session.hasSession ? undefined : 'no session to end'),
				action: () => void doAuth('logout', 'Ending session…', 'Session ended — the player must log in again')
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
			() => post('/luna/admin', { action: 'kick', player: detail?.username, reason: kickReason }),
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
			() => post('/luna/admin', { action: 'message', player: detail?.username, message: text }),
			`Sending a message to ${detail?.username}…`,
			`Message delivered to ${detail?.username}`
		);

		messageText = '';
	}

	async function doTransfer(): Promise<void> {
		transferOpen = false;

		await act(
			() => post('/luna/admin', { action: 'transfer', player: detail?.username, server: transferTo }),
			`Moving ${detail?.username} to ${transferTo}…`,
			`${detail?.username} moved to ${transferTo}`
		);
	}

	async function doModerate(): Promise<void> {
		moderateOpen = false;

		const label = ACTION_LABELS[moderateAction] ?? moderateAction;

		await act(
			async () => {
				const result = await post('/players/moderate', {
					action: moderateAction,
					targets: [detail?.username],
					instances: moderateInstances,
					reason: moderateReason
				});

				const failed = (result.outcomes ?? []).filter((outcome: any) => !outcome.ok);

				if (failed.length > 0) {
					throw new Error(failed.map((outcome: any) => `${outcome.instance}: ${outcome.error}`).join('; '));
				}

				return result;
			},
			`${label} ${detail?.username}…`,
			`${label} applied on ${moderateInstances.length} instance(s)`
		);

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
						? `${detail?.username}'s skin reset — their own skin applies again`
						: `${detail?.username}'s skin changed${detail?.online ? ' and applied live' : '; it applies on their next login'}`,
				closeable: true
			});

			await refresh();
			await loadModeration(true);
		} catch (err) {
			note.set({
				level: 'error',
				message: 'Skin change failed',
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
			`Password cleared — ${detail?.username} registers a new one with /register`
		);

		await loadModeration(true);
	}

	/**
	 * Issue a temporary password. The plaintext only exists in this response, so
	 * it goes straight into a dialog for the operator to pass on — reloading the
	 * page cannot bring it back.
	 */
	async function doTemporary(): Promise<void> {
		tempBusy = true;

		const note = Notify.loading(`Issuing a temporary password for ${detail?.username}…`);

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
				message: `Temporary password issued for ${detail?.username}`,
				closeable: true
			});

			await loadAuth();
			await loadModeration(true);
		} catch (err) {
			note.set({
				level: 'error',
				message: 'Could not issue a temporary password',
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
						label: 'Password',
						value: !authInfo.registered
							? 'None — not registered'
							: authInfo.temporaryPassword
								? `Temporary, expires ${fmtDateTime(authInfo.temporaryPasswordUntilEpochMillis)}`
								: 'Set by the player'
					},
					{ label: 'Signed in', value: authInfo.authenticated ? 'Yes' : 'No' },
					{
						label: 'Account lock',
						value: authInfo.locked
							? `Locked until ${fmtDateTime(authInfo.lockedUntilEpochMillis)}`
							: 'Not locked'
					},
					{ label: 'Failed attempts', value: authInfo.failedAttempts },
					{
						label: 'Last login',
						value: authInfo.lastLoginAtEpochMillis ? fmtDateTime(authInfo.lastLoginAtEpochMillis) : '–'
					},
					{ label: 'Last address', value: authInfo.lastIp || '–', style: 'mono' },
					{
						label: 'Registered on',
						value: authInfo.createdAtEpochMillis ? fmtDateTime(authInfo.createdAtEpochMillis) : '–'
					},
					{
						label: 'Resumable session',
						value: authInfo.session.hasSession
							? `Until ${fmtDateTime(authInfo.session.expiresAtEpochMillis)}`
							: 'None'
					}
				]
			: []
	);

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

	const sessionCols: Column[] = [
		{ id: 'connected', label: 'Connected', sortable: true },
		{ id: 'server', label: 'Backend', sortable: true },
		{ id: 'duration', label: 'Duration', sortable: true },
		{ id: 'ended', label: 'Disconnected' }
	];

	const chatCols: Column[] = [
		{ id: 'time', label: 'Time', width: 180, sortable: true },
		{ id: 'type', label: 'Type', width: 120 },
		{ id: 'server', label: 'Backend', width: 130 },
		{ id: 'content', label: 'Content' }
	];

	const modCols: Column[] = [
		{ id: 'time', label: 'Time', width: 180, sortable: true },
		{ id: 'action', label: 'Action', width: 150 },
		{ id: 'actor', label: 'By', width: 130 },
		{ id: 'server', label: 'Where', width: 140 },
		{ id: 'reason', label: 'Reason' }
	];

	const nodeCols: Column[] = [
		{ id: 'key', label: 'Node', minWidth: 240 },
		{ id: 'value', label: 'Value', width: 110 },
		{ id: 'type', label: 'Type', width: 130 },
		{ id: 'contexts', label: 'Contexts' },
		{ id: 'expiry', label: 'Expires' }
	];

	function nodeActions(node: PermNode): ContextMenuItem[] {
		return [
			{
				label: 'Edit node…',
				icon: 'pen',
				action: () => openNodeEditor(node)
			},
			{ separator: true },
			{
				label: 'Remove node',
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
		<Dropdown label="Actions" disabled={!detail} menu={headerActions()} />
	{/snippet}
</PageHeader>

{#if notFound}
	<Flash kind="error">
		<b>Unknown player:</b> the directory has no record of <code>{ref}</code>. Profiles are
		created on a player's first join once the LunaCore player directory is running.
	</Flash>
{:else if !available}
	<Flash kind="warning">
		<b>LunaCore is not answering:</b> {problem}. The proxy may be stopped, or running a build
		without the player directory.
	</Flash>
{:else if detail}
	<OverviewBar title="Player overview">
		<OverviewCell label="Status">
			{#if detail.online}
				<StatusBadge state="ok" label="Online — {detail.server}" />
			{:else}
				<StatusBadge state="stopped" label="Offline" />
			{/if}
		</OverviewCell>
		<OverviewCell label="Total playtime">
			{detail.totalPlayMillis ? fmtDuration(detail.totalPlayMillis) : '–'}
		</OverviewCell>
		<OverviewCell label="Sessions">
			{detail.sessionCount}
		</OverviewCell>
		<OverviewCell label="Chat messages">
			{detail.chatTotal}
		</OverviewCell>
		<OverviewCell label="Commands">
			{detail.commandTotal}
		</OverviewCell>
		<OverviewCell label="Moderation entries">
			{detail.moderationTotal}
		</OverviewCell>
	</OverviewBar>

	<div class="columns">
		<Panel title="Skin" description="Pick a pose; drag the model to turn it">
			<div class="skin">
				<PlayerSkin3D player={detail.uuid} bust={skinEpoch} />
			</div>
		</Panel>

		<Panel title="Identity">
			<InfoGrid cells={identityCells} columns={[2, 2, 1]} />
		</Panel>
	</div>

	<Tabs
		tabs={[
			{ id: 'overview', label: 'Overview' },
			{ id: 'account', label: 'Account' },
			{ id: 'sessions', label: 'Play history' },
			{ id: 'chat', label: 'Chat & commands' },
			{ id: 'permissions', label: 'Permissions' },
			{ id: 'moderation', label: 'Moderation' }
		]}
		bind:active={tab}
	/>

	<div class="tabbody">
		{#if tab === 'overview'}
			<Panel
				title="Playtime by backend"
				description="Closed play sessions only — the current session counts once it ends"
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
					<p class="dim">No completed play sessions recorded yet.</p>
				{/if}
			</Panel>
		{:else if tab === 'account'}
			{#if !authAvailable}
				<Flash kind="warning">
					<b>luna-auth is not answering:</b> {authProblem}. Password administration needs the
					plugin running on the proxy.
				</Flash>
			{:else if authInfo}
				{#if authInfo.temporaryPasswordExpired}
					<Flash kind="warning">
						This player's temporary password has <b>expired</b>. Their account has no password
						until they register a new one, or you issue another temporary password.
					</Flash>
				{:else if authInfo.temporaryPassword}
					<Flash kind="info">
						This player is using a <b>temporary password</b>, issued by an administrator. It stops
						working on {fmtDateTime(authInfo.temporaryPasswordUntilEpochMillis)}, after which the
						account has no password until they register again.
					</Flash>
				{:else if !authInfo.registered}
					<Flash kind="info">
						This player has never set a password. They register one in game with
						<code>/register</code>, or you can issue a temporary one for them.
					</Flash>
				{/if}

				<Panel
					title="Authentication"
					description="Held by luna-auth on the proxy — the same state the /auth command reports"
				>
					<InfoGrid cells={authCells} columns={[4, 2, 1]} />
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
					searchPlaceholder="Find backend"
					noun="session"
					pageSize={25}
					sortValue={(session, col) =>
						col === 'connected'
							? session.connectedAtEpochMillis
							: col === 'server'
								? session.server
								: col === 'duration'
									? session.durationMillis
									: null}
					emptyTitle="No sessions recorded"
					emptyText="Play sessions are recorded from the moment the LunaCore player directory first runs."
				>
					{#snippet cell(session, col)}
						{#if col === 'connected'}
							{fmtDateTime(session.connectedAtEpochMillis)}
						{:else if col === 'server'}
							<a href="/instances/{session.server}">{session.server}</a>
						{:else if col === 'duration'}
							{#if session.open}
								<StatusBadge state="ok" label="ongoing" />
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
				<div class="chatfilter">
					<Select
						bind:value={chatType}
						options={[
							{ value: '', label: 'Chat and commands' },
							{ value: 'chat', label: 'Chat only' },
							{ value: 'command', label: 'Commands only' }
						]}
						onchange={() => void loadChat(true)}
					/>
				</div>
				<ResourceTable
					tableId="player-chat"
					columns={chatCols}
					rows={chat}
					getId={(entry) => String(entry.id)}
					searchValue={(entry) => `${entry.content} ${entry.server} ${entry.type}`}
					searchPlaceholder="Find in messages"
					noun="entry"
					pageSize={50}
					sortValue={(entry, col) => (col === 'time' ? entry.atEpochMillis : null)}
					emptyTitle="Nothing recorded"
					emptyText="Chat and commands are recorded by the proxy as they happen; credentials in auth commands are redacted."
				>
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
					<b>LuckPerms is not answering:</b> {permsProblem}
				</Flash>
			{:else}
				<Panel
					title="Groups"
					description="Primary group is the one LuckPerms resolves for prefix and weight"
				>
					<div class="groups">
						{#each userGroups as group}
							<span class="group" class:primary={group === primaryGroup}>
								<a href="/permissions/{encodeURIComponent(group)}">{group}</a>
								{#if group === primaryGroup}
									<span class="tagnote">primary</span>
								{/if}
								<button
									class="chipbtn"
									title="Remove from {group}"
									onclick={() => void editGroups('remove', group)}
								>×</button>
							</span>
						{:else}
							<span class="dim">No group memberships — LuckPerms falls back to default.</span>
						{/each}
					</div>
					<div class="groupadd">
						<Select
							bind:value={groupPick}
							options={allGroups.map((group) => ({ value: group.name, label: group.name }))}
							width="14rem"
						/>
						<Btn icon="plus" onclick={() => void editGroups('add', groupPick)} disabled={!groupPick}>
							Add group
						</Btn>
						<Btn onclick={() => void editGroups('set', groupPick)} disabled={!groupPick}>
							Set as only group
						</Btn>
					</div>
				</Panel>
				<div class="gap"></div>
				<Panel flush title="Permission nodes" count={userNodes.length}>
					<div class="nodeadd">
						<input class="input" bind:value={nodeKey} placeholder="permission.node.key" />
						<label class="grant">
							<Toggle checked={nodeGrant} onchange={(checked) => (nodeGrant = checked)} />
							<span>{nodeGrant ? 'granted' : 'negated'}</span>
						</label>
						<Select
							bind:value={nodeServer}
							options={[
								{ value: '', label: 'Every server' },
								...servers.map((name) => ({ value: name, label: `server=${name}` }))
							]}
							width="13rem"
						/>
						<Btn variant="primary" icon="plus" onclick={addNode} disabled={!nodeKey.trim()}>Add node</Btn>
					</div>
					<ResourceTable
						tableId="player-nodes"
						columns={nodeCols}
						rows={userNodes}
						getId={(node) => `${node.key}|${node.contexts.map((pair) => `${pair.key}=${pair.value}`).join(',')}`}
						searchValue={(node) => node.key}
						searchPlaceholder="Find node"
						noun="node"
						pageSize={25}
						rowActions={nodeActions}
						rowLabel={(node) => node.key}
						emptyTitle="No nodes on this user"
						emptyText="Direct nodes only — permissions inherited from groups live on the group."
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
									<span class="dim">global</span>
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
					searchPlaceholder="Find entry"
					noun="entry"
					pageSize={25}
					sortValue={(entry, col) => (col === 'time' ? entry.atEpochMillis : null)}
					emptyTitle="A clean record"
					emptyText="Kicks, bans, whitelist and operator changes made through luna land here, along with manual notes."
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
	<p>They are removed from the network immediately and can reconnect straight away.</p>
	<label class="field">
		<span class="lbl">Reason shown to the player</span>
		<input class="input" bind:value={kickReason} placeholder="e.g. restarting the lobby" />
	</label>
	{#snippet footer()}
		<Btn onclick={() => (kickOpen = false)}>Cancel</Btn>
		<Btn variant="danger" onclick={doKick}>Disconnect</Btn>
	{/snippet}
</Modal>

<Modal title="Message {detail?.username ?? 'player'}" bind:open={messageOpen}>
	<label class="field">
		<span class="lbl">Message</span>
		<input class="input" bind:value={messageText} placeholder="Type a message" />
	</label>
	{#snippet footer()}
		<Btn onclick={() => (messageOpen = false)}>Cancel</Btn>
		<Btn variant="primary" disabled={!messageText.trim()} onclick={doMessage}>Send</Btn>
	{/snippet}
</Modal>

<Modal title="Move {detail?.username ?? 'player'}" bind:open={transferOpen}>
	<div class="field">
		<span class="lbl">Destination backend</span>
		<Select
			bind:value={transferTo}
			width="100%"
			options={servers
				.filter((name) => name !== detail?.server)
				.map((name) => ({ value: name, label: name }))}
		/>
	</div>
	{#snippet footer()}
		<Btn onclick={() => (transferOpen = false)}>Cancel</Btn>
		<Btn variant="primary" disabled={!transferTo} onclick={doTransfer}>Move</Btn>
	{/snippet}
</Modal>

<Modal title="{ACTION_LABELS[moderateAction] ?? moderateAction}: {detail?.username ?? ref}" bind:open={moderateOpen}>
	<div class="field">
		<span class="lbl">Instances</span>
		<span class="hint">The change is applied on each selected instance</span>
		<MultiSelect
			bind:value={moderateInstances}
			width="100%"
			options={instances.map((name) => ({ value: name, label: name }))}
		/>
	</div>
	{#if moderateAction === 'ban'}
		<label class="field">
			<span class="lbl">Reason</span>
			<span class="hint">Recorded in the moderation log and shown to the player</span>
			<input class="input" bind:value={moderateReason} placeholder="e.g. griefing on survival" />
		</label>
	{/if}
	{#snippet footer()}
		<Btn onclick={() => (moderateOpen = false)}>Cancel</Btn>
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
		<span class="lbl">Source</span>
		<Select
			bind:value={skinMode}
			width="100%"
			options={[
				{ value: 'upload', label: 'Upload a skin file (PNG)' },
				{ value: 'url', label: 'Image URL' },
				{ value: 'name', label: 'Mirror a Mojang account' },
				{ value: 'reset', label: 'Reset — back to their own skin' }
			]}
		/>
	</div>

	{#if skinMode === 'upload'}
		<div class="field">
			<span class="lbl">Skin file</span>
			<span class="hint">
				A 64×64 (or legacy 64×32) skin PNG. It is signed through MineSkin, then stored and
				applied by SkinsRestorer on the proxy.
			</span>
			<FileDrop bind:file={skinFile} accept=".png" hint="Drop a skin PNG here, or click to browse" />
		</div>
	{:else if skinMode === 'url'}
		<label class="field">
			<span class="lbl">Image URL</span>
			<span class="hint">Must be publicly reachable — MineSkin fetches it to sign the texture</span>
			<input class="input mono" bind:value={skinUrl} placeholder="https://…/skin.png" />
		</label>
	{:else if skinMode === 'name'}
		<label class="field">
			<span class="lbl">Mojang account</span>
			<span class="hint">The player gets this account's current skin</span>
			<input class="input" bind:value={skinName} placeholder="e.g. Notch" />
		</label>
	{:else}
		<p>
			SkinsRestorer forgets the stored skin; the player goes back to whatever their own
			profile carries.
		</p>
	{/if}

	{#if skinMode === 'upload' || skinMode === 'url'}
		<div class="field">
			<span class="lbl">Arm model</span>
			<Select
				bind:value={skinVariant}
				width="100%"
				options={[
					{ value: '', label: 'Detect automatically' },
					{ value: 'classic', label: 'Classic (4-px arms)' },
					{ value: 'slim', label: 'Slim (3-px arms)' }
				]}
			/>
		</div>
	{/if}

	{#snippet footer()}
		<Btn onclick={() => (skinOpen = false)}>Cancel</Btn>
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
		permissions, but cannot log in until they set a new password with <code>/register</code>.
	</p>
	<p class="dim">
		If they need to get back in right away, issue a temporary password instead — that gives them
		a credential you can hand over.
	</p>
	{#snippet footer()}
		<Btn onclick={() => (resetOpen = false)}>Cancel</Btn>
		<Btn variant="danger" onclick={doReset}>Reset password</Btn>
	{/snippet}
</Modal>

<Modal title="Temporary password for {detail?.username ?? 'player'}" bind:open={tempOpen}>
	<label class="field">
		<span class="lbl">Password</span>
		<span class="hint">
			Leave empty and the proxy generates one — it is shown once, after this dialog closes
		</span>
		<input class="input mono" bind:value={tempPassword} placeholder="Generate one for me" />
	</label>

	<div class="field">
		<span class="lbl">Valid for</span>
		<span class="hint">
			When it expires the account is left with no password, exactly as a reset leaves it
		</span>
		<Select bind:value={tempMinutes} width="100%" options={TEMP_LIFETIMES} />
	</div>

	{#if authInfo?.online}
		<p class="dim">
			{detail?.username} is online and will be disconnected, so the new password applies on their
			next login.
		</p>
	{/if}

	{#snippet footer()}
		<Btn onclick={() => (tempOpen = false)}>Cancel</Btn>
		<Btn
			variant="primary"
			disabled={tempBusy || (tempPassword.trim().length > 0 && tempPassword.trim().length < 6)}
			loading={tempBusy}
			onclick={doTemporary}
		>
			Issue password
		</Btn>
	{/snippet}
</Modal>

<Modal title="Temporary password issued" bind:open={issuedOpen}>
	<p>
		Give this to {detail?.username}. Only its hash is stored, so this is the one and only time it
		can be read — reopening the page will not show it again.
	</p>
	<div class="issued">
		<code>{issuedPassword}</code>
		<Btn icon="copy" onclick={() => void copyText(issuedPassword)}>Copy</Btn>
	</div>
	{#snippet footer()}
		<Btn variant="primary" onclick={() => (issuedOpen = false)}>Done</Btn>
	{/snippet}
</Modal>

<Modal title="Record a moderation note" bind:open={noteOpen}>
	<label class="field">
		<span class="lbl">Note</span>
		<span class="hint">Stored in the player's moderation history, visible to every operator</span>
		<input class="input" bind:value={noteText} placeholder="e.g. warned about chat behaviour" />
	</label>
	{#snippet footer()}
		<Btn onclick={() => (noteOpen = false)}>Cancel</Btn>
		<Btn variant="primary" disabled={!noteText.trim()} onclick={doNote}>Record</Btn>
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

	.chatfilter {
		display: flex;
		justify-content: flex-end;
		padding: 0.75rem 1rem 0;
	}

	.content {
		word-break: break-word;
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
