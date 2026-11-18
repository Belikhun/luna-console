<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';

	import { api } from '$lib/api';
	import { copyText } from '$lib/clipboard';
	import { countryName, firewallHref, reasonLabel, REFUSAL_REASONS, ruleTitle } from '$lib/firewall';
	import { fmtDateTime } from '$lib/format';
	import { currentLanguage, t } from '$lib/i18n.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import CellStack from '$lib/components/CellStack.svelte';
	import ChartPanel from '$lib/components/ChartPanel.svelte';
	import CountryName from '$lib/components/CountryName.svelte';
	import DateTime from '$lib/components/DateTime.svelte';
	import GeoAttribution from '$lib/components/GeoAttribution.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import RankedList from '$lib/components/RankedList.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import SegmentedControl from '$lib/components/SegmentedControl.svelte';
	import SeriesTable from '$lib/components/SeriesTable.svelte';
	import StackedBars from '$lib/components/StackedBars.svelte';
	import StatGrid from '$lib/components/StatGrid.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { fmtMoment, type Series, type SeriesStyle } from '$lib/components/chart';
	import { menuGroups, type ContextMenuItem } from '$lib/components/contextmenu';
	import type { RankedRow } from '$lib/components/ranked';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import type { FirewallActivity, FirewallRule, Refusal, TopRefused } from '$shared/firewall';

	/**
	 * What the proxy turned away over a window: refusals per hour by reason, the
	 * addresses and countries refused most, and the latest refusals one by one.
	 * The range and an address filter live in the address bar.
	 */
	let {
		rules,
		bannedNow,
		canBan,
		canConfigure,
		total = $bindable(),
		onban,
		onaddrule
	}: {
		rules: FirewallRule[];
		/** Addresses banned right now, for the ban verbs */
		bannedNow: Set<string>;
		canBan: boolean;
		canConfigure: boolean;
		/** Refusals in the range, for the page header's count */
		total: number | undefined;
		onban: (address: string) => void;
		onaddrule: (preset: { action: 'allow' | 'deny'; addresses?: string[]; countries?: string[] }) => void;
	} = $props();

	const RANGES = ['24h', '7d', '30d', '90d'] as const;
	const HOUR = 3_600_000;
	const DAY = 24 * HOUR;
	const NO_COUNTRY = '??';

	type Range = (typeof RANGES)[number];

	const range = $derived.by((): Range => {
		const wanted = page.url.searchParams.get('range') as Range | null;

		return wanted && RANGES.includes(wanted)
			? wanted
			: '24h';
	});
	const address = $derived(page.url.searchParams.get('address')?.trim() ?? '');
	const ruleFilter = $derived(page.url.searchParams.get('rule')?.trim() ?? '');

	let activity = $state<(FirewallActivity & { countries: Record<string, string | null> }) | null>(null);
	let error = $state('');
	let loaded = $state(false);
	let serial = 0;

	/** Read the window again; the page's refresh calls this too. */
	export async function load(): Promise<void> {
		const mine = ++serial;
		const query = new URLSearchParams({ range });

		if (address) {
			query.set('ip', address);
		}

		try {
			const answer = await api(`/firewall/activity?${query}`);

			if (mine !== serial) {
				return;
			}

			if (!answer.available) {
				error = answer.error ?? '';
				activity = null;
			} else {
				error = '';
				activity = answer;
			}
		} catch (err) {
			if (mine === serial) {
				error = (err as Error).message;
			}
		} finally {
			if (mine === serial) {
				loaded = true;
			}
		}
	}

	$effect(() => {
		void range;
		void address;
		untrack(() => void load());
	});

	function navigate(query: Record<string, string | null>): void {
		const url = new URL(page.url);

		for (const [key, value] of Object.entries(query)) {
			if (value === null || value === '') {
				url.searchParams.delete(key);
			} else {
				url.searchParams.set(key, value);
			}
		}

		void goto(`${url.pathname}${url.search}`, { noScroll: true, keepFocus: true });
	}

	const span = $derived(activity
		? { from: activity.from, to: activity.to }
		: { from: Date.now() - 86_400_000, to: Date.now() });

	// a bar an hour reads up to a week; past that the same counts are piled per day
	const daily = $derived(range === '30d' || range === '90d');
	const step = $derived(daily ? DAY : HOUR);

	/** The start of the bucket an hour falls in: the hour itself, or its local day. */
	function bucketOf(hour: number): number {
		if (!daily) {
			return hour;
		}

		const day = new Date(hour);

		day.setHours(0, 0, 0, 0);

		return day.getTime();
	}

	const buckets = $derived.by((): number[] => {
		const out: number[] = [];

		for (let at = bucketOf(span.from - (span.from % HOUR)); at < span.to; at += step) {
			out.push(at);
		}

		return out;
	});

	// one point per bucket of the window for every reason, so the stack has no gaps
	const series = $derived.by((): Series[] => {
		if (!activity) {
			return [];
		}

		const counts = new Map<string, number>();

		for (const row of activity.hourly) {
			const key = `${row.reason}|${bucketOf(row.hour)}`;

			counts.set(key, (counts.get(key) ?? 0) + row.count);
		}

		const present = new Set(activity.hourly.map((row) => row.reason as string));

		return REFUSAL_REASONS
			.filter((reason) => present.has(reason))
			.map((reason) => ({
				key: reason,
				unit: 'count' as const,
				points: buckets.map((at): [number, number] => [at, counts.get(`${reason}|${at}`) ?? 0])
			}));
	});

	const styles: Record<string, SeriesStyle> = $derived({
		ban: { label: reasonLabel('ban'), color: 'var(--error)' },
		rule: { label: reasonLabel('rule'), color: 'var(--warning)' },
		loginFlood: { label: reasonLabel('loginFlood') },
		pingScan: { label: reasonLabel('pingScan') },
		failedLogins: { label: reasonLabel('failedLogins') },
		suspiciousNames: { label: reasonLabel('suspiciousNames') }
	});

	// every reason piled into one count per bucket: the tile's spark and the busiest bucket
	const totals = $derived.by((): Series => {
		const sums = new Map<number, number>();

		for (const entry of series) {
			for (const [at, value] of entry.points) {
				sums.set(at, (sums.get(at) ?? 0) + (value ?? 0));
			}
		}

		return {
			key: 'refused',
			unit: 'count',
			points: buckets.map((at): [number, number] => [at, sums.get(at) ?? 0])
		};
	});

	const busiest = $derived.by((): { at: number; count: number } | null => {
		let best: { at: number; count: number } | null = null;

		for (const [at, value] of totals.points) {
			if (value !== null && value > 0 && (!best || value > best.count)) {
				best = { at, count: value };
			}
		}

		return best;
	});

	/** When the busiest bucket was: a day by its date alone, an hour with its time. */
	function busiestWhen(at: number): string {
		return daily
			? new Date(at).toLocaleDateString(currentLanguage(), { day: 'numeric', month: 'short' })
			: fmtMoment(at, span.to - span.from);
	}

	const byReason = $derived.by((): Map<string, number> => {
		const sums = new Map<string, number>();

		for (const row of activity?.hourly ?? []) {
			sums.set(row.reason, (sums.get(row.reason) ?? 0) + row.count);
		}

		return sums;
	});

	const byBan = $derived(byReason.get('ban') ?? 0);
	const byRule = $derived(byReason.get('rule') ?? 0);

	const refused = $derived(activity?.hourly.reduce((sum, row) => sum + row.count, 0) ?? 0);
	// what is left once bans and rules are counted: the refusals that made a detector ban
	const byDetector = $derived(refused - byBan - byRule);

	function share(count: number): string | undefined {
		if (refused === 0) {
			return undefined;
		}

		return t('web.firewall.activity.shareOf', { share: `${Math.round((count / refused) * 100)}%` });
	}

	const reasonRows = $derived(REFUSAL_REASONS
		.filter((reason) => (byReason.get(reason) ?? 0) > 0)
		.map((reason): RankedRow => ({
			key: reason,
			label: reasonLabel(reason),
			count: byReason.get(reason) ?? 0,
			icon: reason === 'ban'
				? 'ban'
				: reason === 'rule'
					? 'shieldCheck'
					: 'robot'
		}))
		.sort((left, right) => right.count - left.count));

	$effect(() => {
		total = activity
			? refused
			: undefined;
	});

	const recent = $derived((activity?.recent ?? []).filter((row) => ruleFilter === '' || (row.reason === 'rule' && row.detail === ruleFilter)));
	const countryOf = (ip: string): string | null => activity?.countries[ip] ?? null;

	// the most refused addresses carry the range's own counts, so the countries are summed from them
	const topCountries = $derived.by((): RankedRow[] => {
		const counts = new Map<string, number>();

		for (const row of activity?.top ?? []) {
			const country = countryOf(row.ip) ?? NO_COUNTRY;

			counts.set(country, (counts.get(country) ?? 0) + row.count);
		}

		return [...counts]
			.map(([code, count]): RankedRow => ({
				key: code,
				label: code === NO_COUNTRY
					? t('web.countries.unknown')
					: `${code} ${countryName(code)}`,
				count
			}))
			.sort((left, right) => right.count - left.count);
	});

	const countriesTotal = $derived(topCountries.reduce((sum, row) => sum + row.count, 0));
	const countriesKnown = $derived(topCountries.some((row) => row.key !== NO_COUNTRY));

	function addressMenu(ip: string, username = ''): ContextMenuItem[] {
		const banned = bannedNow.has(ip);

		return menuGroups(
			[
				{
					label: t('web.firewall.bans.check'),
					icon: 'magnifyingGlass',
					action: () => goto(firewallHref('check', { address: ip }))
				},
				{
					label: t('web.firewall.activity.viewPlayer'),
					icon: 'user',
					disabled: username === '',
					hint: username === '' ? t('web.firewall.activity.noUsername') : undefined,
					action: () => goto(`/players/${encodeURIComponent(username)}`)
				},
				{
					label: t('web.firewall.bans.refusals'),
					icon: 'clock',
					action: () => navigate({ address: ip })
				}
			],
			[
				{
					label: t('web.firewall.ban.action'),
					icon: 'ban',
					color: 'danger',
					disabled: banned || !canBan,
					hint: !canBan
						? t('web.common.notAllowed', { action: 'player:Moderate' })
						: banned
							? t('web.firewall.activity.alreadyBanned')
							: undefined,
					action: () => onban(ip)
				},
				{
					label: t('web.firewall.activity.allowRule'),
					icon: 'plus',
					disabled: !canConfigure,
					hint: canConfigure ? undefined : t('web.common.notAllowed', { action: 'firewall:Configure' }),
					action: () => onaddrule({ action: 'allow', addresses: [ip] })
				}
			],
			[
				{
					label: t('web.firewall.bans.copy'),
					icon: 'copy',
					action: async () => {
						if (await copyText(ip)) {
							Notify.success(t('web.firewall.bans.copied'));
						}
					}
				},
				...(username
					? [{
						label: t('web.firewall.activity.copyUsername'),
						icon: 'copy',
						action: async () => {
							if (await copyText(username)) {
								Notify.success(t('web.firewall.activity.copiedUsername'));
							}
						}
					}]
					: [])
			]
		);
	}

	function rowId(row: Refusal): string {
		return `${row.at}|${row.ip}|${row.kind}|${row.reason}`;
	}

	function matchOf(row: Refusal): { label: string; href: string } | null {
		if (row.reason === 'rule') {
			const rule = rules.find((entry) => entry.id === row.detail);

			return {
				label: rule ? ruleTitle(rule) : row.detail,
				href: firewallHref('rules', { q: row.detail })
			};
		}

		if (row.reason === 'ban') {
			return { label: row.detail, href: firewallHref('bans', { q: row.detail }) };
		}

		return null;
	}

	const columns: Column[] = $derived([
		{ id: 'time', label: t('web.firewall.activity.col.time'), sortable: true, width: 170 },
		{ id: 'address', label: t('web.firewall.activity.col.address'), sortable: true, width: 220 },
		{ id: 'country', label: t('web.firewall.activity.col.country'), sortable: true, width: 180 },
		{ id: 'player', label: t('web.firewall.activity.col.player'), sortable: true, width: 180 },
		{ id: 'kind', label: t('web.firewall.activity.col.kind'), sortable: true, width: 150 },
		{ id: 'reason', label: t('web.firewall.activity.col.reason'), sortable: true, width: 190 },
		{ id: 'match', label: t('web.firewall.activity.col.match'), minWidth: 200 },
		{ id: 'count', label: t('web.firewall.activity.col.count'), sortable: true, width: 90, align: 'right' }
	]);

	const topColumns: Column[] = $derived([
		{ id: 'address', label: t('web.firewall.activity.col.address'), width: 220 },
		{ id: 'country', label: t('web.firewall.activity.col.country'), width: 180 },
		{ id: 'count', label: t('web.firewall.activity.col.refused'), width: 110, align: 'right' },
		{ id: 'share', label: t('web.firewall.activity.col.share'), width: 90, align: 'right' },
		{ id: 'lastAt', label: t('web.firewall.activity.col.lastAt'), width: 180 },
		{ id: 'player', label: t('web.firewall.activity.col.lastPlayer'), width: 180 },
		{ id: 'banned', label: t('web.firewall.activity.col.status'), minWidth: 120 }
	]);

	const filters: TableFilterGroup<Refusal>[] = $derived([
		{
			id: 'reason',
			label: t('web.firewall.activity.filterReason'),
			options: [
				{ value: 'any', label: t('web.firewall.activity.anyReason') },
				...REFUSAL_REASONS.map((reason) => ({ value: reason, label: reasonLabel(reason), match: (row: Refusal) => row.reason === reason }))
			]
		},
		{
			id: 'kind',
			label: t('web.firewall.activity.filterKind'),
			options: [
				{ value: 'any', label: t('web.firewall.activity.anyKind') },
				{ value: 'login', label: t('web.firewall.activity.kind.login'), match: (row) => row.kind === 'login' },
				{ value: 'ping', label: t('web.firewall.activity.kind.ping'), match: (row) => row.kind === 'ping' }
			]
		}
	]);

	function sortValue(row: Refusal, col: string): string | number | null {
		switch (col) {
			case 'time':
				return row.at;
			case 'address':
				return row.ip;
			case 'country':
				return countryOf(row.ip) ?? '';
			case 'player':
				return row.username;
			case 'kind':
				return row.kind;
			case 'reason':
				return row.reason;
			case 'count':
				return row.count;
			default:
				return null;
		}
	}

	const filterRule = $derived(ruleFilter ? rules.find((rule) => rule.id === ruleFilter) : undefined);
</script>

<div class="rangebar">
	<span class="dim">{t(daily ? 'web.firewall.activity.rangeHintDaily' : 'web.firewall.activity.rangeHint')}</span>
	<SegmentedControl
		label={t('web.monitor.range')}
		value={range}
		options={RANGES.map((id) => ({ id, label: t(`web.monitor.ranges.${id}`) }))}
		size="small"
		onchange={(id) => navigate({ range: id === '24h' ? null : id })}
	/>
</div>

<StatGrid min={11}>
	<StatTile
		label={t('web.firewall.activity.tile.refused')}
		value={activity ? refused : null}
		secondary={t(`web.monitor.rangeLabel.${range}`)}
		spark={refused > 0 ? totals : undefined}
		loading={!loaded}
	/>
	<StatTile
		label={t(daily ? 'web.firewall.activity.tile.busiestDay' : 'web.firewall.activity.tile.busiestHour')}
		value={activity ? (busiest?.count ?? 0) : null}
		secondary={busiest ? busiestWhen(busiest.at) : t('web.firewall.activity.tile.quiet')}
		loading={!loaded}
	/>
	<StatTile
		label={t('web.firewall.activity.tile.byBan')}
		value={activity ? byBan : null}
		secondary={share(byBan)}
		info={t('web.firewall.activity.tile.byBanInfo')}
		loading={!loaded}
	/>
	<StatTile
		label={t('web.firewall.activity.tile.byRule')}
		value={activity ? byRule : null}
		secondary={share(byRule)}
		info={t('web.firewall.activity.tile.byRuleInfo')}
		loading={!loaded}
	/>
	<StatTile
		label={t('web.firewall.activity.tile.byDetector')}
		value={activity ? byDetector : null}
		secondary={share(byDetector)}
		info={t('web.firewall.activity.tile.byDetectorInfo')}
		loading={!loaded}
	/>
</StatGrid>

<ChartPanel
	title={t('web.firewall.activity.chartTitle')}
	description={t(`web.monitor.rangeLabel.${range}`)}
	info={t('web.firewall.activity.chartInfo')}
	headline={loaded && activity ? String(refused) : undefined}
	status={!loaded ? 'loading' : error ? 'error' : series.length === 0 ? 'empty' : 'ready'}
	error={error || undefined}
	onretry={load}
	emptyTitle={t('web.firewall.activity.emptyChartTitle')}
	emptyText={t('web.firewall.activity.emptyChartText')}
	height={12}
>
	{#snippet table()}
		<SeriesTable {series} {styles} formatValue={(value) => String(Math.round(value))} />
	{/snippet}
	<StackedBars
		{series}
		label={t('web.firewall.activity.chartTitle')}
		{styles}
		from={span.from}
		to={span.to}
		height={12}
		formatValue={(value) => String(Math.round(value))}
	/>
</ChartPanel>

{#if !error}
	<div class="pair">
		<Panel title={t('web.firewall.activity.byReason')}>
			<RankedList
				rows={reasonRows}
				label={t('web.firewall.activity.byReason')}
				nameHeader={t('web.firewall.activity.col.reason')}
				valueHeader={t('web.firewall.activity.col.refused')}
				total={refused || undefined}
				empty={loaded ? t('web.firewall.activity.noneInRange') : t('web.common.loading')}
			/>
		</Panel>
		<Panel title={t('web.firewall.activity.byCountry')}>
			<RankedList
				rows={topCountries}
				label={t('web.firewall.activity.byCountry')}
				nameHeader={t('web.firewall.activity.col.country')}
				valueHeader={t('web.firewall.activity.col.refused')}
				total={countriesTotal || undefined}
				empty={loaded ? t('web.firewall.activity.noneInRange') : t('web.common.loading')}
				onselect={(row) => {
					if (canConfigure && row.key !== NO_COUNTRY) {
						onaddrule({ action: 'deny', countries: [row.key] });
					}
				}}
			/>
			{#if countriesKnown}
				<p class="listnote"><GeoAttribution /></p>
			{/if}
		</Panel>
	</div>

	<Panel title={t('web.firewall.activity.topAddresses')} count={activity?.top.length} flush>
		<ResourceTable
			tableId="network-firewall-top"
			loading={!loaded}
			columns={topColumns}
			rows={activity?.top ?? []}
			getId={(row: TopRefused) => row.ip}
			selectable="none"
			searchable={false}
			paging={false}
			noun={t('web.firewall.activity.addressNoun')}
			rowLabel={(row: TopRefused) => row.ip}
			rowActions={(row: TopRefused) => addressMenu(row.ip, row.username)}
			onRowDblClick={(row: TopRefused) => void goto(firewallHref('check', { address: row.ip }))}
			emptyTitle={t('web.firewall.activity.noneInRange')}
		>
			{#snippet cell(row: TopRefused, col)}
				{#if col === 'address'}
					<b class="mono">{row.ip}</b>
				{:else if col === 'country'}
					<CountryName code={countryOf(row.ip)} empty />
				{:else if col === 'count'}
					{row.count}
				{:else if col === 'share'}
					<span class="dim">{refused > 0 ? `${Math.round((row.count / refused) * 100)}%` : '–'}</span>
				{:else if col === 'lastAt'}
					<span class="dim"><DateTime at={row.lastAt} text={fmtDateTime(row.lastAt)} /></span>
				{:else if col === 'player'}
					{#if row.username}
						<a href="/players/{encodeURIComponent(row.username)}">{row.username}</a>
					{:else}
						<span class="dim">–</span>
					{/if}
				{:else if col === 'banned'}
					{#if bannedNow.has(row.ip)}
						<StatusBadge state="failed" label={t('web.firewall.activity.bannedNow')} />
					{:else}
						<span class="dim">{t('web.firewall.activity.notBannedNow')}</span>
					{/if}
				{/if}
			{/snippet}
		</ResourceTable>
	</Panel>
{/if}

{#if address || ruleFilter}
	<Flash kind="info" dismiss={() => navigate({ address: null, rule: null })}>
		{address
			? t('web.firewall.activity.filteredAddress', { address })
			: t('web.firewall.activity.filteredRule', { rule: filterRule ? ruleTitle(filterRule) : ruleFilter })}
	</Flash>
{/if}

<Panel title={t('web.firewall.activity.recentTitle')} count={recent.length} flush>
	<ResourceTable
		tableId="network-firewall-refusals"
		loading={!loaded}
		{columns}
		{filters}
		rows={recent}
		getId={rowId}
		initialSearch={page.url.searchParams.get('q') ?? ''}
		searchValue={(row) => {
			const country = countryOf(row.ip);

			return [row.ip, row.username, country, country ? countryName(country) : '', reasonLabel(row.reason)].join(' ');
		}}
		searchPlaceholder={t('web.firewall.activity.search')}
		selectable="none"
		rowActions={(row) => addressMenu(row.ip, row.username)}
		rowLabel={(row) => row.ip}
		noun={t('web.firewall.activity.noun')}
		defaultSort={{ col: 'time', dir: 'desc' }}
		{sortValue}
		emptyTitle={t('web.firewall.activity.emptyTitle')}
		emptyText={error || t('web.firewall.activity.emptyText')}
	>
		{#snippet cell(row, col)}
			{#if col === 'time'}
				<DateTime at={row.at} text={fmtDateTime(row.at)} />
			{:else if col === 'address'}
				<b class="mono">{row.ip}</b>
			{:else if col === 'country'}
				<CountryName code={countryOf(row.ip)} empty />
			{:else if col === 'player'}
				{#if row.username}
					<a href="/players/{encodeURIComponent(row.username)}">{row.username}</a>
				{:else}
					<span class="dim">–</span>
				{/if}
			{:else if col === 'kind'}
				{t(`web.firewall.activity.kind.${row.kind}`)}
			{:else if col === 'reason'}
				<StatusBadge state={row.reason === 'ban' ? 'failed' : 'warning'} label={reasonLabel(row.reason)} />
			{:else if col === 'match'}
				{@const match = matchOf(row)}
				{#if match}
					<a href={match.href}>{match.label}</a>
				{:else if row.detail}
					<span class="dim">{row.detail}</span>
				{:else}
					<span class="dim">–</span>
				{/if}
			{:else if col === 'count'}
				{#if row.count > 1}
					<CellStack align="right">
						{#snippet main()}
							{row.count}
						{/snippet}
						{#snippet sub()}
							{t('web.firewall.activity.inMinute')}
						{/snippet}
					</CellStack>
				{:else}
					{row.count}
				{/if}
			{/if}
		{/snippet}
	</ResourceTable>
</Panel>

<style lang="scss">
	// what the bars count on the left, the window on the right
	.rangebar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem 1rem;

		.dim {
			font-size: 0.875rem;
		}
	}

	.pair {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem;

		@include below($bp-medium) {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.listnote {
		margin: 0.5rem 0 0;
		text-align: right;
	}
</style>
