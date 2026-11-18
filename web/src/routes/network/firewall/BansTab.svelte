<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';

	import { api, post } from '$lib/api';
	import { copyText } from '$lib/clipboard';
	import { countryName, firewallHref, fmtSpan, prefixSize, reasonLabel } from '$lib/firewall';
	import { fmtDateTime } from '$lib/format';
	import { t } from '$lib/i18n.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import CellStack from '$lib/components/CellStack.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import CountryName from '$lib/components/CountryName.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import DateTime from '$lib/components/DateTime.svelte';
	import DetailPanel from '$lib/components/DetailPanel.svelte';
	import GeoAttribution from '$lib/components/GeoAttribution.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import InfoPopover from '$lib/components/InfoPopover.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import StackedBars from '$lib/components/StackedBars.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { menuGroups, type ContextMenuItem } from '$lib/components/contextmenu';
	import type { Series, SeriesStyle } from '$lib/components/chart';
	import type { InfoCell } from '$lib/components/grid';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import type { BanEnd, EndedBan, FirewallBan } from '$shared/firewall';

	/**
	 * The addresses the proxy refuses, and the bans that ended before them. An
	 * address is banned once at a time but its history holds it many times, so
	 * a row is an address and the moment it was banned. One ban ticked opens
	 * its detail below the table: what it is, and the earlier bans of the same
	 * address.
	 */
	let {
		picked = $bindable([]),
		total = $bindable(),
		autobanOn,
		canBan,
		canConfigure,
		onchange,
		onban,
		onallow,
		onprotect
	}: {
		/** The selected bans, for the page header's Actions dropdown */
		picked: BanRow[];
		/** How many bans the table shows, for the page header's count */
		total: number | undefined;
		autobanOn: boolean;
		canBan: boolean;
		canConfigure: boolean;
		/** A ban was lifted: the page's own figures are stale */
		onchange: () => void;
		/** Open the ban form for addresses, with a reason to carry over */
		onban: (addresses: string[], reason?: string) => void;
		/** Open the rule form with an allow rule for these addresses */
		onallow: (addresses: string[]) => void;
		/** Add addresses to the protected list */
		onprotect: (addresses: string[]) => void;
	} = $props();

	type BanState = 'active' | BanEnd;

	interface BanRow {
		id: string;
		ip: string;
		state: BanState;
		reason: string;
		actor: string;
		source: string;
		strikes: number;
		createdAt: number;
		/** 0 = permanent */
		expiresAt: number;
		hits: number;
		lastHitAt: number;
		endedAt: number | null;
		endedBy: string;
		country: string | null;
		/** An ended ban whose address is banned again now */
		bannedNow: boolean;
	}

	let active = $state<FirewallBan[]>([]);
	let ended = $state<EndedBan[]>([]);
	let countries = $state<Record<string, string | null>>({});
	let loaded = $state(false);
	let error = $state('');
	let selected = $state<Set<string>>(new Set());
	let liftOpen = $state(false);
	let lifting = $state<BanRow[]>([]);
	let panelLocation = $state<'bottom' | 'right'>('bottom');
	let panelSize = $state(42);

	/** Read both lists again; the page's refresh calls this too. */
	export async function load(): Promise<void> {
		try {
			const [now, before] = await Promise.all([
				api('/firewall/bans'),
				api('/firewall/bans?history=1&limit=500')
			]);

			if (!now.available) {
				error = now.error ?? '';
			} else {
				error = '';
				active = now.bans;
			}

			ended = before.available
				? before.bans
				: [];
			countries = { ...(before.countries ?? {}), ...(now.countries ?? {}) };
		} catch (err) {
			error = (err as Error).message;
		} finally {
			loaded = true;
		}
	}

	$effect(() => {
		void load();
	});

	const rows = $derived.by((): BanRow[] => {
		const bannedNow = new Set(active.map((ban) => ban.ip));
		const out: BanRow[] = active.map((ban) => ({
			id: `${ban.ip}@${ban.createdAtEpochMillis}`,
			ip: ban.ip,
			state: 'active',
			reason: ban.reason,
			actor: ban.actor,
			source: ban.source ?? 'manual',
			strikes: ban.strikes ?? 1,
			createdAt: ban.createdAtEpochMillis,
			expiresAt: ban.expiresAtEpochMillis,
			hits: ban.hits,
			lastHitAt: ban.lastHitAtEpochMillis,
			endedAt: null,
			endedBy: '',
			country: countries[ban.ip] ?? null,
			bannedNow: true
		}));

		for (const ban of ended) {
			out.push({
				id: `${ban.ip}@${ban.createdAtEpochMillis}`,
				ip: ban.ip,
				state: ban.ended,
				reason: ban.reason,
				actor: ban.actor,
				source: ban.source,
				strikes: ban.strikes,
				createdAt: ban.createdAtEpochMillis,
				expiresAt: ban.expiresAtEpochMillis,
				hits: ban.hits,
				lastHitAt: 0,
				endedAt: ban.endedAtEpochMillis,
				endedBy: ban.endedBy,
				country: countries[ban.ip] ?? null,
				bannedNow: bannedNow.has(ban.ip)
			});
		}

		return out;
	});

	$effect(() => {
		picked = rows.filter((row) => selected.has(row.id));
	});

	const one = $derived(picked.length === 1
		? picked[0]!
		: null);
	const earlier = $derived(one
		? rows.filter((row) => row.ip === one.ip && row.id !== one.id)
		: []);

	async function lift(targets: BanRow[]): Promise<void> {
		try {
			const { outcomes } = await post('/firewall/bans', { action: 'remove', ips: targets.map((ban) => ban.ip) });
			const failed = (outcomes as Array<{ ip: string; ok: boolean; error?: string }>).filter((outcome) => !outcome.ok);

			if (failed.length === 0) {
				Notify.success(targets.length === 1
					? t('web.firewall.bans.liftedOne', { address: targets[0]!.ip })
					: t('web.firewall.bans.lifted', { count: targets.length }));
			} else if (targets.length === 1) {
				Notify.error(t('web.firewall.bans.liftFailed'), { detail: failed[0]!.error });
			} else {
				Notify.warning(t('web.firewall.bulkDone', { done: targets.length - failed.length, total: targets.length }), {
					detail: failed.map((outcome) => `${outcome.ip}: ${outcome.error ?? ''}`).join('\n')
				});
			}
		} catch (err) {
			Notify.error(t('web.firewall.bans.liftFailed'), { detail: (err as Error).message });
		}

		selected = new Set();
		await load();
		onchange();
	}

	/** The verbs of one ban or several, for a row's menu and the header's Actions dropdown. */
	export function actions(targets: BanRow[]): ContextMenuItem[] {
		const one = targets.length === 1
			? targets[0]
			: undefined;
		const oneOnly = targets.length > 1
			? t('web.firewall.bans.oneOnly')
			: undefined;
		const live = targets.filter((ban) => ban.state === 'active');
		const banReason = canBan
			? undefined
			: t('web.common.notAllowed', { action: 'player:Moderate' });
		const configureReason = canConfigure
			? undefined
			: t('web.common.notAllowed', { action: 'firewall:Configure' });
		const addresses = [...new Set(targets.map((ban) => ban.ip))];

		return menuGroups(
			[
				{
					label: t('web.firewall.bans.check'),
					icon: 'magnifyingGlass',
					disabled: !one,
					hint: oneOnly,
					action: () => goto(firewallHref('check', { address: one!.ip.split('/')[0] }))
				},
				{
					label: t('web.firewall.bans.refusals'),
					icon: 'clock',
					disabled: !one,
					hint: oneOnly,
					action: () => goto(firewallHref('activity', { address: one!.ip }))
				}
			],
			[
				{
					label: t('web.firewall.bans.banAgain'),
					icon: 'ban',
					disabled: !one || one.bannedNow || !canBan,
					hint: oneOnly
						?? banReason
						?? (one?.bannedNow ? t('web.firewall.bans.bannedNow') : undefined),
					action: () => onban([one!.ip], one!.reason)
				}
			],
			[
				{
					label: t('web.firewall.bans.protect'),
					icon: 'shieldCheck',
					disabled: targets.length === 0 || !canConfigure,
					hint: configureReason,
					action: () => onprotect(addresses)
				},
				{
					label: t('web.firewall.bans.allow'),
					icon: 'plus',
					disabled: targets.length === 0 || !canConfigure,
					hint: configureReason,
					action: () => onallow(addresses)
				}
			],
			[
				{
					label: targets.length > 1
						? t('web.firewall.bans.liftCount', { count: live.length })
						: t('web.firewall.bans.lift'),
					icon: 'handshake',
					disabled: live.length === 0 || !canBan,
					hint: banReason ?? (live.length === 0 ? t('web.firewall.bans.liftEnded') : undefined),
					action: () => {
						lifting = live;
						liftOpen = true;
					}
				}
			],
			[
				{
					label: t('web.firewall.bans.copy'),
					icon: 'copy',
					disabled: targets.length === 0,
					action: async () => {
						if (await copyText(addresses.join('\n'))) {
							Notify.success(t('web.firewall.bans.copied'));
						}
					}
				}
			]
		);
	}

	/** The selection when the row is part of it, else the row alone. */
	function targetsFor(ban: BanRow): BanRow[] {
		return selected.has(ban.id) && picked.length > 1
			? picked
			: [ban];
	}

	function sourceLabel(source: string): string {
		return source === 'manual'
			? t('web.firewall.bans.manual')
			: reasonLabel(source);
	}

	const columns: Column[] = $derived([
		{ id: 'address', label: t('web.firewall.bans.col.address'), sortable: true, width: 200 },
		{ id: 'state', label: t('web.firewall.bans.col.state'), sortable: true, width: 160 },
		{ id: 'country', label: t('web.firewall.bans.col.country'), sortable: true, width: 170 },
		{ id: 'reason', label: t('web.firewall.bans.col.reason'), minWidth: 220 },
		{ id: 'source', label: t('web.firewall.bans.col.source'), sortable: true, width: 170 },
		{ id: 'created', label: t('web.firewall.bans.col.created'), sortable: true, width: 170 },
		{ id: 'expires', label: t('web.firewall.bans.col.expires'), sortable: true, width: 170 },
		{ id: 'strikes', label: t('web.firewall.bans.col.strikes'), sortable: true, width: 90, align: 'right' },
		{ id: 'hits', label: t('web.firewall.bans.col.hits'), sortable: true, width: 150, align: 'right' },
		{ id: 'lastHit', label: t('web.firewall.bans.col.lastHit'), sortable: true, width: 170 },
		{ id: 'endedBy', label: t('web.firewall.bans.col.endedBy'), sortable: true, width: 150, hidden: true }
	]);

	const filters: TableFilterGroup<BanRow>[] = $derived([
		{
			id: 'state',
			label: t('web.firewall.bans.filterState'),
			options: [
				{ value: 'active', label: t('web.firewall.bans.stateActive'), match: (ban) => ban.state === 'active' },
				{ value: 'ended', label: t('web.firewall.bans.stateEnded'), match: (ban) => ban.state !== 'active' },
				{ value: 'all', label: t('web.firewall.bans.stateAll') }
			]
		},
		{
			id: 'source',
			label: t('web.firewall.bans.filterSource'),
			options: [
				{ value: 'any', label: t('web.firewall.bans.anySource') },
				{ value: 'manual', label: t('web.firewall.bans.manual'), match: (ban) => ban.source === 'manual' },
				{ value: 'auto', label: t('web.firewall.bans.auto'), match: (ban) => ban.source !== 'manual' },
				{ value: 'loginFlood', label: reasonLabel('loginFlood'), match: (ban) => ban.source === 'loginFlood' },
				{ value: 'pingScan', label: reasonLabel('pingScan'), match: (ban) => ban.source === 'pingScan' },
				{ value: 'failedLogins', label: reasonLabel('failedLogins'), match: (ban) => ban.source === 'failedLogins' },
				{ value: 'suspiciousNames', label: reasonLabel('suspiciousNames'), match: (ban) => ban.source === 'suspiciousNames' }
			]
		},
		{
			id: 'length',
			label: t('web.firewall.bans.filterLength'),
			options: [
				{ value: 'any', label: t('web.firewall.bans.anyLength') },
				{ value: 'permanent', label: t('web.firewall.bans.permanent'), match: (ban) => ban.expiresAt === 0 },
				{ value: 'temporary', label: t('web.firewall.bans.temporary'), match: (ban) => ban.expiresAt > 0 }
			]
		},
		{
			id: 'repeat',
			label: t('web.firewall.bans.filterRepeat'),
			options: [
				{ value: 'any', label: t('web.firewall.bans.anyRepeat') },
				{ value: 'repeat', label: t('web.firewall.bans.repeat'), match: (ban) => ban.strikes > 1 }
			]
		}
	]);

	// a deep link from another screen (?state=, ?source=) picks the filter it names
	const initialFilters = $derived({
		state: page.url.searchParams.get('state') ?? 'active',
		source: page.url.searchParams.get('source') ?? 'any'
	});

	function sortValue(ban: BanRow, col: string): string | number | null {
		switch (col) {
			case 'address':
				return ban.ip;
			case 'country':
				return ban.country ?? '';
			case 'state':
				return ban.state;
			case 'source':
				return ban.source;
			case 'created':
				return ban.createdAt;
			case 'expires':
				return ban.endedAt ?? (ban.expiresAt === 0 ? Number.MAX_SAFE_INTEGER : ban.expiresAt);
			case 'strikes':
				return ban.strikes;
			case 'hits':
				return ban.hits;
			case 'lastHit':
				return ban.lastHitAt;
			case 'endedBy':
				return ban.endedBy;
			default:
				return null;
		}
	}

	$effect(() => {
		total = rows.length;
	});

	// -- the strip over the table: bans placed per day, by who placed them ----------------------

	const DAY = 86_400_000;
	const STRIP_DAYS = 30;

	const strip = $derived.by((): { from: number; to: number; series: Series[] } => {
		const today = new Date();

		today.setHours(0, 0, 0, 0);

		const from = today.getTime() - (STRIP_DAYS - 1) * DAY;
		const days = Array.from({ length: STRIP_DAYS }, (_, index) => from + index * DAY);
		const auto = new Map<number, number>();
		const manual = new Map<number, number>();

		for (const row of rows) {
			if (row.createdAt < from) {
				continue;
			}

			const day = new Date(row.createdAt);

			day.setHours(0, 0, 0, 0);

			const into = row.source === 'manual'
				? manual
				: auto;

			into.set(day.getTime(), (into.get(day.getTime()) ?? 0) + 1);
		}

		return {
			from,
			to: from + STRIP_DAYS * DAY,
			series: [
				{ key: 'auto', unit: 'count', points: days.map((at): [number, number] => [at, auto.get(at) ?? 0]) },
				{ key: 'manual', unit: 'count', points: days.map((at): [number, number] => [at, manual.get(at) ?? 0]) }
			]
		};
	});

	const stripStyles: Record<string, SeriesStyle> = $derived({
		auto: { label: t('web.firewall.bans.auto'), color: 'var(--warning)' },
		manual: { label: t('web.firewall.bans.byHand'), color: 'var(--link)' }
	});

	const activeCount = $derived(active.length);
	const autoActive = $derived(active.filter((ban) => (ban.source ?? 'manual') !== 'manual').length);

	const detailCells = $derived.by((): InfoCell[] => {
		if (!one) {
			return [];
		}

		return [
			{ id: 'state', label: t('web.firewall.bans.col.state') },
			{ id: 'created', label: t('web.firewall.bans.col.created') },
			{ id: 'expires', label: one.state === 'active' ? t('web.firewall.bans.col.expires') : t('web.firewall.bans.col.ended') },
			{ id: 'source', label: t('web.firewall.bans.col.source') },
			{ id: 'country', label: t('web.firewall.bans.col.country') },
			// no id on a plain value: the grid hands every cell with one to the snippet below
			{ label: t('web.firewall.bans.col.strikes'), value: one.strikes },
			{ label: t('web.firewall.bans.col.hits'), value: one.hits },
			{ id: 'lastHit', label: t('web.firewall.bans.col.lastHit') },
			{ label: t('web.firewall.bans.col.reason'), value: one.reason, colSpan: 'all' }
		];
	});

	const historyColumns: Column[] = $derived([
		{ id: 'created', label: t('web.firewall.bans.col.created'), width: 170 },
		{ id: 'length', label: t('web.firewall.bans.col.length'), width: 120 },
		{ id: 'source', label: t('web.firewall.bans.col.source'), width: 170 },
		{ id: 'ended', label: t('web.firewall.bans.col.ended'), minWidth: 180 },
		{ id: 'hits', label: t('web.firewall.bans.col.hits'), width: 150, align: 'right' }
	]);
</script>

{#snippet stateCell(ban: BanRow)}
	{#snippet main()}
		<StatusBadge
			state={ban.state === 'active' ? 'failed' : 'stopped'}
			label={t(`web.firewall.bans.state.${ban.state}`)}
		/>
	{/snippet}
	{#snippet sub()}
		{#if ban.state === 'active'}
			{ban.expiresAt === 0
				? t('web.firewall.bans.untilLifted')
				: t('web.firewall.bans.endsIn', { time: fmtSpan(Math.max(0, ban.expiresAt - Date.now())) })}
		{:else if ban.state === 'lifted' && ban.endedBy}
			{t('web.firewall.bans.liftedBy', { actor: ban.endedBy })}
		{:else if ban.bannedNow}
			{t('web.firewall.bans.bannedAgain')}
		{/if}
	{/snippet}
	<CellStack {main} {sub} />
{/snippet}

{#snippet sourceCell(ban: BanRow)}
	{#if ban.source === 'manual'}
		{#if ban.actor}
			{ban.actor}
		{:else}
			{t('web.firewall.bans.manual')}
		{/if}
	{:else}
		<CellStack>
			{#snippet main()}
				{t('web.firewall.bans.auto')}
			{/snippet}
			{#snippet sub()}
				{reasonLabel(ban.source)}
			{/snippet}
		</CellStack>
	{/if}
{/snippet}

<Panel title={t('web.firewall.bans.title')} count={loaded ? rows.length : undefined} flush>
	<div class="head">
		<div class="caption">
			<span class="dim">{t('web.firewall.bans.stripCaption', { days: STRIP_DAYS })}</span>
			{#if loaded}
				<span class="now">{t('web.firewall.bans.stripNow', { count: activeCount, auto: autoActive })}</span>
			{/if}
		</div>
		<div class="strip">
			{#if loaded}
				<StackedBars
					series={strip.series}
					label={t('web.firewall.bans.stripLabel')}
					styles={stripStyles}
					from={strip.from}
					to={strip.to}
					compact
					formatValue={(value) => String(Math.round(value))}
				/>
			{/if}
		</div>
	</div>

	<ResourceTable
		tableId="network-firewall-bans"
		loading={!loaded}
		{columns}
		{filters}
		{initialFilters}
		{rows}
		getId={(ban) => ban.id}
		initialSearch={page.url.searchParams.get('q') ?? ''}
		searchValue={(ban) => [
			ban.ip,
			ban.country,
			ban.country ? countryName(ban.country) : '',
			ban.reason,
			ban.actor,
			ban.endedBy,
			sourceLabel(ban.source)
		].join(' ')}
		searchPlaceholder={t('web.firewall.bans.search')}
		selectable="multi"
		bind:selected
		rowActions={(ban) => actions(targetsFor(ban))}
		rowLabel={(ban) => ban.ip}
		rowDim={(ban) => ban.state !== 'active'}
		noun={t('web.firewall.bans.noun')}
		defaultSort={{ col: 'created', dir: 'desc' }}
		{sortValue}
		emptyTitle={t('web.firewall.bans.emptyTitle')}
		emptyText={error
			? error
			: autobanOn
				? t('web.firewall.bans.emptyText')
				: t('web.firewall.bans.emptyTextOff')}
	>
		{#snippet cell(ban, col)}
			{#if col === 'address'}
				{@const size = prefixSize(ban.ip)}
				{#snippet main()}
					<b class="mono">{ban.ip}</b>
				{/snippet}
				{#snippet sub()}
					{t('web.firewall.bans.prefixSize', { count: size ?? 0 })}
				{/snippet}
				<CellStack {main} sub={size ? sub : undefined} />
			{:else if col === 'country'}
				<CountryName code={ban.country} empty />
			{:else if col === 'state'}
				{@render stateCell(ban)}
			{:else if col === 'reason'}
				{#if ban.reason}
					<span class="clip">{ban.reason}</span>
				{:else}
					<span class="dim">–</span>
				{/if}
			{:else if col === 'source'}
				{@render sourceCell(ban)}
			{:else if col === 'created'}
				<span class="dim"><DateTime at={ban.createdAt} text={fmtDateTime(ban.createdAt)} /></span>
			{:else if col === 'expires'}
				{#if ban.endedAt !== null}
					<span class="dim"><DateTime at={ban.endedAt} text={fmtDateTime(ban.endedAt)} /></span>
				{:else if ban.expiresAt === 0}
					{t('web.firewall.bans.never')}
				{:else}
					<DateTime at={ban.expiresAt} text={fmtDateTime(ban.expiresAt)} />
				{/if}
			{:else if col === 'strikes'}
				{#if ban.strikes > 1}
					<InfoPopover detail={t('web.firewall.bans.strikesHint', { count: ban.strikes })}>{ban.strikes}</InfoPopover>
				{:else}
					{ban.strikes}
				{/if}
			{:else if col === 'hits'}
				{#if ban.hits > 0}
					{ban.hits}
				{:else}
					<span class="dim">–</span>
				{/if}
			{:else if col === 'lastHit'}
				{#if ban.lastHitAt > 0}
					<DateTime at={ban.lastHitAt} text={fmtDateTime(ban.lastHitAt)} />
				{:else}
					<span class="dim">–</span>
				{/if}
			{:else if col === 'endedBy'}
				{#if ban.endedBy}
					{ban.endedBy}
				{:else}
					<span class="dim">–</span>
				{/if}
			{/if}
		{/snippet}
	</ResourceTable>

	<div class="foot">
		<span class="credit"><GeoAttribution /></span>
	</div>
</Panel>

{#if one}
	<DetailPanel
		title={one.ip}
		subtitle={one.country ? countryName(one.country) : undefined}
		bind:location={panelLocation}
		bind:size={panelSize}
		onclose={() => (selected = new Set())}
	>
		{#snippet actions()}
			<Btn icon="magnifyingGlass" onclick={() => void goto(firewallHref('check', { address: one.ip.split('/')[0] }))}>
				{t('web.firewall.bans.check')}
			</Btn>
			{#if one.state === 'active'}
				<Btn
					icon="handshake"
					disabled={!canBan}
					title={canBan ? undefined : t('web.common.notAllowed', { action: 'player:Moderate' })}
					onclick={() => {
						lifting = [one];
						liftOpen = true;
					}}
				>
					{t('web.firewall.bans.lift')}
				</Btn>
			{/if}
		{/snippet}

		<InfoGrid cells={detailCells} columns={[4, 2, 1]}>
			{#snippet custom(info)}
				{#if info.id === 'state'}
					{@render stateCell(one)}
				{:else if info.id === 'created'}
					<DateTime at={one.createdAt} text={fmtDateTime(one.createdAt)} />
				{:else if info.id === 'expires'}
					{#if one.endedAt !== null}
						<DateTime at={one.endedAt} text={fmtDateTime(one.endedAt)} />
					{:else if one.expiresAt === 0}
						{t('web.firewall.bans.never')}
					{:else}
						<DateTime at={one.expiresAt} text={fmtDateTime(one.expiresAt)} />
					{/if}
				{:else if info.id === 'source'}
					{@render sourceCell(one)}
				{:else if info.id === 'country'}
					<CountryName code={one.country} empty />
				{:else if info.id === 'lastHit'}
					{#if one.lastHitAt > 0}
						<DateTime at={one.lastHitAt} text={fmtDateTime(one.lastHitAt)} />
					{:else}
						<span class="dim">–</span>
					{/if}
				{/if}
			{/snippet}
		</InfoGrid>

		<h3 class="section">{t('web.firewall.bans.earlier')}</h3>
		{#if earlier.length === 0}
			<p class="dim none">{t('web.firewall.bans.firstBan')}</p>
		{:else}
			<DataTable tableId="network-firewall-ban-history" snug columns={historyColumns} rows={earlier} getId={(ban) => ban.id}>
				{#snippet cell(ban, col)}
					{#if col === 'created'}
						<DateTime at={ban.createdAt} text={fmtDateTime(ban.createdAt)} />
					{:else if col === 'length'}
						{ban.expiresAt === 0
							? t('web.firewall.bans.permanent')
							: fmtSpan(ban.expiresAt - ban.createdAt)}
					{:else if col === 'source'}
						{@render sourceCell(ban)}
					{:else if col === 'ended'}
						{#if ban.state === 'active'}
							<span class="dim">–</span>
						{:else if ban.state === 'lifted' && ban.endedBy}
							{t('web.firewall.bans.liftedBy', { actor: ban.endedBy })}
						{:else}
							{t(`web.firewall.bans.state.${ban.state}`)}
						{/if}
					{:else if col === 'hits'}
						{ban.hits}
					{/if}
				{/snippet}
			</DataTable>
		{/if}
	</DetailPanel>
{/if}

<ConfirmModal
	bind:open={liftOpen}
	title={t('web.firewall.bans.liftTitle')}
	lead={lifting.length === 1
		? t('web.firewall.bans.liftLeadOne', { address: lifting[0]?.ip ?? '' })
		: t('web.firewall.bans.liftLead', { count: lifting.length })}
	notes={[
		t('web.firewall.bans.liftNote'),
		...(lifting.some((ban) => ban.source !== 'manual') ? [t('web.firewall.bans.liftAutoNote')] : [])
	]}
	confirmLabel={lifting.length === 1
		? t('web.firewall.bans.lift')
		: t('web.firewall.bans.liftCount', { count: lifting.length })}
	danger={false}
	onconfirm={() => void lift(lifting)}
/>

<style lang="scss">
	.clip {
		@include ellipsis;

		display: block;
	}

	// the strip above the table, laid out as harbor's bans view
	.head {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.75rem 1.25rem 0.5rem;
	}

	.caption {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 1rem;
		font-size: 0.875rem;

		.now {
			margin-left: auto;
			color: var(--text-secondary);
		}
	}

	.strip {
		min-width: 0;
		min-height: 5rem;
	}

	// under the table: where the countries come from
	.foot {
		display: flex;
		justify-content: flex-end;
		padding: 0.5rem 1rem;
		border-top: 0.1rem solid var(--border-divider);
	}

	.section {
		margin: 1.25rem 0 0.5rem;
		color: var(--text-heading);
		font-size: 0.875rem;
		font-weight: 600;
	}

	.none {
		margin: 0;
		font-size: 0.875rem;
	}
</style>
