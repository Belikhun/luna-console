<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { onMount } from 'svelte';
	import { beforeNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';

	import { api, post } from '$lib/api';
	import { Authz } from '$lib/authz.svelte';
	import { countryName, FIREWALL_TABS, firewallHref, ruleSummary, ruleTitle, type FirewallTab } from '$lib/firewall';
	import { fmtDateTime } from '$lib/format';
	import { t } from '$lib/i18n.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import CellStack from '$lib/components/CellStack.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import DateTime from '$lib/components/DateTime.svelte';
	import DetailPanel from '$lib/components/DetailPanel.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import FirewallBanModal from '$lib/components/FirewallBanModal.svelte';
	import FirewallMatchers from '$lib/components/FirewallMatchers.svelte';
	import FirewallRuleModal from '$lib/components/FirewallRuleModal.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import GeoAttribution from '$lib/components/GeoAttribution.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import InfoPopover from '$lib/components/InfoPopover.svelte';
	import OverviewBar from '$lib/components/OverviewBar.svelte';
	import OverviewCell from '$lib/components/OverviewCell.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import Tabs from '$lib/components/Tabs.svelte';
	import Toggle from '$lib/components/Toggle.svelte';
	import { menuGroups, type ContextMenuItem } from '$lib/components/contextmenu';
	import type { InfoCell } from '$lib/components/grid';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import { FIREWALL_DETECTORS, type FirewallOverview, type FirewallRule, type FirewallRuleInput } from '$shared/firewall';

	import ActivityTab from './ActivityTab.svelte';
	import AutoBanTab from './AutoBanTab.svelte';
	import BansTab from './BansTab.svelte';
	import CheckTab from './CheckTab.svelte';
	import OfflineTab from './OfflineTab.svelte';

	/**
	 * The proxy's firewall: who it turned away and why, the addresses it bans,
	 * the allow and deny rules, the detectors that ban on their own, and a check
	 * of what it would do with one address. LunaCore enforces all of it; this
	 * screen reads and changes what LunaCore holds.
	 */

	type Overview = FirewallOverview & { reachable: boolean; supported: boolean; error?: string; you: string | null };

	const tab = $derived.by((): FirewallTab => {
		const wanted = page.url.searchParams.get('tab') as FirewallTab | null;

		return wanted && FIREWALL_TABS.includes(wanted)
			? wanted
			: 'activity';
	});

	let overview = $state<Overview | null>(null);
	let loading = $state(false);
	let loaded = $state(false);
	let lastUpdated = $state<number | null>(null);
	let selected = $state<Set<string>>(new Set());
	let activeBans = $state<Set<string>>(new Set());

	let bansTab = $state<BansTab>();
	let checkTab = $state<CheckTab>();
	let activityTab = $state<ActivityTab>();
	let autoTab = $state<AutoBanTab>();
	let pickedBans = $state<Array<{ id: string; ip: string }>>([]);
	let bansTotal = $state<number | undefined>();
	let refusedTotal = $state<number | undefined>();
	let autoDirty = $state(false);

	let editorOpen = $state(false);
	let editing = $state<FirewallRule | null>(null);
	let preset = $state<Partial<FirewallRuleInput> | undefined>();
	let banOpen = $state(false);
	let banAddresses = $state<string[]>([]);
	let banReason = $state('');
	let deleteOpen = $state(false);
	let deleting = $state<FirewallRule[]>([]);
	let leaveOpen = $state(false);
	let leaveTo = $state<string | null>(null);
	let panelLocation = $state<'bottom' | 'right'>('bottom');
	let panelSize = $state(42);

	const canConfigure = $derived(Authz.can('firewall:Configure'));
	const canBan = $derived(Authz.can('player:Moderate'));
	const configureReason = $derived(canConfigure ? undefined : t('web.common.notAllowed', { action: 'firewall:Configure' }));
	const banDenied = $derived(canBan ? undefined : t('web.common.notAllowed', { action: 'player:Moderate' }));

	const usable = $derived(!!overview && overview.reachable && overview.supported);
	const offlineReason = $derived(usable ? undefined : t('web.firewall.offlineReason'));
	const rules = $derived(usable ? overview!.rules : []);
	const countriesHeld = $derived(usable ? Object.keys(overview!.countries).length > 0 : false);
	const missingCountries = $derived(rules.some((rule) => rule.enabled && rule.countries.some((code) => !overview?.countries[code])));

	async function refresh(): Promise<void> {
		loading = true;

		try {
			overview = await api('/firewall');
			lastUpdated = Date.now();

			const bans = await api('/firewall/bans').catch(() => null);

			activeBans = new Set((bans?.bans ?? []).map((ban: { ip: string }) => ban.ip));

			if (tab === 'bans') {
				void bansTab?.load();
			} else if (tab === 'activity') {
				void activityTab?.load();
			} else if (tab === 'check') {
				void checkTab?.load();
			}
		} catch (err) {
			Notify.error(t('web.firewall.loadFailed', { message: (err as Error).message }));
		} finally {
			loading = false;
			loaded = true;
		}
	}

	onMount(() => {
		void refresh();
	});

	// unsaved settings are asked about before any link leaves them
	beforeNavigate((navigation) => {
		if (!autoDirty || navigation.willUnload || !navigation.to) {
			return;
		}

		navigation.cancel();
		leaveTo = navigation.to.url.pathname + navigation.to.url.search;
		leaveOpen = true;
	});

	function leave(): void {
		const to = leaveTo;

		autoTab?.discard();
		autoDirty = false;
		leaveTo = null;

		if (to) {
			void goto(to);
		}
	}

	function openEditor(rule: FirewallRule | null, from?: Partial<FirewallRuleInput>): void {
		editing = rule;
		preset = from;
		editorOpen = true;
	}

	function openRuleById(id: string): void {
		const rule = rules.find((entry) => entry.id === id);

		if (rule) {
			openEditor(rule);
		}
	}

	function openBan(addresses: string[] = [], reason = ''): void {
		banAddresses = addresses;
		banReason = reason;
		banOpen = true;
	}

	async function saveRule(body: FirewallRuleInput): Promise<void> {
		const result = await post('/firewall/rules', { action: 'save', rule: body });
		const unknown: string[] = result.countries?.unknown ?? [];

		Notify.success(t('web.firewall.rules.saved'), {
			detail: unknown.length > 0
				? t('web.firewall.rules.unknownCountries', { countries: unknown.join(', ') })
				: result.countries?.error
					? t('web.firewall.rules.countriesFailed', { message: result.countries.error })
					: undefined
		});
		await refresh();
	}

	/** One change to several rules; says how it went, one line per rule that failed. */
	async function runOnRules(targets: FirewallRule[], action: 'enable' | 'disable' | 'remove', done: string): Promise<void> {
		if (targets.length === 0) {
			return;
		}

		try {
			const { outcomes } = await post('/firewall/rules', { action, ids: targets.map((rule) => rule.id) });
			const failed = (outcomes as Array<{ id: string; ok: boolean; error?: string }>).filter((outcome) => !outcome.ok);

			if (failed.length === 0) {
				Notify.success(targets.length === 1
					? done
					: t('web.firewall.bulkDone', { done: targets.length, total: targets.length }));
			} else if (targets.length === 1) {
				Notify.error(t('web.firewall.rules.failed'), { detail: failed[0]!.error });
			} else {
				Notify.warning(t('web.firewall.bulkDone', { done: targets.length - failed.length, total: targets.length }), {
					detail: failed.map((outcome) => {
						const rule = targets.find((entry) => entry.id === outcome.id);

						return `${rule ? ruleTitle(rule) : outcome.id}: ${outcome.error ?? ''}`;
					}).join('\n')
				});
			}
		} catch (err) {
			Notify.error(t('web.firewall.rules.failed'), { detail: (err as Error).message });
		}

		if (action === 'remove') {
			selected = new Set();
		}

		await refresh();
	}

	function setEnabled(targets: FirewallRule[], enabled: boolean): Promise<void> {
		return runOnRules(
			targets.filter((rule) => rule.enabled !== enabled),
			enabled ? 'enable' : 'disable',
			enabled ? t('web.firewall.rules.enabled') : t('web.firewall.rules.disabled')
		);
	}

	/** "Turn on" for one rule; with several picked, how many of them the verb changes. */
	function countLabel(picked: number, count: number, verb: 'enable' | 'disable'): string {
		if (picked === 1) {
			return t(`web.firewall.rules.${verb}`);
		}

		return t(`web.firewall.rules.${verb}Count`, { count });
	}

	/** The verbs of one rule or several, for a row's menu and the header's Actions dropdown. */
	function ruleActions(targets: FirewallRule[]): ContextMenuItem[] {
		const one = targets.length === 1
			? targets[0]
			: undefined;
		const toEnable = targets.filter((rule) => !rule.enabled).length;
		const toDisable = targets.length - toEnable;
		const oneOnly = targets.length > 1
			? t('web.firewall.rules.oneOnly')
			: undefined;

		return menuGroups(
			[
				{
					label: t('web.firewall.rules.edit'),
					icon: 'pen',
					disabled: !one || !canConfigure,
					hint: oneOnly ?? configureReason,
					action: () => openEditor(one!)
				},
				{
					label: t('web.firewall.rules.duplicate'),
					icon: 'copy',
					disabled: !one || !canConfigure,
					hint: oneOnly ?? configureReason,
					action: () => openEditor(null, { ...one!, id: undefined })
				},
				{
					label: t('web.firewall.bans.refusals'),
					icon: 'clock',
					disabled: !one || one.action === 'allow',
					hint: oneOnly ?? (one?.action === 'allow' ? t('web.firewall.rules.allowRefusesNothing') : undefined),
					action: () => goto(firewallHref('activity', { rule: one!.id }))
				}
			],
			[
				{
					label: countLabel(targets.length, toEnable, 'enable'),
					icon: 'shieldCheck',
					disabled: toEnable === 0 || !canConfigure,
					hint: configureReason ?? (toEnable === 0 ? t('web.firewall.rules.alreadyOn') : undefined),
					action: () => setEnabled(targets, true)
				},
				{
					label: countLabel(targets.length, toDisable, 'disable'),
					icon: 'ban',
					disabled: toDisable === 0 || !canConfigure,
					hint: configureReason ?? (toDisable === 0 ? t('web.firewall.rules.alreadyOff') : undefined),
					action: () => setEnabled(targets, false)
				}
			],
			[
				{
					label: t('web.common.delete'),
					icon: 'trash',
					color: 'danger',
					disabled: targets.length === 0 || !canConfigure,
					hint: configureReason,
					action: () => {
						deleting = targets;
						deleteOpen = true;
					}
				}
			]
		);
	}

	// a selection only counts where it can be seen
	const pickedRules = $derived(tab === 'rules'
		? rules.filter((rule) => selected.has(rule.id))
		: []);
	const oneRule = $derived(pickedRules.length === 1
		? pickedRules[0]!
		: null);

	/** The selection when the row is part of it, else the row alone. */
	function targetsFor(rule: FirewallRule): FirewallRule[] {
		return selected.has(rule.id) && pickedRules.length > 1
			? pickedRules
			: [rule];
	}

	const columns: Column[] = $derived([
		{ id: 'enabled', label: t('web.firewall.rules.col.enabled'), sortable: true, width: 70, align: 'center' },
		{ id: 'action', label: t('web.firewall.rules.col.action'), sortable: true, width: 110 },
		{ id: 'match', label: t('web.firewall.rules.col.matches'), minWidth: 280 },
		{ id: 'note', label: t('web.firewall.rules.col.note'), sortable: true, minWidth: 200 },
		{ id: 'hits', label: t('web.firewall.rules.col.hits'), sortable: true, width: 110, align: 'right' },
		{ id: 'lastHit', label: t('web.firewall.rules.col.lastHit'), sortable: true, width: 170 },
		{ id: 'createdBy', label: t('web.firewall.rules.col.createdBy'), sortable: true, width: 150, hidden: true },
		{ id: 'created', label: t('web.firewall.rules.col.created'), sortable: true, width: 170, hidden: true }
	]);

	const filters: TableFilterGroup<FirewallRule>[] = $derived([
		{
			id: 'action',
			label: t('web.firewall.rules.filterAction'),
			options: [
				{ value: 'any', label: t('web.firewall.rules.anyAction') },
				{ value: 'allow', label: t('web.firewall.action.allow'), match: (rule) => rule.action === 'allow' },
				{ value: 'deny', label: t('web.firewall.action.deny'), match: (rule) => rule.action === 'deny' }
			]
		},
		{
			id: 'state',
			label: t('web.firewall.rules.filterState'),
			options: [
				{ value: 'any', label: t('web.firewall.rules.anyState') },
				{ value: 'on', label: t('web.firewall.rules.stateOn'), match: (rule) => rule.enabled },
				{ value: 'off', label: t('web.firewall.rules.stateOff'), match: (rule) => !rule.enabled }
			]
		},
		{
			id: 'match',
			label: t('web.firewall.rules.filterMatch'),
			options: [
				{ value: 'any', label: t('web.firewall.rules.anyMatch') },
				{ value: 'addresses', label: t('web.firewall.rules.byAddresses'), match: (rule) => rule.addresses.length > 0 },
				{ value: 'countries', label: t('web.firewall.rules.byCountries'), match: (rule) => rule.countries.length > 0 }
			]
		}
	]);

	const tabs = $derived(FIREWALL_TABS.map((id) => ({
		id,
		label: t(`web.firewall.tab.${id}`),
		href: firewallHref(id)
	})));

	const enabledRules = $derived(rules.filter((rule) => rule.enabled).length);
	const allowRules = $derived(rules.filter((rule) => rule.action === 'allow').length);
	const detectorsOn = $derived(usable ? FIREWALL_DETECTORS.filter((id) => overview!.settings[id]).length : 0);
	const geoRelease = $derived.by((): string | null => {
		const releases = usable
			? Object.values(overview!.countries).map((country) => country.release).filter((release) => release !== '')
			: [];

		return releases.sort().at(-1) ?? null;
	});

	const ruleCells = $derived.by((): InfoCell[] => {
		if (!oneRule) {
			return [];
		}

		return [
			{ id: 'action', label: t('web.firewall.rules.col.action') },
			{ id: 'state', label: t('web.firewall.rules.col.state') },
			// no id on a plain value: the grid hands every cell with one to the snippet below
			{ label: t('web.firewall.rules.col.hits'), value: oneRule.hits },
			{ id: 'lastHit', label: t('web.firewall.rules.col.lastHit') },
			{ label: t('web.firewall.rules.col.createdBy'), value: oneRule.createdBy },
			{ id: 'created', label: t('web.firewall.rules.col.created') },
			{ label: t('web.firewall.rules.id'), value: oneRule.id, style: 'mono', copyable: true },
			{ label: t('web.firewall.rules.col.note'), value: oneRule.note, colSpan: 'all' },
			...(oneRule.addresses.length > 0
				? [{ id: 'addresses', label: t('web.firewall.rules.addressesCount', { count: oneRule.addresses.length }), colSpan: 'all' as const }]
				: []),
			...(oneRule.countries.length > 0
				? [{ id: 'countries', label: t('web.firewall.rules.countriesCount', { count: oneRule.countries.length }), colSpan: 'all' as const }]
				: [])
		];
	});

	async function protect(addresses: string[]): Promise<void> {
		if (!overview) {
			return;
		}

		const next = [...new Set([...overview.settings.protect, ...addresses])];

		try {
			await post('/firewall/settings', { values: { protect: next } });
			Notify.success(t('web.firewall.protected', { count: addresses.length }));
			await refresh();
		} catch (err) {
			Notify.error(t('web.firewall.protectFailed'), { detail: (err as Error).message });
		}
	}
</script>

<svelte:head><title>{t('web.nav.firewall')} | Luna Console</title></svelte:head>

<PageHeader
	title={t('web.nav.firewall')}
	count={!usable
		? undefined
		: tab === 'rules'
			? rules.length
			: tab === 'bans'
				? bansTotal
				: tab === 'activity'
					? refusedTotal
					: undefined}
	description={t('web.firewall.pageDescription')}
	info={t(`web.guide.firewall.${tab}`)}
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="network-firewall" />
		{#if tab === 'rules'}
			<Dropdown
				label={t('web.common.actions')}
				disabled={pickedRules.length === 0}
				title={pickedRules.length === 0 ? t('web.firewall.rules.pickSome') : undefined}
				header={pickedRules.length === 1
					? ruleTitle(pickedRules[0]!)
					: t('web.firewall.rules.pickedCount', { count: pickedRules.length })}
				menu={ruleActions(pickedRules)}
			/>
		{:else if tab === 'bans'}
			<Dropdown
				label={t('web.common.actions')}
				disabled={pickedBans.length === 0}
				title={pickedBans.length === 0 ? t('web.firewall.bans.pickSome') : undefined}
				header={pickedBans.length === 1
					? pickedBans[0]!.ip
					: t('web.firewall.bans.pickedCount', { count: pickedBans.length })}
				menu={bansTab?.actions(pickedBans as never) ?? []}
			/>
		{:else}
			<Dropdown label={t('web.common.actions')} disabled title={t('web.firewall.nothingToActOn')} menu={[]} />
		{/if}
		<Btn icon="ban" disabled={!usable || !canBan} title={banDenied ?? offlineReason} onclick={() => openBan(tab === 'check' && page.url.searchParams.get('address') ? [page.url.searchParams.get('address')!] : [])}>
			{t('web.firewall.ban.action')}
		</Btn>
		<Btn variant="primary" icon="plus" disabled={!usable || !canConfigure} title={configureReason ?? offlineReason} onclick={() => openEditor(null)}>
			{t('web.firewall.rules.add')}
		</Btn>
	{/snippet}
</PageHeader>

{#if loaded && overview && !overview.reachable}
	<Flash kind="error">{t('web.firewall.unreachable')}</Flash>
{:else if loaded && overview && !overview.supported}
	<Flash kind="warning">{t('web.firewall.unsupported')}</Flash>
{:else if usable && !overview!.available}
	<Flash kind="warning">{t('web.firewall.noDatabase')}</Flash>
{:else if usable && missingCountries}
	<Flash kind="warning">
		{t('web.firewall.noCountryData')}
		<a href={firewallHref('rules', { match: 'countries' })}>{t('web.firewall.noCountryDataLink')}</a>
	</Flash>
{/if}

<OverviewBar title={t('web.firewall.overview.title')}>
	<OverviewCell label={t('web.firewall.overview.enforcement')}>
		{#if !overview}
			<span class="dim">–</span>
		{:else if !overview.reachable}
			<StatusBadge state="failed" label={t('web.firewall.overview.offline')} />
		{:else if !overview.supported}
			<StatusBadge state="warning" label={t('web.firewall.overview.tooOld')} />
		{:else if !overview.settings.enabled}
			<StatusBadge state="stopped" label={t('web.firewall.overview.bansOnly')} />
		{:else}
			<StatusBadge state="ok" label={t('web.firewall.overview.enforcing')} />
		{/if}
	</OverviewCell>
	<OverviewCell label={t('web.firewall.overview.refused')}>
		{#if usable}
			<a href={firewallHref('activity')}>{overview!.stats.refused24h}</a>
		{:else}
			<span class="dim">–</span>
		{/if}
	</OverviewCell>
	<OverviewCell label={t('web.firewall.overview.bans')}>
		{#if usable}
			<span>
				<a href={firewallHref('bans')}>{overview!.stats.activeBans}</a>
				<span class="dim nowrap">· {t('web.firewall.overview.autoCount', { count: overview!.stats.automaticBans })}</span>
			</span>
		{:else}
			<span class="dim">–</span>
		{/if}
	</OverviewCell>
	<OverviewCell label={t('web.firewall.overview.rules')}>
		{#if usable}
			<span>
				<a href={firewallHref('rules')}>{rules.length}</a>
				<span class="dim nowrap">· {t('web.firewall.overview.ruleSplit', { allow: allowRules, deny: rules.length - allowRules })}</span>
				{#if enabledRules < rules.length}
					<span class="dim nowrap">· {t('web.firewall.overview.offCount', { count: rules.length - enabledRules })}</span>
				{/if}
			</span>
		{:else}
			<span class="dim">–</span>
		{/if}
	</OverviewCell>
	<OverviewCell label={t('web.firewall.overview.autoban')}>
		{#if !usable}
			<span class="dim">–</span>
		{:else if detectorsOn > 0}
			<span class="pairing">
				<StatusBadge state="ok" label={t('web.firewall.overview.on')} />
				<span class="dim">{t('web.firewall.overview.detectors', { count: detectorsOn, total: FIREWALL_DETECTORS.length })}</span>
			</span>
		{:else}
			<span class="pairing">
				<StatusBadge state="stopped" label={t('web.firewall.overview.off')} />
				<a class="link" href={firewallHref('autoban')}>{t('web.firewall.overview.turnOn')}</a>
			</span>
		{/if}
	</OverviewCell>
	<OverviewCell label={t('web.firewall.overview.geo')}>
		{#if !usable}
			<span class="dim">–</span>
		{:else if geoRelease}
			<InfoPopover>
				<span class="mono">{geoRelease}</span>
				{#snippet content()}
					<span class="geocard">
						<span>{t('web.firewall.overview.geoHeld', { count: Object.keys(overview!.countries).length })}</span>
						<GeoAttribution />
					</span>
				{/snippet}
			</InfoPopover>
		{:else if rules.some((rule) => rule.countries.length > 0)}
			<StatusBadge state="warning" label={t('web.firewall.overview.geoMissing')} />
		{:else}
			<span class="dim">{t('web.firewall.overview.geoNone')}</span>
		{/if}
	</OverviewCell>
</OverviewBar>

<Tabs {tabs} active={tab} />

<div class="tabbody">
	{#if loaded && !usable}
		<OfflineTab {tab} why={overview?.reachable ? 'unsupported' : 'offline'} {loading} onretry={refresh} />
	{:else if tab === 'rules'}
		<Panel title={t('web.firewall.tab.rules')} count={loaded ? rules.length : undefined} description={t('web.firewall.rules.orderNote')} flush>
			<ResourceTable
				tableId="network-firewall-rules"
				loading={!loaded}
				{columns}
				{filters}
				initialFilters={{ match: page.url.searchParams.get('match') ?? 'any' }}
				rows={rules}
				getId={(rule) => rule.id}
				initialSearch={page.url.searchParams.get('q') ?? ''}
				searchValue={(rule) => [
					rule.id,
					ruleSummary(rule),
					rule.addresses.join(' '),
					rule.countries.join(' '),
					rule.countries.map((code) => countryName(code)).join(' '),
					rule.note,
					rule.createdBy
				].join(' ')}
				searchPlaceholder={t('web.firewall.rules.search')}
				selectable="multi"
				bind:selected
				rowActions={(rule) => ruleActions(targetsFor(rule))}
				rowLabel={(rule) => ruleTitle(rule)}
				rowDim={(rule) => !rule.enabled}
				onRowDblClick={(rule) => {
					if (canConfigure) {
						openEditor(rule);
					}
				}}
				noun={t('web.firewall.rules.noun')}
				defaultSort={{ col: 'action', dir: 'asc' }}
				sortValue={(rule, col) =>
					col === 'enabled'
						? (rule.enabled ? 0 : 1)
						: col === 'action'
							? rule.action
							: col === 'note'
								? rule.note
								: col === 'hits'
									? rule.hits
									: col === 'lastHit'
										? rule.lastHitAtEpochMillis
										: col === 'createdBy'
											? rule.createdBy
											: col === 'created'
												? rule.createdAtEpochMillis
												: null}
				paging={false}
				emptyTitle={t('web.firewall.rules.emptyTitle')}
				emptyText={t('web.firewall.rules.emptyText')}
			>
				{#snippet emptyAction()}
					{#if canConfigure && usable}
						<Btn icon="plus" onclick={() => openEditor(null)}>{t('web.firewall.rules.add')}</Btn>
					{/if}
				{/snippet}
				{#snippet cell(rule, col)}
					{#if col === 'enabled'}
						<Toggle
							checked={rule.enabled}
							disabled={!canConfigure}
							label={t('web.firewall.rules.col.enabled')}
							onchange={(value) => void setEnabled([rule], value)}
						/>
					{:else if col === 'action'}
						<StatusBadge state={rule.action === 'allow' ? 'ok' : 'failed'} label={t(`web.firewall.action.${rule.action}`)} />
					{:else if col === 'match'}
						<span class="matchcell">
							<FirewallMatchers {rule} />
							{#if rule.countries.some((code) => !overview?.countries[code])}
								<StatusBadge state="warning" label={t('web.firewall.rules.noCountryData')} />
							{/if}
						</span>
					{:else if col === 'note'}
						{#if rule.note}
							{rule.note}
						{:else}
							<span class="dim">–</span>
						{/if}
					{:else if col === 'hits'}
						{rule.hits}
					{:else if col === 'lastHit'}
						{#if rule.lastHitAtEpochMillis > 0}
							<DateTime at={rule.lastHitAtEpochMillis} text={fmtDateTime(rule.lastHitAtEpochMillis)} />
						{:else}
							<span class="dim">{t('web.firewall.rules.never')}</span>
						{/if}
					{:else if col === 'createdBy'}
						{rule.createdBy || '–'}
					{:else if col === 'created'}
						<span class="dim"><DateTime at={rule.createdAtEpochMillis} text={fmtDateTime(rule.createdAtEpochMillis)} /></span>
					{/if}
				{/snippet}
			</ResourceTable>
		</Panel>

		{#if oneRule}
			<DetailPanel
				title={t(`web.firewall.rules.title.${oneRule.action}`)}
				subtitle={ruleTitle(oneRule)}
				bind:location={panelLocation}
				bind:size={panelSize}
				onclose={() => (selected = new Set())}
			>
				{#snippet actions()}
					<Btn
						icon="clock"
						disabled={oneRule.action === 'allow'}
						title={oneRule.action === 'allow' ? t('web.firewall.rules.allowRefusesNothing') : undefined}
						onclick={() => void goto(firewallHref('activity', { rule: oneRule.id }))}
					>
						{t('web.firewall.bans.refusals')}
					</Btn>
					<Btn icon="pen" disabled={!canConfigure} title={configureReason} onclick={() => openEditor(oneRule)}>{t('web.firewall.rules.edit')}</Btn>
				{/snippet}

				<InfoGrid cells={ruleCells} columns={[4, 2, 1]}>
					{#snippet custom(info)}
						{#if info.id === 'action'}
							<StatusBadge state={oneRule.action === 'allow' ? 'ok' : 'failed'} label={t(`web.firewall.action.${oneRule.action}`)} />
						{:else if info.id === 'state'}
							{oneRule.enabled ? t('web.firewall.rules.stateOn') : t('web.firewall.rules.stateOff')}
						{:else if info.id === 'lastHit'}
							{#if oneRule.lastHitAtEpochMillis > 0}
								<DateTime at={oneRule.lastHitAtEpochMillis} text={fmtDateTime(oneRule.lastHitAtEpochMillis)} />
							{:else}
								<span class="dim">{t('web.firewall.rules.never')}</span>
							{/if}
						{:else if info.id === 'created'}
							<DateTime at={oneRule.createdAtEpochMillis} text={fmtDateTime(oneRule.createdAtEpochMillis)} />
						{:else if info.id === 'addresses'}
							<FirewallMatchers rule={{ addresses: oneRule.addresses, countries: [] }} full />
						{:else if info.id === 'countries'}
							<span class="stack">
								<FirewallMatchers rule={{ addresses: [], countries: oneRule.countries }} full />
								<GeoAttribution />
							</span>
						{/if}
					{/snippet}
				</InfoGrid>

				{#if oneRule.action === 'allow' || (oneRule.addresses.length > 0 && oneRule.countries.length > 0)}
					<Flash kind="info">
						{#if oneRule.addresses.length > 0 && oneRule.countries.length > 0}
							{t('web.firewall.rules.bothNote')}
						{/if}
						{#if oneRule.action === 'allow'}
							{t('web.firewall.rules.allowNote')}
						{/if}
					</Flash>
				{/if}
			</DetailPanel>
		{/if}
	{:else if tab === 'bans'}
		<BansTab
			bind:this={bansTab}
			bind:picked={pickedBans as never}
			bind:total={bansTotal}
			autobanOn={detectorsOn > 0}
			{canBan}
			{canConfigure}
			onchange={refresh}
			onban={openBan}
			onallow={(addresses) => openEditor(null, { action: 'allow', addresses })}
			onprotect={(addresses) => void protect(addresses)}
		/>
	{:else if tab === 'autoban'}
		<AutoBanTab
			bind:this={autoTab}
			bind:dirty={autoDirty}
			settings={usable ? overview!.settings : null}
			protectedRanges={usable ? overview!.protectedRanges : []}
			{canConfigure}
			you={overview?.you ?? null}
			onsaved={refresh}
		/>
	{:else if tab === 'check'}
		<CheckTab
			bind:this={checkTab}
			you={overview?.you ?? null}
			{canBan}
			{canConfigure}
			onopenrule={openRuleById}
			onban={(address) => openBan([address])}
			onaddrule={(address, action) => openEditor(null, { action, addresses: [address] })}
			onchange={refresh}
		/>
	{:else}
		<ActivityTab
			bind:this={activityTab}
			bind:total={refusedTotal}
			{rules}
			bannedNow={activeBans}
			{canBan}
			{canConfigure}
			onban={(address) => openBan([address])}
			onaddrule={(from) => openEditor(null, from)}
		/>
	{/if}
</div>

<FirewallRuleModal
	bind:open={editorOpen}
	rule={editing}
	{preset}
	you={overview?.you ?? null}
	{countriesHeld}
	onsave={saveRule}
/>

<FirewallBanModal
	bind:open={banOpen}
	addresses={banAddresses}
	reason={banReason}
	you={overview?.you ?? null}
	onbanned={refresh}
/>

<ConfirmModal
	bind:open={deleteOpen}
	title={t('web.firewall.rules.deleteTitle')}
	lead={deleting.length === 1
		? t('web.firewall.rules.deleteLead', { summary: ruleTitle(deleting[0]!) })
		: t('web.firewall.rules.deleteLeadMany', { count: deleting.length })}
	notes={[
		...(deleting.some((rule) => rule.action === 'deny') ? [t('web.firewall.rules.deleteDenyNote')] : []),
		...(deleting.some((rule) => rule.action === 'allow') ? [t('web.firewall.rules.deleteAllowNote')] : []),
		t('web.firewall.rules.deleteHitsNote')
	]}
	confirmLabel={t('web.common.delete')}
	onconfirm={() => void runOnRules(deleting, 'remove', t('web.firewall.rules.deleted'))}
/>

<ConfirmModal
	bind:open={leaveOpen}
	title={t('web.firewall.autoban.leaveTitle')}
	lead={t('web.firewall.autoban.leaveLead')}
	confirmLabel={t('web.common.discard')}
	cancelLabel={t('web.firewall.autoban.leaveStay')}
	danger={false}
	onconfirm={leave}
/>

<style lang="scss">
	.tabbody {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		margin-top: 1rem;
	}

	// a badge and the link that acts on it, wrapping inside the cell
	.pairing {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.75rem;
	}

	.link {
		color: var(--link);
		font-size: 0.875rem;
		white-space: nowrap;
	}

	.geocard {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.matchcell {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.5rem;
		min-width: 0;
	}

	// the countries, then where they come from
	.stack {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.5rem;
	}
</style>
