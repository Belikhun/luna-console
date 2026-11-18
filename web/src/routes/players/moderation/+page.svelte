<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { api, post } from '$lib/api';
	import { firewallHref } from '$lib/firewall';
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
	import StatGrid from '$lib/components/StatGrid.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import DetailPanel from '$lib/components/DetailPanel.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import InfoPopover from '$lib/components/InfoPopover.svelte';
	import type { InfoCell } from '$lib/components/grid';
	import Modal from '$lib/components/Modal.svelte';
	import FirewallBanModal from '$lib/components/FirewallBanModal.svelte';
	import DateTime from '$lib/components/DateTime.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import PlayerName from '$lib/components/PlayerName.svelte';
	import PlayerPicker from '$lib/components/PlayerPicker.svelte';
	import { menuGroups, type ContextMenuItem } from '$lib/components/contextmenu';
	import { Notify } from '$lib/notifications.svelte';

	import LogTab from './LogTab.svelte';
	import {
		MODERATION_TABS,
		moderationHref,
		targetHref,
		targetIsAddress,
		type BanRow,
		type InstanceSummary,
		type IpBanRow,
		type LogEntry,
		type ModerationTab,
		type OpRow,
		type WhitelistRow
	} from './moderation';

	/**
	 * Network-wide moderation: the whole cluster's moderation history from
	 * LunaCore, and every backend's bans, whitelist, operators and IP bans
	 * folded into one row per target, so an operator manages the network here
	 * instead of opening eight instance tabs. Mutations go through the same
	 * fan-out the players screen uses (POST /api/players/moderate).
	 */

	/** LunaCore pages at 200 max; older entries load on demand. */
	const LOG_PAGE = 200;

	const tab: ModerationTab = $derived.by(() => {
		const wanted = page.url.searchParams.get('tab') as ModerationTab | null;

		return wanted && MODERATION_TABS.includes(wanted)
			? wanted
			: 'logs';
	});

	let summaries: InstanceSummary[] = $state([]);
	let bans: BanRow[] = $state([]);
	let ipBans: IpBanRow[] = $state([]);
	let whitelist: WhitelistRow[] = $state([]);
	let ops: OpRow[] = $state([]);
	let listsProblem = $state('');

	let netBanCount = $state(0);
	let netAvailable = $state(true);
	let netProblem = $state('');

	let logEntries: LogEntry[] = $state([]);
	let logTotal = $state(0);
	let logActions: string[] = $state([]);
	let logAvailable = $state(true);
	let logProblem = $state('');
	let logLoadingMore = $state(false);

	let loading = $state(true);
	let loaded = $state(false);
	let lastUpdated: number | null = $state(null);

	let selectedBans: Set<string> = $state(new Set());
	let selectedWhitelist: Set<string> = $state(new Set());
	let selectedOps: Set<string> = $state(new Set());
	let selectedIpBans: Set<string> = $state(new Set());

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
			// the list lives on the firewall screen; moderation only counts it
			const data = await api('/firewall/bans');

			if (data.available === false) {
				netAvailable = false;
				netProblem = data.error ?? 'LunaCore is unreachable';
				return;
			}

			netAvailable = true;
			netProblem = '';
			netBanCount = (data.bans ?? []).length;
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
		loaded = true;
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

	let promoteOpen = $state(false);
	let promoteIps: string[] = $state([]);
	let promoteReason = $state('');

	function openPromote(rows: IpBanRow[]): void {
		promoteIps = rows.map((row) => row.ip);
		// a lone row carries its reason up; a mixed selection would misattribute one
		promoteReason = rows.length === 1
			? (rows[0]?.reason ?? '')
			: '';
		promoteOpen = true;
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

	/** A player row's own verbs, the open and copy groups around the list's verbs. */
	interface ProfileGroups {
		open: ContextMenuItem[];
		copy: ContextMenuItem[];
	}

	const NO_PROFILE: ProfileGroups = { open: [], copy: [] };

	function banActions(rows: BanRow[], profile: ProfileGroups = NO_PROFILE): ContextMenuItem[] {
		const none = rows.length === 0;

		return menuGroups(
			profile.open,
			[
				{
					label: t('web.players.pardon'),
					icon: 'handshake',
					disabled: none,
					action: () => openModerate('pardon', playerTargets(rows), coveredInstances(rows))
				}
			],
			profile.copy,
			[
				{
					label: t('web.moderation.banOnAll'),
					icon: 'gavel',
					color: 'danger',
					disabled: none || fullyCovered(rows),
					hint: !none && fullyCovered(rows) ? t('web.moderation.everywhere') : undefined,
					action: () => openModerate('ban', playerTargets(rows), [...reporting])
				}
			]
		);
	}

	function whitelistActions(rows: WhitelistRow[], profile: ProfileGroups = NO_PROFILE): ContextMenuItem[] {
		const none = rows.length === 0;

		return menuGroups(
			profile.open,
			[
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
			],
			profile.copy
		);
	}

	function opActions(rows: OpRow[], profile: ProfileGroups = NO_PROFILE): ContextMenuItem[] {
		const none = rows.length === 0;

		return menuGroups(
			profile.open,
			[
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
			],
			profile.copy
		);
	}

	function ipBanActions(rows: IpBanRow[]): ContextMenuItem[] {
		const none = rows.length === 0;

		return menuGroups(
			[
				{
					label: t('web.moderation.pardonAddress'),
					icon: 'handshake',
					disabled: none,
					action: () => openModerate('pardon-ip', rows.map((row) => ({ name: row.ip })), coveredInstances(rows))
				}
			],
			[
				{
					label: t('web.moderation.ipBanOnAll'),
					icon: 'gavel',
					color: 'danger',
					disabled: none || fullyCovered(rows),
					hint: !none && fullyCovered(rows) ? t('web.moderation.everywhere') : undefined,
					action: () => openModerate('ban-ip', rows.map((row) => ({ name: row.ip })), [...reporting])
				},
				{
					label: t('web.moderation.promoteToNetwork'),
					icon: 'sitemap',
					color: 'danger',
					disabled: none,
					action: () => openPromote(rows)
				}
			]
		);
	}

	function profileVerbs(uuid: string, name: string): ProfileGroups {
		const open: ContextMenuItem[] = [
			{
				label: t('web.players.viewProfile'),
				icon: 'user',
				action: () => goto(`/players/${uuid || name}`)
			}
		];

		const copyGroup: ContextMenuItem[] = uuid
			? [
					{
						id: 'copy-uuid',
						label: t('web.players.copyUuid'),
						icon: 'copy',
						action: () => void copy(uuid)
					}
				]
			: [];

		return { open, copy: copyGroup };
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

		return banActions(rows, profileVerbs(row.uuid, row.name));
	}

	function whitelistRowActions(row: WhitelistRow): ContextMenuItem[] {
		const rows = pick(row, whitelistSelection, selectedWhitelist.has(rowKey(row)));

		return whitelistActions(rows, profileVerbs(row.uuid, row.name));
	}

	function opRowActions(row: OpRow): ContextMenuItem[] {
		const rows = pick(row, opSelection, selectedOps.has(rowKey(row)));

		return opActions(rows, profileVerbs(row.uuid, row.name));
	}

	function ipBanRowActions(row: IpBanRow): ContextMenuItem[] {
		const rows = pick(row, ipBanSelection, selectedIpBans.has(row.ip));

		return ipBanActions(rows);
	}

	function logRowActions(entry: LogEntry): ContextMenuItem[] {
		if (!entry.targetUuid && !entry.targetName) {
			return [];
		}

		// an address has no profile; the firewall is where it can be looked up
		if (targetIsAddress(entry)) {
			return menuGroups(
				[
					{
						label: t('web.moderation.log.checkAddress'),
						icon: 'magnifyingGlass',
						action: () => goto(targetHref(entry) ?? firewallHref('check'))
					}
				],
				[
					{
						id: 'copy-address',
						label: t('web.moderation.log.copyAddress'),
						icon: 'copy',
						action: () => void copy(entry.targetName)
					}
				]
			);
		}

		const profile = profileVerbs(entry.targetUuid, entry.targetName);

		return menuGroups(profile.open, profile.copy);
	}

	// -- tables -----------------------------------------------------------------

	const TAB_LABELS: Record<ModerationTab, string> = {
		logs: 'web.moderation.tabLogs',
		bans: 'web.moderation.tabBans',
		whitelist: 'web.moderation.tabWhitelist',
		ops: 'web.moderation.tabOps',
		ipbans: 'web.moderation.tabIpBans'
	};

	const tabs = $derived(MODERATION_TABS.map((id) => ({
		id,
		label: t(TAB_LABELS[id]),
		href: moderationHref(id)
	})));

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

	const ipBanColumns: Column[] = $derived([
		{ id: 'ip', label: t('web.access.colAddress'), sortable: true, minWidth: 160 },
		{ id: 'coverage', label: t('web.moderation.colBackends'), sortable: true },
		{ id: 'reason', label: t('web.access.colReason') },
		{ id: 'source', label: t('web.access.colBy') },
		{ id: 'created', label: t('web.access.colBanned'), sortable: true }
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

			case 'ipbans':
				return `${selectedIpBans.size ? `${selectedIpBans.size}/` : ''}${ipBans.length}`;

			default:
				return '';
		}
	});

	// -- the figures above the tabs ----------------------------------------------

	const WEEK_MS = 7 * 86_400_000;

	const permanentBans = $derived(bans.filter((row) => row.expires === 'forever').length);
	const whitelistOn = $derived(summaries.filter((inst) => !inst.error && inst.whitelistEnabled).length);

	/** Entries of the last seven days; null while the loaded page may not reach that far back. */
	const logThisWeek: number | null = $derived.by(() => {
		const since = Date.now() - WEEK_MS;
		const recent = logEntries.filter((entry) => entry.atEpochMillis >= since).length;

		return recent < logEntries.length || logEntries.length >= logTotal
			? recent
			: null;
	});

	// -- one selected row, read in full ------------------------------------------

	let panelLocation = $state<'bottom' | 'right'>('bottom');
	let panelSize = $state(34);

	interface RowDetail {
		title: string;
		subtitle: string;
		/** A player's profile; an address has none */
		href?: string;
		cells: InfoCell[];
		instances: string[];
		close: () => void;
	}

	function banCells(row: BanRow | IpBanRow): InfoCell[] {
		return [
			{ label: t('web.access.colReason'), value: row.reason || '–', colSpan: 2 },
			{ label: t('web.access.colBy'), value: row.source || '–' },
			{ label: t('web.access.colBanned'), value: row.created || '–', time: row.created || null },
			row.expires === 'forever' || !row.expires
				? { label: t('web.access.colExpires'), value: t('web.access.never') }
				: { label: t('web.access.colExpires'), value: row.expires, time: row.expires }
		];
	}

	function uuidCell(uuid: string): InfoCell[] {
		return uuid
			? [{ label: 'UUID', value: uuid, style: 'mono', copyable: true, colSpan: 2 }]
			: [];
	}

	function profileHref(row: { uuid: string; name: string }): string {
		return `/players/${row.uuid || row.name}`;
	}

	const detail: RowDetail | null = $derived.by(() => {
		if (tab === 'bans' && banSelection.length === 1) {
			const row = banSelection[0]!;

			return {
				title: row.name,
				subtitle: t('web.moderation.detail.ban'),
				href: profileHref(row),
				cells: [...banCells(row), ...uuidCell(row.uuid)],
				instances: row.instances,
				close: () => (selectedBans = new Set())
			};
		}

		if (tab === 'whitelist' && whitelistSelection.length === 1) {
			const row = whitelistSelection[0]!;

			return {
				title: row.name,
				subtitle: t('web.moderation.detail.whitelist'),
				href: profileHref(row),
				cells: uuidCell(row.uuid),
				instances: row.instances,
				close: () => (selectedWhitelist = new Set())
			};
		}

		if (tab === 'ops' && opSelection.length === 1) {
			const row = opSelection[0]!;

			return {
				title: row.name,
				subtitle: t('web.moderation.detail.op'),
				href: profileHref(row),
				cells: [
					{ label: t('web.access.colLevel'), value: row.level },
					{
						label: t('web.moderation.detail.bypassesLimit'),
						value: row.bypassesPlayerLimit ? t('web.common.yes') : t('web.common.no')
					},
					...uuidCell(row.uuid)
				],
				instances: row.instances,
				close: () => (selectedOps = new Set())
			};
		}

		if (tab === 'ipbans' && ipBanSelection.length === 1) {
			const row = ipBanSelection[0]!;

			return {
				title: row.ip,
				subtitle: t('web.moderation.detail.ipBan'),
				cells: banCells(row),
				instances: row.instances,
				close: () => (selectedIpBans = new Set())
			};
		}

		return null;
	});

	const detailMissing = $derived(
		detail
			? reporting.filter((name) => !detail.instances.includes(name))
			: []
	);

	/** The detail's cells, then where the entry applies and where it does not. */
	const detailCells: InfoCell[] = $derived.by(() => {
		if (!detail) {
			return [];
		}

		return [
			...detail.cells,
			{
				id: 'applies',
				label: t('web.moderation.detail.appliesOn', { count: detail.instances.length }),
				colSpan: 'all'
			},
			...(detailMissing.length > 0
				? [{ id: 'missing', label: t('web.moderation.detail.missingOn', { count: detailMissing.length }), colSpan: 'all' as const }]
				: [])
		];
	});
</script>

<svelte:head><title>{t('web.nav.moderation')} | Luna Console</title></svelte:head>

<PageHeader
	title={t('web.moderation.title')}
	count={headerCount}
	info={t('web.guide.moderation')}
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

<StatGrid min={10}>
	<StatTile
		label={t('web.moderation.tile.bans')}
		value={loaded && !listsProblem ? bans.length : null}
		secondary={permanentBans > 0 ? t('web.moderation.tile.permanent', { count: permanentBans }) : undefined}
		href={moderationHref('bans')}
		loading={!loaded}
	/>
	<StatTile
		label={t('web.moderation.tile.netBans')}
		value={loaded && netAvailable ? netBanCount : null}
		secondary={netAvailable ? t('web.moderation.tile.netBansWhere') : t('web.moderation.tile.proxyOffline')}
		href={firewallHref('bans')}
		loading={!loaded}
	/>
	<StatTile
		label={t('web.moderation.tile.ipBans')}
		value={loaded && !listsProblem ? ipBans.length : null}
		href={moderationHref('ipbans')}
		loading={!loaded}
	/>
	<StatTile
		label={t('web.moderation.tile.whitelisted')}
		value={loaded && !listsProblem ? whitelist.length : null}
		secondary={reporting.length > 0
			? t('web.moderation.tile.whitelistOn', { on: whitelistOn, total: reporting.length })
			: undefined}
		href={moderationHref('whitelist')}
		loading={!loaded}
	/>
	<StatTile
		label={t('web.moderation.tile.operators')}
		value={loaded && !listsProblem ? ops.length : null}
		href={moderationHref('ops')}
		loading={!loaded}
	/>
	<StatTile
		label={t('web.moderation.tile.logEntries')}
		value={loaded && logAvailable ? logTotal : null}
		secondary={!logAvailable
			? t('web.moderation.tile.proxyOffline')
			: loaded && logThisWeek !== null
				? t('web.moderation.tile.thisWeek', { count: logThisWeek })
				: undefined}
		href={moderationHref('logs')}
		loading={!loaded}
	/>
	<StatTile
		label={t('web.moderation.tile.backends')}
		value={loaded && !listsProblem ? reporting.length : null}
		secondary={loaded ? t('web.moderation.tile.backendsOf', { total: summaries.length }) : undefined}
		tone={unreachable.length > 0 ? 'warning' : 'default'}
		info={t('web.moderation.tile.backendsInfo')}
		loading={!loaded}
	/>
</StatGrid>

<div class="tabs">
	<Tabs {tabs} active={tab} />
</div>

<div class="body">
	{#if tab === 'logs'}
		<LogTab
			entries={logEntries}
			total={logTotal}
			actions={logActions}
			available={logAvailable}
			problem={logProblem}
			{loaded}
			loadingMore={logLoadingMore}
			initialSearch={page.url.searchParams.get('q') ?? ''}
			rowActions={logRowActions}
			onloadolder={() => void loadOlderLog()}
		/>
	{:else if tab === 'bans'}
		<Panel
			title={t('web.moderation.tabBans')}
			count={loaded ? bans.length : undefined}
			description={t('web.moderation.bansHint')}
			flush
		>
			<ResourceTable
				tableId="moderation-bans"
				loading={!loaded}
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
				defaultSort={{ col: 'created', dir: 'desc' }}
				filters={banFilters}
				pageSize={25}
				emptyTitle={t('web.moderation.noBans')}
				emptyAction={bans.length === 0 ? banFirst : undefined}
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
						<span class="dim"><DateTime at={row.created} text={row.created} empty={row.created || '–'} /></span>
					{:else if col === 'expires'}
						{#if row.expires === 'forever'}
							{t('web.access.never')}
						{:else}
							<DateTime at={row.expires} text={row.expires} empty={row.expires || '–'} />
						{/if}
					{:else if col === 'uuid'}
						<span class="mono dim">{row.uuid}</span>
					{/if}
				{/snippet}
			</ResourceTable>
		</Panel>
	{:else if tab === 'whitelist'}
		<Panel
			title={t('web.moderation.whitelistState')}
			count={loaded ? t('web.moderation.whitelistOnCount', { on: whitelistOn, total: reporting.length }) : undefined}
			description={t('web.moderation.whitelistStateHint')}
		>
			{#if reporting.length === 0}
				<span class="dim">{loaded ? t('web.moderation.noBackends') : t('web.common.loading')}</span>
			{:else}
				<div class="switches">
					{#each summaries.filter((inst) => !inst.error) as inst (inst.name)}
						<span class="switch">
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
			{/if}
		</Panel>

		<Panel
			title={t('web.moderation.tabWhitelist')}
			count={loaded ? whitelist.length : undefined}
			description={t('web.moderation.whitelistHint')}
			flush
		>
			<ResourceTable
				tableId="moderation-whitelist"
				loading={!loaded}
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
				defaultSort={{ col: 'name', dir: 'asc' }}
				pageSize={25}
				emptyTitle={t('web.moderation.noWhitelist')}
				emptyAction={whitelist.length === 0 ? whitelistFirst : undefined}
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
		<Panel
			title={t('web.moderation.tabOps')}
			count={loaded ? ops.length : undefined}
			description={t('web.access.operatorsHint')}
			flush
		>
			<ResourceTable
				tableId="moderation-ops"
				loading={!loaded}
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
				defaultSort={{ col: 'name', dir: 'asc' }}
				pageSize={25}
				emptyTitle={t('web.moderation.noOps')}
				emptyAction={ops.length === 0 ? opFirst : undefined}
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
	{:else if tab === 'ipbans'}
		<Panel
			title={t('web.moderation.tabIpBans')}
			count={loaded ? ipBans.length : undefined}
			description={t('web.moderation.ipBansScope')}
			flush
		>
			<ResourceTable
				tableId="moderation-ipbans"
				loading={!loaded}
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
				defaultSort={{ col: 'created', dir: 'desc' }}
				pageSize={25}
				emptyTitle={t('web.moderation.noIpBans')}
				emptyAction={ipBans.length === 0 ? ipBanFirst : undefined}
			>
				{#snippet cell(row, col)}
					{#if col === 'ip'}
						<b class="mono">{row.ip}</b>
					{:else if col === 'coverage'}
						{@render coverage(row.instances)}
					{:else if col === 'reason'}
						{row.reason || '–'}
					{:else if col === 'source'}
						{row.source || '–'}
					{:else if col === 'created'}
						<span class="dim"><DateTime at={row.created} text={row.created} empty={row.created || '–'} /></span>
					{/if}
				{/snippet}
			</ResourceTable>
		</Panel>
	{/if}
</div>

{#snippet banFirst()}
	<Btn icon="gavel" onclick={() => openAdd('ban')}>{t('web.access.banPlayer')}</Btn>
{/snippet}

{#snippet whitelistFirst()}
	<Btn icon="plus" onclick={() => openAdd('whitelist-add')}>{t('web.access.addPlayer')}</Btn>
{/snippet}

{#snippet opFirst()}
	<Btn icon="plus" onclick={() => openAdd('op')}>{t('web.access.addOperator')}</Btn>
{/snippet}

{#snippet ipBanFirst()}
	<Btn icon="gavel" onclick={() => openAdd('ban-ip')}>{t('web.access.banAddress')}</Btn>
{/snippet}

{#snippet coverage(instances: string[])}
	{#if instances.length >= reporting.length && reporting.length > 0}
		<span class="dim">{t('web.moderation.allBackends', { count: instances.length })}</span>
	{:else}
		<InfoPopover detail={instances}>
			{t('web.moderation.someBackends', { count: instances.length, total: reporting.length })}
		</InfoPopover>
	{/if}
{/snippet}

{#snippet backendLinks(names: string[])}
	<span class="backends">
		{#each names as name (name)}
			<a href="/instances/{name}">{name}</a>
		{/each}
	</span>
{/snippet}

{#if detail}
	<DetailPanel
		title={detail.title}
		subtitle={detail.subtitle}
		href={detail.href}
		hrefLabel={t('web.players.viewProfile')}
		bind:location={panelLocation}
		bind:size={panelSize}
		onclose={detail.close}
	>
		<InfoGrid cells={detailCells} columns={[4, 2, 1]}>
			{#snippet custom(info)}
				{#if info.id === 'applies'}
					{@render backendLinks(detail.instances)}
				{:else if info.id === 'missing'}
					{@render backendLinks(detailMissing)}
				{/if}
			{/snippet}
		</InfoGrid>
	</DetailPanel>
{/if}

<FirewallBanModal bind:open={promoteOpen} addresses={promoteIps} reason={promoteReason} onbanned={refreshNetBans} />

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
					<input class="input mono" bind:value={addTarget} placeholder={t('web.access.ipAddress')} spellcheck="false" autocomplete="off" />
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
			<div class="field">
				<span class="lbl">{t(targetsIp ? 'web.moderation.modalAddresses' : 'web.moderation.modalPlayers')}</span>
				<div class="targets">
					{#each moderateTargets as target (target.uuid ?? target.name)}
						<span class="target" class:mono={targetsIp}>{target.name}</span>
					{/each}
				</div>
			</div>
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
	.tabs {
		margin-top: 1rem;
	}

	.body {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		margin-top: 1rem;
	}

	// one switch per backend, in columns so the names line up
	.switches {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
		gap: 0.75rem 1.5rem;
	}

	.switch {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}

	.backends {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1rem;
	}

	.stack {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	// who the verb applies to, as chips: a long selection wraps instead of running on
	.targets {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
		max-height: 8rem;
		overflow-y: auto;
	}

	.target {
		padding: 0.125rem 0.5rem;
		border: var(--hairline) solid var(--border);
		border-radius: 0.25rem;
		color: var(--text-secondary);
		font-size: 0.875rem;
	}
</style>
