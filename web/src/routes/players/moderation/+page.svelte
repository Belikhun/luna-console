<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { api, post } from '$lib/api';
	import { fmtDateTime } from '$lib/format';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Tabs from '$lib/components/Tabs.svelte';
	import Toggle from '$lib/components/Toggle.svelte';
	import MultiSelect from '$lib/components/MultiSelect.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import OverviewBar from '$lib/components/OverviewBar.svelte';
	import OverviewCell from '$lib/components/OverviewCell.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import PlayerName from '$lib/components/PlayerName.svelte';
	import PlayerPicker from '$lib/components/PlayerPicker.svelte';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * Network-wide moderation: the whole cluster's moderation history from
	 * LunaCore, and every backend's bans, whitelist, operators and IP bans
	 * folded into one row per target, so an operator manages the network here
	 * instead of opening eight instance tabs. Mutations go through the same
	 * fan-out the players screen uses (POST /api/players/moderate).
	 */

	interface InstanceSummary {
		name: string;
		state: string;
		whitelistEnabled: boolean;
		enforceWhitelist: boolean;
		error?: string;
	}

	interface BanRow {
		name: string;
		uuid: string;
		reason: string;
		source: string;
		created: string;
		expires: string;
		instances: string[];
	}

	interface IpBanRow {
		ip: string;
		reason: string;
		source: string;
		created: string;
		expires: string;
		instances: string[];
	}

	interface WhitelistRow {
		name: string;
		uuid: string;
		instances: string[];
	}

	interface OpRow {
		name: string;
		uuid: string;
		level: number;
		bypassesPlayerLimit: boolean;
		instances: string[];
	}

	interface NetBanRow {
		ip: string;
		reason: string;
		actor: string;
		createdAtEpochMillis: number;
		expiresAtEpochMillis: number;
		hits: number;
		lastHitAtEpochMillis: number;
	}

	interface LogEntry {
		id: number;
		action: string;
		actor: string;
		reason: string;
		server: string;
		details: string;
		targetUuid: string;
		targetName: string;
		atEpochMillis: number;
	}

	/** LunaCore pages at 200 max; older entries load on demand. */
	const LOG_PAGE = 200;

	let tab = $state('logs');

	let summaries: InstanceSummary[] = $state([]);
	let bans: BanRow[] = $state([]);
	let ipBans: IpBanRow[] = $state([]);
	let whitelist: WhitelistRow[] = $state([]);
	let ops: OpRow[] = $state([]);
	let listsProblem = $state('');

	let netBans: NetBanRow[] = $state([]);
	let netAvailable = $state(true);
	let netProblem = $state('');

	let logEntries: LogEntry[] = $state([]);
	let logTotal = $state(0);
	let logActions: string[] = $state([]);
	let logAvailable = $state(true);
	let logProblem = $state('');
	let logLoadingMore = $state(false);

	let loading = $state(true);
	let lastUpdated: number | null = $state(null);

	let selectedBans: Set<string> = $state(new Set());
	let selectedWhitelist: Set<string> = $state(new Set());
	let selectedOps: Set<string> = $state(new Set());
	let selectedIpBans: Set<string> = $state(new Set());
	let selectedNetBans: Set<string> = $state(new Set());

	/** Backends whose lists actually arrived; the coverage denominator. */
	const reporting = $derived(summaries.filter((inst) => !inst.error).map((inst) => inst.name));
	const unreachable = $derived(summaries.filter((inst) => inst.error));

	function rowKey(row: { uuid: string; name: string }): string {
		return row.uuid || row.name.toLowerCase();
	}

	const banSelection = $derived(bans.filter((row) => selectedBans.has(rowKey(row))));
	const whitelistSelection = $derived(whitelist.filter((row) => selectedWhitelist.has(rowKey(row))));
	const opSelection = $derived(ops.filter((row) => selectedOps.has(rowKey(row))));
	const ipBanSelection = $derived(ipBans.filter((row) => selectedIpBans.has(row.ip)));
	const netBanSelection = $derived(netBans.filter((row) => selectedNetBans.has(row.ip)));

	async function refreshLists(): Promise<void> {
		try {
			const data = await api('/moderation');

			summaries = data.instances ?? [];
			bans = data.bans ?? [];
			ipBans = data.ipBans ?? [];
			whitelist = data.whitelist ?? [];
			ops = data.ops ?? [];
			listsProblem = '';
		} catch (err) {
			listsProblem = (err as Error).message;
		}
	}

	async function refreshNetBans(): Promise<void> {
		try {
			const data = await api('/moderation/network-ip-bans');

			if (data.available === false) {
				netAvailable = false;
				netProblem = data.error ?? 'LunaCore is unreachable';
				return;
			}

			netAvailable = true;
			netProblem = '';
			netBans = data.bans ?? [];
		} catch (err) {
			netAvailable = false;
			netProblem = (err as Error).message;
		}
	}

	async function refreshLog(): Promise<void> {
		try {
			const data = await api(`/moderation/log?limit=${LOG_PAGE}`);

			if (data.available === false) {
				logAvailable = false;
				logProblem = data.error ?? 'LunaCore is unreachable';
				return;
			}

			logAvailable = true;
			logProblem = '';
			logEntries = data.entries ?? [];
			logTotal = data.total ?? 0;
			logActions = data.actions ?? [];
		} catch (err) {
			logAvailable = false;
			logProblem = (err as Error).message;
		}
	}

	async function loadOlderLog(): Promise<void> {
		logLoadingMore = true;

		try {
			const data = await api(`/moderation/log?limit=${LOG_PAGE}&offset=${logEntries.length}`);

			if (data.available !== false) {
				logEntries = [...logEntries, ...(data.entries ?? [])];
				logTotal = data.total ?? logTotal;
			}
		} catch {
			// the failed page can be retried from the same button
		}

		logLoadingMore = false;
	}

	async function refresh(): Promise<void> {
		loading = true;

		await Promise.all([refreshLists(), refreshLog(), refreshNetBans()]);

		loading = false;
		lastUpdated = Date.now();
	}

	onMount(() => {
		void refresh();
	});

	// -- the moderation dialog: one verb over targets and instances ------------

	let moderateOpen = $state(false);
	let moderateAction = $state('');
	let moderateTargets: Array<{ name: string; uuid?: string }> = $state([]);
	let moderateInstances: string[] = $state([]);
	let moderateReason = $state('');

	// the add flows pick a fresh target inside the dialog instead
	let addMode = $state(false);
	let addTarget = $state('');
	let addUuid = $state('');

	const ACTION_LABELS: Record<string, string> = $derived({
		ban: t('web.players.actionBan'),
		pardon: t('web.players.actionPardon'),
		'ban-ip': t('web.moderation.actionBanIp'),
		'pardon-ip': t('web.moderation.actionPardonIp'),
		'whitelist-add': t('web.players.actionWhitelistAdd'),
		'whitelist-remove': t('web.players.actionWhitelistRemove'),
		op: t('web.players.actionOp'),
		deop: t('web.players.actionDeop')
	});

	const needsReason = $derived(['ban', 'ban-ip'].includes(moderateAction));
	const targetsIp = $derived(['ban-ip', 'pardon-ip'].includes(moderateAction));
	const targetCount = $derived(addMode ? 1 : moderateTargets.length);

	function openModerate(
		action: string,
		targets: Array<{ name: string; uuid?: string }>,
		instances: string[]
	): void {
		moderateAction = action;
		moderateTargets = targets;
		moderateInstances = instances;
		moderateReason = '';
		addMode = false;
		moderateOpen = true;
	}

	function openAdd(action: string): void {
		moderateAction = action;
		moderateTargets = [];
		moderateInstances = [...reporting];
		moderateReason = '';
		addMode = true;
		addTarget = '';
		addUuid = '';
		moderateOpen = true;
	}

	async function doModerate(): Promise<void> {
		moderateOpen = false;

		const targets = addMode
			? [{ name: addTarget.trim(), ...(addUuid ? { uuid: addUuid } : {}) }]
			: moderateTargets;

		if (targets.length === 0 || !targets[0].name) {
			return;
		}

		const label = ACTION_LABELS[moderateAction] ?? moderateAction;
		const note = Notify.loading(t('web.moderation.applyingTo', { label, count: targets.length }));

		try {
			const result = await post('/players/moderate', {
				action: moderateAction,
				targets,
				instances: moderateInstances,
				reason: moderateReason
			});

			const outcomes: Array<{
				ok: boolean;
				verified?: boolean;
				target: string;
				instance: string;
				error?: string;
			}> = result.outcomes ?? [];
			const failed = outcomes.filter((outcome) => !outcome.ok);
			const unconfirmed = outcomes.filter((outcome) => outcome.ok && outcome.verified === false);

			if (failed.length === 0 && unconfirmed.length > 0) {
				note.set({
					level: 'warning',
					message: t('web.players.someUnconfirmed', { label, count: unconfirmed.length }),
					detail: unconfirmed
						.map((outcome) => `${outcome.target}${outcome.instance ? ` @ ${outcome.instance}` : ''}`)
						.join('\n'),
					closeable: true
				});
			} else if (failed.length === 0) {
				note.set({
					level: 'success',
					message: t('web.moderation.appliedTo', { label, count: targets.length }),
					closeable: true
				});
			} else {
				note.set({
					level: 'warning',
					message: t('web.players.partialSucceeded', { label, ok: outcomes.length - failed.length, total: outcomes.length }),
					detail: failed
						.map((outcome) => `${outcome.target}${outcome.instance ? ` @ ${outcome.instance}` : ''}: ${outcome.error}`)
						.join('\n'),
					closeable: true
				});
			}

			await refresh();
		} catch (err) {
			note.set({ level: 'error', message: label, detail: (err as Error).message, closeable: true });
		}
	}

	// -- network-level IP bans; enforced by the proxy at pre-login --------------

	let netBanOpen = $state(false);
	let netBanIp = $state('');
	let netBanReason = $state('');
	let promoteOpen = $state(false);
	let promoteRows: IpBanRow[] = $state([]);

	async function doNetworkChange(action: 'add' | 'remove', ips: string[], reason = ''): Promise<void> {
		const label = action === 'add'
			? t('web.moderation.actionNetBan')
			: t('web.moderation.actionNetPardon');
		const note = Notify.loading(t('web.moderation.applyingTo', { label, count: ips.length }));

		try {
			const result = await post('/moderation/network-ip-bans', { action, ips, reason });

			const outcomes: Array<{ ip: string; ok: boolean; error?: string }> = result.outcomes ?? [];
			const failed = outcomes.filter((outcome) => !outcome.ok);

			if (failed.length === 0) {
				note.set({
					level: 'success',
					message: t('web.moderation.appliedTo', { label, count: ips.length }),
					closeable: true
				});
			} else {
				note.set({
					level: 'warning',
					message: t('web.players.partialSucceeded', { label, ok: outcomes.length - failed.length, total: outcomes.length }),
					detail: failed.map((outcome) => `${outcome.ip}: ${outcome.error}`).join('\n'),
					closeable: true
				});
			}

			await refreshNetBans();
		} catch (err) {
			note.set({ level: 'error', message: label, detail: (err as Error).message, closeable: true });
		}
	}

	function openNetBan(): void {
		netBanIp = '';
		netBanReason = '';
		netBanOpen = true;
	}

	function submitNetBan(): void {
		const ip = netBanIp.trim();

		netBanOpen = false;

		if (!ip) {
			return;
		}

		void doNetworkChange('add', [ip], netBanReason.trim());
	}

	function openPromote(rows: IpBanRow[]): void {
		promoteRows = rows;
		promoteOpen = true;
	}

	function submitPromote(): void {
		// a lone row carries its reason up; a mixed selection would misattribute one
		const reason = promoteRows.length === 1 ? (promoteRows[0]?.reason ?? '') : '';

		void doNetworkChange('add', promoteRows.map((row) => row.ip), reason);
	}

	function netBanActions(rows: NetBanRow[]): ContextMenuItem[] {
		const none = rows.length === 0;

		return [
			{
				label: t('web.moderation.pardonOnNetwork'),
				icon: 'handshake',
				disabled: none,
				action: () => void doNetworkChange('remove', rows.map((row) => row.ip))
			}
		];
	}

	function netBanRowActions(row: NetBanRow): ContextMenuItem[] {
		const rows = pick(row, netBanSelection, selectedNetBans.has(row.ip));

		return netBanActions(rows);
	}

	async function toggleWhitelistFor(instance: string, enabled: boolean): Promise<void> {
		const note = Notify.loading(t(enabled ? 'web.access.turningOn' : 'web.access.turningOff'));

		try {
			await post(`/instances/${instance}/access`, { kind: 'whitelist', enabled });

			note.set({
				level: 'success',
				message: `${instance}: ${t(enabled ? 'web.access.nowOn' : 'web.access.nowOff')}`,
				closeable: true
			});

			await refreshLists();
		} catch (err) {
			note.set({
				level: 'error',
				message: t('web.access.toggleFailed'),
				detail: (err as Error).message,
				closeable: true
			});
		}
	}

	// -- verbs; each tab's Actions dropdown and row menus share one builder ----

	function playerTargets(rows: Array<{ name: string; uuid: string }>): Array<{ name: string; uuid?: string }> {
		return rows.map((row) => ({ name: row.name, ...(row.uuid ? { uuid: row.uuid } : {}) }));
	}

	/** The union of the rows' covered backends; where a removal verb applies. */
	function coveredInstances(rows: Array<{ instances: string[] }>): string[] {
		return [...new Set(rows.flatMap((row) => row.instances))].sort();
	}

	function fullyCovered(rows: Array<{ instances: string[] }>): boolean {
		return rows.every((row) => row.instances.length >= reporting.length);
	}

	function banActions(rows: BanRow[]): ContextMenuItem[] {
		const none = rows.length === 0;

		return [
			{
				label: t('web.moderation.banOnAll'),
				icon: 'gavel',
				color: 'danger',
				disabled: none || fullyCovered(rows),
				hint: !none && fullyCovered(rows) ? t('web.moderation.everywhere') : undefined,
				action: () => openModerate('ban', playerTargets(rows), [...reporting])
			},
			{
				label: t('web.players.pardon'),
				icon: 'handshake',
				disabled: none,
				action: () => openModerate('pardon', playerTargets(rows), coveredInstances(rows))
			}
		];
	}

	function whitelistActions(rows: WhitelistRow[]): ContextMenuItem[] {
		const none = rows.length === 0;

		return [
			{
				label: t('web.moderation.whitelistOnAll'),
				icon: 'userTick',
				disabled: none || fullyCovered(rows),
				hint: !none && fullyCovered(rows) ? t('web.moderation.everywhere') : undefined,
				action: () => openModerate('whitelist-add', playerTargets(rows), [...reporting])
			},
			{
				label: t('web.players.removeFromWhitelist'),
				icon: 'userMinus',
				disabled: none,
				action: () => openModerate('whitelist-remove', playerTargets(rows), coveredInstances(rows))
			}
		];
	}

	function opActions(rows: OpRow[]): ContextMenuItem[] {
		const none = rows.length === 0;

		return [
			{
				label: t('web.moderation.opOnAll'),
				icon: 'userCog',
				disabled: none || fullyCovered(rows),
				hint: !none && fullyCovered(rows) ? t('web.moderation.everywhere') : undefined,
				action: () => openModerate('op', playerTargets(rows), [...reporting])
			},
			{
				label: t('web.players.revokeOperator'),
				icon: 'userLock',
				disabled: none,
				action: () => openModerate('deop', playerTargets(rows), coveredInstances(rows))
			}
		];
	}

	function ipBanActions(rows: IpBanRow[]): ContextMenuItem[] {
		const none = rows.length === 0;

		return [
			{
				label: t('web.moderation.ipBanOnAll'),
				icon: 'gavel',
				color: 'danger',
				disabled: none || fullyCovered(rows),
				hint: !none && fullyCovered(rows) ? t('web.moderation.everywhere') : undefined,
				action: () => openModerate('ban-ip', rows.map((row) => ({ name: row.ip })), [...reporting])
			},
			{
				label: t('web.moderation.pardonAddress'),
				icon: 'handshake',
				disabled: none,
				action: () => openModerate('pardon-ip', rows.map((row) => ({ name: row.ip })), coveredInstances(rows))
			},
			{ separator: true },
			{
				label: t('web.moderation.promoteToNetwork'),
				icon: 'sitemap',
				color: 'danger',
				disabled: none,
				action: () => openPromote(rows)
			}
		];
	}

	function profileVerbs(uuid: string, name: string): ContextMenuItem[] {
		return [
			{
				label: t('web.players.viewProfile'),
				icon: 'user',
				action: () => goto(`/players/${uuid || name}`)
			},
			...(uuid
				? [
						{
							label: t('web.players.copyUuid'),
							icon: 'copy',
							action: () => void copy(uuid)
						}
					]
				: []),
			{ separator: true } as ContextMenuItem
		];
	}

	async function copy(text: string): Promise<void> {
		const { copyText } = await import('$lib/clipboard');

		await copyText(text);
	}

	// right-clicking inside the selection acts on all of it, outside on the row
	function pick<T>(row: T, selection: T[], inside: boolean): T[] {
		return inside && selection.length > 1 ? selection : [row];
	}

	function banRowActions(row: BanRow): ContextMenuItem[] {
		const rows = pick(row, banSelection, selectedBans.has(rowKey(row)));

		return [...profileVerbs(row.uuid, row.name), ...banActions(rows)];
	}

	function whitelistRowActions(row: WhitelistRow): ContextMenuItem[] {
		const rows = pick(row, whitelistSelection, selectedWhitelist.has(rowKey(row)));

		return [...profileVerbs(row.uuid, row.name), ...whitelistActions(rows)];
	}

	function opRowActions(row: OpRow): ContextMenuItem[] {
		const rows = pick(row, opSelection, selectedOps.has(rowKey(row)));

		return [...profileVerbs(row.uuid, row.name), ...opActions(rows)];
	}

	function ipBanRowActions(row: IpBanRow): ContextMenuItem[] {
		const rows = pick(row, ipBanSelection, selectedIpBans.has(row.ip));

		return ipBanActions(rows);
	}

	function logRowActions(entry: LogEntry): ContextMenuItem[] {
		if (!entry.targetUuid && !entry.targetName) {
			return [];
		}

		return profileVerbs(entry.targetUuid, entry.targetName).filter((item) => !item.separator);
	}

	// -- tables -----------------------------------------------------------------

	const tabs = $derived([
		{ id: 'logs', label: t('web.moderation.tabLogs') },
		{ id: 'bans', label: t('web.moderation.tabBans') },
		{ id: 'whitelist', label: t('web.moderation.tabWhitelist') },
		{ id: 'ops', label: t('web.moderation.tabOps') },
		{ id: 'netbans', label: t('web.moderation.tabNetBans') },
		{ id: 'ipbans', label: t('web.moderation.tabIpBans') }
	]);

	const logColumns: Column[] = $derived([
		{ id: 'time', label: t('web.moderation.colTime'), sortable: true, minWidth: 170 },
		{ id: 'action', label: t('web.moderation.colAction'), sortable: true },
		{ id: 'target', label: t('web.moderation.colTarget'), sortable: true, minWidth: 160 },
		{ id: 'actor', label: t('web.moderation.colActor'), sortable: true },
		{ id: 'server', label: t('web.moderation.colServer') },
		{ id: 'reason', label: t('web.access.colReason') },
		{ id: 'details', label: t('web.moderation.colDetails'), hidden: true }
	]);

	const banColumns: Column[] = $derived([
		{ id: 'name', label: t('web.access.colPlayer'), sortable: true, minWidth: 180 },
		{ id: 'coverage', label: t('web.moderation.colBackends'), sortable: true },
		{ id: 'reason', label: t('web.access.colReason') },
		{ id: 'source', label: t('web.access.colBy') },
		{ id: 'created', label: t('web.access.colBanned'), sortable: true },
		{ id: 'expires', label: t('web.access.colExpires') },
		{ id: 'uuid', label: 'UUID', hidden: true }
	]);

	const whitelistColumns: Column[] = $derived([
		{ id: 'name', label: t('web.access.colPlayer'), sortable: true, minWidth: 180 },
		{ id: 'coverage', label: t('web.moderation.colBackends'), sortable: true },
		{ id: 'uuid', label: 'UUID', hidden: true }
	]);

	const opColumns: Column[] = $derived([
		{ id: 'name', label: t('web.access.colPlayer'), sortable: true, minWidth: 180 },
		{ id: 'level', label: t('web.access.colLevel'), sortable: true, width: 90, align: 'right' },
		{ id: 'coverage', label: t('web.moderation.colBackends'), sortable: true },
		{ id: 'uuid', label: 'UUID', hidden: true }
	]);

	const netBanColumns: Column[] = $derived([
		{ id: 'ip', label: t('web.access.colAddress'), sortable: true, minWidth: 160 },
		{ id: 'reason', label: t('web.access.colReason') },
		{ id: 'actor', label: t('web.moderation.colActor') },
		{ id: 'created', label: t('web.access.colBanned'), sortable: true },
		{ id: 'hits', label: t('web.moderation.colHits'), sortable: true, width: 150, align: 'right' },
		{ id: 'lastHit', label: t('web.moderation.colLastHit'), sortable: true }
	]);

	const ipBanColumns: Column[] = $derived([
		{ id: 'ip', label: t('web.access.colAddress'), sortable: true, minWidth: 160 },
		{ id: 'coverage', label: t('web.moderation.colBackends'), sortable: true },
		{ id: 'reason', label: t('web.access.colReason') },
		{ id: 'source', label: t('web.access.colBy') },
		{ id: 'created', label: t('web.access.colBanned'), sortable: true }
	]);

	const logFilters: TableFilterGroup<LogEntry>[] = $derived([
		{
			id: 'action',
			label: t('web.moderation.filterAction'),
			options: [
				{ value: 'any', label: t('web.moderation.anyAction') },
				...logActions.map((action) => ({
					value: action,
					label: action,
					match: (entry: LogEntry) => entry.action === action
				}))
			]
		}
	]);

	const banFilters: TableFilterGroup<BanRow>[] = $derived([
		{
			id: 'expiry',
			label: t('web.access.filterExpiry'),
			options: [
				{ value: 'any', label: t('web.access.anyExpiry') },
				{
					value: 'permanent',
					label: t('web.access.permanent'),
					match: (row: BanRow) => row.expires === 'forever'
				},
				{
					value: 'expiring',
					label: t('web.access.expiring'),
					match: (row: BanRow) => row.expires !== 'forever'
				}
			]
		}
	]);

	function logSortValue(entry: LogEntry, col: string): string | number | null {
		switch (col) {
			case 'time':
				return entry.atEpochMillis;

			case 'action':
				return entry.action;

			case 'target':
				return entry.targetName.toLowerCase();

			case 'actor':
				return entry.actor.toLowerCase();

			default:
				return null;
		}
	}

	function coverageSort(row: { instances: string[] }): number {
		return row.instances.length;
	}

	function banSortValue(row: BanRow, col: string): string | number | null {
		switch (col) {
			case 'name':
				return row.name.toLowerCase();

			case 'coverage':
				return coverageSort(row);

			case 'created':
				return row.created;

			default:
				return null;
		}
	}

	function whitelistSortValue(row: WhitelistRow, col: string): string | number | null {
		switch (col) {
			case 'name':
				return row.name.toLowerCase();

			case 'coverage':
				return coverageSort(row);

			default:
				return null;
		}
	}

	function opSortValue(row: OpRow, col: string): string | number | null {
		switch (col) {
			case 'name':
				return row.name.toLowerCase();

			case 'level':
				return row.level;

			case 'coverage':
				return coverageSort(row);

			default:
				return null;
		}
	}

	function netBanSortValue(row: NetBanRow, col: string): string | number | null {
		switch (col) {
			case 'ip':
				return row.ip;

			case 'created':
				return row.createdAtEpochMillis;

			case 'hits':
				return row.hits;

			case 'lastHit':
				return row.lastHitAtEpochMillis;

			default:
				return null;
		}
	}

	function ipBanSortValue(row: IpBanRow, col: string): string | number | null {
		switch (col) {
			case 'ip':
				return row.ip;

			case 'coverage':
				return coverageSort(row);

			case 'created':
				return row.created;

			default:
				return null;
		}
	}

	const headerCount = $derived.by(() => {
		switch (tab) {
			case 'logs':
				return String(logEntries.length);

			case 'bans':
				return `${selectedBans.size ? `${selectedBans.size}/` : ''}${bans.length}`;

			case 'whitelist':
				return `${selectedWhitelist.size ? `${selectedWhitelist.size}/` : ''}${whitelist.length}`;

			case 'ops':
				return `${selectedOps.size ? `${selectedOps.size}/` : ''}${ops.length}`;

			case 'netbans':
				return `${selectedNetBans.size ? `${selectedNetBans.size}/` : ''}${netBans.length}`;

			case 'ipbans':
				return `${selectedIpBans.size ? `${selectedIpBans.size}/` : ''}${ipBans.length}`;

			default:
				return '';
		}
	});
</script>

<svelte:head><title>{t('web.nav.moderation')} | Luna Console</title></svelte:head>

<PageHeader
	title={t('web.moderation.title')}
	count={headerCount}
	info
	description={t('web.moderation.description')}
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="players-moderation" />

		{#if tab === 'bans'}
			<Dropdown label={t('web.players.actions')} disabled={banSelection.length === 0} menu={banActions(banSelection)} />
			<Btn variant="primary" icon="gavel" onclick={() => openAdd('ban')}>{t('web.access.banPlayer')}</Btn>
		{:else if tab === 'whitelist'}
			<Dropdown label={t('web.players.actions')} disabled={whitelistSelection.length === 0} menu={whitelistActions(whitelistSelection)} />
			<Btn variant="primary" icon="plus" onclick={() => openAdd('whitelist-add')}>{t('web.access.addPlayer')}</Btn>
		{:else if tab === 'ops'}
			<Dropdown label={t('web.players.actions')} disabled={opSelection.length === 0} menu={opActions(opSelection)} />
			<Btn variant="primary" icon="plus" onclick={() => openAdd('op')}>{t('web.access.addOperator')}</Btn>
		{:else if tab === 'netbans'}
			<Dropdown label={t('web.players.actions')} disabled={netBanSelection.length === 0} menu={netBanActions(netBanSelection)} />
			<Btn variant="primary" icon="gavel" onclick={openNetBan}>{t('web.moderation.banOnNetwork')}</Btn>
		{:else if tab === 'ipbans'}
			<Dropdown label={t('web.players.actions')} disabled={ipBanSelection.length === 0} menu={ipBanActions(ipBanSelection)} />
			<Btn variant="primary" icon="gavel" onclick={() => openAdd('ban-ip')}>{t('web.access.banAddress')}</Btn>
		{/if}
	{/snippet}
</PageHeader>

{#if listsProblem}
	<Flash kind="error"><b>{t('web.access.unavailable')}</b> {listsProblem}</Flash>
{:else if unreachable.length > 0}
	<Flash kind="warning">
		<b>{t('web.moderation.someUnreachable')}</b>
		{unreachable.map((inst) => `${inst.name} (${inst.error})`).join(' · ')}
	</Flash>
{/if}

<OverviewBar title={t('web.moderation.overview')}>
	<OverviewCell label={t('web.moderation.backendsReporting')}>
		{reporting.length}/{summaries.length}
	</OverviewCell>
	<OverviewCell label={t('web.moderation.bannedPlayers')}>
		{bans.length}
	</OverviewCell>
	<OverviewCell label={t('web.moderation.tabNetBans')}>
		{#if netAvailable}
			{netBans.length}
		{:else}
			<span class="dim">–</span>
		{/if}
	</OverviewCell>
	<OverviewCell label={t('web.moderation.ipBans')}>
		{ipBans.length}
	</OverviewCell>
	<OverviewCell label={t('web.moderation.whitelisted')}>
		{whitelist.length}
	</OverviewCell>
	<OverviewCell label={t('web.moderation.operators')}>
		{ops.length}
	</OverviewCell>
	<OverviewCell label={t('web.moderation.logEntries')}>
		{#if logAvailable}
			{logTotal}
		{:else}
			<span class="dim">–</span>
		{/if}
	</OverviewCell>
</OverviewBar>

<div class="body">
	<Tabs {tabs} bind:active={tab} />

	{#if tab === 'logs'}
		{#if !logAvailable}
			<Flash kind="warning">
				<b>{t('web.moderation.logUnavailable')}</b>
				{logProblem}. {t('web.moderation.logNeedsBuild')}
			</Flash>
		{/if}

		<Panel flush>
			<ResourceTable
				tableId="moderation-log"
				initialSearch={page.url.searchParams.get('q') ?? ''}
				columns={logColumns}
				rows={logEntries}
				getId={(entry) => String(entry.id)}
				searchValue={(entry) =>
					`${entry.targetName} ${entry.targetUuid} ${entry.actor} ${entry.action} ${entry.server} ${entry.reason}`}
				searchPlaceholder={t('web.moderation.findLogEntry')}
				noun={t('web.moderation.nounEntry')}
				sortValue={logSortValue}
				filters={logFilters}
				rowActions={logRowActions}
				rowLabel={(entry) => entry.targetName || entry.action}
				pageSize={25}
				emptyTitle={t('web.moderation.noLogEntries')}
				emptyText={t('web.moderation.logHint')}
			>
				{#snippet cell(entry, col)}
					{#if col === 'time'}
						{fmtDateTime(entry.atEpochMillis)}
					{:else if col === 'action'}
						<b>{entry.action}</b>
					{:else if col === 'target'}
						{#if entry.targetUuid || entry.targetName}
							<PlayerName player={entry.targetUuid || entry.targetName} name={entry.targetName || entry.targetUuid} />
						{:else}
							<span class="dim">–</span>
						{/if}
					{:else if col === 'actor'}
						{entry.actor || '–'}
					{:else if col === 'server'}
						<span class="dim">{entry.server || '–'}</span>
					{:else if col === 'reason'}
						{entry.reason || '–'}
					{:else if col === 'details'}
						<span class="dim">{entry.details || '–'}</span>
					{/if}
				{/snippet}
			</ResourceTable>

			{#if logAvailable && logEntries.length < logTotal}
				<div class="more">
					<span class="dim">
						{t('web.moderation.loadedOf', { loaded: logEntries.length, total: logTotal })}
					</span>
					<Btn icon="arrowDown" disabled={logLoadingMore} onclick={() => void loadOlderLog()}>
						{t('web.moderation.loadOlder')}
					</Btn>
				</div>
			{/if}
		</Panel>
	{:else if tab === 'bans'}
		<Panel flush>
			<ResourceTable
				tableId="moderation-bans"
				columns={banColumns}
				rows={bans}
				getId={rowKey}
				searchValue={(row) => `${row.name} ${row.uuid} ${row.reason} ${row.source} ${row.instances.join(' ')}`}
				searchPlaceholder={t('web.access.findPlayer')}
				selectable="multi"
				bind:selected={selectedBans}
				rowActions={banRowActions}
				rowLabel={(row) => row.name}
				noun={t('web.access.nounBan')}
				sortValue={banSortValue}
				filters={banFilters}
				pageSize={25}
				emptyTitle={t('web.moderation.noBans')}
				emptyText={t('web.moderation.bansHint')}
			>
				{#snippet cell(row, col)}
					{#if col === 'name'}
						<PlayerName player={row.uuid || row.name} name={row.name} />
					{:else if col === 'coverage'}
						{@render coverage(row.instances)}
					{:else if col === 'reason'}
						{row.reason || '–'}
					{:else if col === 'source'}
						{row.source || '–'}
					{:else if col === 'created'}
						<span class="dim">{row.created || '–'}</span>
					{:else if col === 'expires'}
						{row.expires === 'forever' ? t('web.access.never') : row.expires || '–'}
					{:else if col === 'uuid'}
						<span class="mono dim">{row.uuid}</span>
					{/if}
				{/snippet}
			</ResourceTable>
		</Panel>
	{:else if tab === 'whitelist'}
		<Panel
			title={t('web.moderation.whitelistState')}
			description={t('web.moderation.whitelistStateHint')}
		>
			<div class="wlgrid">
				{#each summaries.filter((inst) => !inst.error) as inst (inst.name)}
					<span class="wlrow">
						<Toggle
							checked={inst.whitelistEnabled}
							label={inst.name}
							onchange={(checked) => void toggleWhitelistFor(inst.name, checked)}
						/>
						<a href="/instances/{inst.name}">{inst.name}</a>
						{#if inst.whitelistEnabled && inst.enforceWhitelist}
							<StatusBadge state="warning" label={t('web.access.enforced')} />
						{/if}
					</span>
				{/each}
			</div>
		</Panel>

		<Panel flush>
			<ResourceTable
				tableId="moderation-whitelist"
				columns={whitelistColumns}
				rows={whitelist}
				getId={rowKey}
				searchValue={(row) => `${row.name} ${row.uuid} ${row.instances.join(' ')}`}
				searchPlaceholder={t('web.access.findPlayer')}
				selectable="multi"
				bind:selected={selectedWhitelist}
				rowActions={whitelistRowActions}
				rowLabel={(row) => row.name}
				noun={t('web.access.nounPlayer')}
				sortValue={whitelistSortValue}
				pageSize={25}
				emptyTitle={t('web.moderation.noWhitelist')}
				emptyText={t('web.moderation.whitelistHint')}
			>
				{#snippet cell(row, col)}
					{#if col === 'name'}
						<PlayerName player={row.uuid || row.name} name={row.name} />
					{:else if col === 'coverage'}
						{@render coverage(row.instances)}
					{:else if col === 'uuid'}
						<span class="mono dim">{row.uuid}</span>
					{/if}
				{/snippet}
			</ResourceTable>
		</Panel>
	{:else if tab === 'ops'}
		<Panel flush>
			<ResourceTable
				tableId="moderation-ops"
				columns={opColumns}
				rows={ops}
				getId={rowKey}
				searchValue={(row) => `${row.name} ${row.uuid} ${row.instances.join(' ')}`}
				searchPlaceholder={t('web.access.findPlayer')}
				selectable="multi"
				bind:selected={selectedOps}
				rowActions={opRowActions}
				rowLabel={(row) => row.name}
				noun={t('web.access.nounOperator')}
				sortValue={opSortValue}
				pageSize={25}
				emptyTitle={t('web.moderation.noOps')}
				emptyText={t('web.access.operatorsHint')}
			>
				{#snippet cell(row, col)}
					{#if col === 'name'}
						<PlayerName player={row.uuid || row.name} name={row.name} />
					{:else if col === 'level'}
						{row.level}
					{:else if col === 'coverage'}
						{@render coverage(row.instances)}
					{:else if col === 'uuid'}
						<span class="mono dim">{row.uuid}</span>
					{/if}
				{/snippet}
			</ResourceTable>
		</Panel>
	{:else if tab === 'netbans'}
		{#if !netAvailable}
			<Flash kind="warning">
				<b>{t('web.moderation.netUnavailable')}</b>
				{netProblem}. {t('web.moderation.netNeedsBuild')}
			</Flash>
		{/if}

		<Panel flush>
			<ResourceTable
				tableId="moderation-netbans"
				columns={netBanColumns}
				rows={netBans}
				getId={(row) => row.ip}
				searchValue={(row) => `${row.ip} ${row.reason} ${row.actor}`}
				searchPlaceholder={t('web.access.findAddress')}
				selectable="multi"
				bind:selected={selectedNetBans}
				rowActions={netBanRowActions}
				rowLabel={(row) => row.ip}
				noun={t('web.access.nounIpBan')}
				sortValue={netBanSortValue}
				pageSize={25}
				emptyTitle={t('web.moderation.noNetBans')}
				emptyText={t('web.moderation.netBansHint')}
			>
				{#snippet cell(row, col)}
					{#if col === 'ip'}
						<span class="mono"><b>{row.ip}</b></span>
					{:else if col === 'reason'}
						{row.reason || '–'}
					{:else if col === 'actor'}
						{row.actor || '–'}
					{:else if col === 'created'}
						<span class="dim">{row.createdAtEpochMillis ? fmtDateTime(row.createdAtEpochMillis) : '–'}</span>
					{:else if col === 'hits'}
						{row.hits || '–'}
					{:else if col === 'lastHit'}
						{#if row.lastHitAtEpochMillis}
							{fmtDateTime(row.lastHitAtEpochMillis)}
						{:else}
							<span class="dim">–</span>
						{/if}
					{/if}
				{/snippet}
			</ResourceTable>
		</Panel>
	{:else if tab === 'ipbans'}
		<Panel flush>
			<ResourceTable
				tableId="moderation-ipbans"
				columns={ipBanColumns}
				rows={ipBans}
				getId={(row) => row.ip}
				searchValue={(row) => `${row.ip} ${row.reason} ${row.source} ${row.instances.join(' ')}`}
				searchPlaceholder={t('web.access.findAddress')}
				selectable="multi"
				bind:selected={selectedIpBans}
				rowActions={ipBanRowActions}
				rowLabel={(row) => row.ip}
				noun={t('web.access.nounIpBan')}
				sortValue={ipBanSortValue}
				pageSize={25}
				emptyTitle={t('web.moderation.noIpBans')}
				emptyText={t('web.moderation.ipBansHint')}
			>
				{#snippet cell(row, col)}
					{#if col === 'ip'}
						<span class="mono"><b>{row.ip}</b></span>
					{:else if col === 'coverage'}
						{@render coverage(row.instances)}
					{:else if col === 'reason'}
						{row.reason || '–'}
					{:else if col === 'source'}
						{row.source || '–'}
					{:else if col === 'created'}
						<span class="dim">{row.created || '–'}</span>
					{/if}
				{/snippet}
			</ResourceTable>
		</Panel>
	{/if}
</div>

{#snippet coverage(instances: string[])}
	{#if instances.length >= reporting.length && reporting.length > 0}
		<span class="dim">{t('web.moderation.everywhere')} ({instances.length})</span>
	{:else}
		<span class="info-trigger" title={instances.join(', ')}>
			{instances.length}/{reporting.length}
		</span>
	{/if}
{/snippet}

<Modal title={t('web.moderation.netBanTitle')} bind:open={netBanOpen}>
	<div class="stack">
		<label class="field">
			<span class="lbl">{t('web.access.colAddress')}</span>
			<span class="hint">{t('web.moderation.netBansHint')}</span>
			<input class="input" bind:value={netBanIp} placeholder={t('web.access.ipAddress')} />
		</label>

		<label class="field">
			<span class="lbl">{t('web.access.colReason')}</span>
			<input class="input" bind:value={netBanReason} placeholder={t('web.access.reasonOptional')} />
		</label>
	</div>

	{#snippet footer()}
		<Btn onclick={() => (netBanOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="danger" icon="gavel" disabled={!netBanIp.trim()} onclick={submitNetBan}>
			{t('web.moderation.actionNetBan')}
		</Btn>
	{/snippet}
</Modal>

<ConfirmModal
	bind:open={promoteOpen}
	title={t('web.moderation.promoteTitle')}
	lead={t('web.moderation.promoteLead', { count: promoteRows.length })}
	notes={[t('web.moderation.promoteNote')]}
	confirmLabel={t('web.moderation.actionNetBan')}
	onconfirm={submitPromote}
>
	<p class="targets">{promoteRows.map((row) => row.ip).join(', ')}</p>
</ConfirmModal>

<Modal
	title={t('web.moderation.modalTargets', {
		label: ACTION_LABELS[moderateAction] ?? moderateAction,
		count: targetCount
	})}
	bind:open={moderateOpen}
>
	<div class="stack">
		{#if addMode}
			{#if targetsIp}
				<label class="field">
					<span class="lbl">{t('web.access.colAddress')}</span>
					<input class="input" bind:value={addTarget} placeholder={t('web.access.ipAddress')} />
				</label>
			{:else}
				<div class="field">
					<span class="lbl">{t('web.access.colPlayer')}</span>
					{#key moderateOpen}
						<PlayerPicker
							bind:value={addTarget}
							pickValue="username"
							placeholder={t('web.access.pickerPlaceholder')}
							onpick={(player) => (addUuid = player?.uuid ?? '')}
						/>
					{/key}
				</div>
			{/if}
		{:else}
			<p class="targets">
				{moderateTargets.map((target) => target.name).join(', ')}
			</p>
		{/if}

		<div class="field">
			<span class="lbl">{t('web.nav.instancesList')}</span>
			<span class="hint">{t('web.players.instancesHint')}</span>
			<MultiSelect
				bind:value={moderateInstances}
				width="100%"
				options={reporting.map((name) => ({ value: name, label: name }))}
			/>
		</div>

		{#if needsReason}
			<label class="field">
				<span class="lbl">{t('web.access.colReason')}</span>
				<span class="hint">{t('web.players.reasonHint')}</span>
				<input class="input" bind:value={moderateReason} placeholder={t('web.players.eGGriefingOnSurvival')} />
			</label>
		{/if}
	</div>

	{#snippet footer()}
		<Btn onclick={() => (moderateOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn
			variant={['ban', 'ban-ip'].includes(moderateAction) ? 'danger' : 'primary'}
			disabled={moderateInstances.length === 0 || (addMode && !addTarget.trim())}
			onclick={doModerate}
		>
			{ACTION_LABELS[moderateAction] ?? t('web.common.apply')}
		</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.body {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		margin-top: 1rem;
	}

	.more {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		padding: 0.75rem 1rem;
		border-top: 0.1rem solid var(--border);
	}

	.wlgrid {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem 1.5rem;
	}

	.wlrow {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}

	.stack {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.targets {
		color: var(--text-secondary);
		word-break: break-word;
	}
</style>
