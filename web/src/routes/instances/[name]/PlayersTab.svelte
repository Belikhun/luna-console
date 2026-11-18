<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { t } from '$lib/i18n.svelte';
	import { accessIndexOf } from '$lib/players';
	import type { AccessSnapshot } from '$lib/players';
	import AccessLists from '$lib/components/AccessLists.svelte';
	import InstanceKnownPlayers from '$lib/components/InstanceKnownPlayers.svelte';
	import InstanceOnlinePlayers from '$lib/components/InstanceOnlinePlayers.svelte';
	import SegmentedControl from '$lib/components/SegmentedControl.svelte';
	import Select from '$lib/components/Select.svelte';
	import StatGrid from '$lib/components/StatGrid.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import { loadInterval } from '$lib/components/refresh';

	/**
	 * An instance's players and access lists, one view at a time: who is on, who
	 * has ever joined, and each access list. The tiles above say how big each
	 * one is and open it, so the whole picture is on screen without five tables
	 * stacked under each other.
	 *
	 * Every view stays mounted, hidden while another is shown: the tiles need
	 * each one's count, and a view keeps its search, filters, page and selection
	 * when the operator comes back to it.
	 */
	let {
		instance,
		refreshKey = 0,
		refreshStorageKey
	}: {
		instance: string;
		/** Bumped by the instance screen on each tick of its refresh control */
		refreshKey?: number;
		/** The refresh control's storage key: a roster change reloads only while auto-refresh is on */
		refreshStorageKey?: string;
	} = $props();

	const VIEWS = ['online', 'known', 'whitelist', 'ops', 'bans'] as const;

	type View = (typeof VIEWS)[number];

	const view = $derived.by((): View => {
		const wanted = page.url.searchParams.get('view') ?? '';

		return (VIEWS as readonly string[]).includes(wanted)
			? (wanted as View)
			: 'online';
	});

	let onlineCount = $state<number | null>(null);
	let knownCount = $state<number | null>(null);
	let recentCount = $state<number | null>(null);
	let lists = $state<AccessSnapshot | null>(null);
	let accessLists: AccessLists | undefined = $state();

	/** Roster changes the proxy pushed; folded into the key the tables reload on. */
	let rosterTicks = $state(0);

	const tableKey = $derived(refreshKey + rosterTicks);
	const access = $derived(lists ? accessIndexOf(lists) : null);

	onMount(() => {
		// a join or a leave is what a poll interval feels slow for. It is still a
		// reload, so it follows the refresh control: switched off, nothing reloads.
		const stream = new EventSource('/api/luna/stream?stream=players');

		stream.onmessage = () => {
			if (loadInterval(refreshStorageKey) > 0) {
				rosterTicks++;
			}
		};

		return () => stream.close();
	});

	function viewHref(next: View): string {
		const url = new URL(page.url);

		if (next === 'online') {
			url.searchParams.delete('view');
		} else {
			url.searchParams.set('view', next);
		}

		return `${url.pathname}${url.search}`;
	}

	function setView(next: string): void {
		void goto(viewHref(next as View), { replaceState: true, noScroll: true, keepFocus: true });
	}

	const viewOptions = $derived([
		{ id: 'online', label: t('web.instancePlayersTab.viewOnline'), badge: onlineCount ?? undefined },
		{ id: 'known', label: t('web.instancePlayersTab.viewKnown'), badge: knownCount ?? undefined },
		{ id: 'whitelist', label: t('web.access.whitelist'), badge: lists?.whitelist.length },
		{ id: 'ops', label: t('web.access.operators'), badge: lists?.ops.length },
		{
			id: 'bans',
			label: t('web.instancePlayersTab.viewBans'),
			badge: lists ? lists.bans.length + lists.ipBans.length : undefined
		}
	]);

	const whitelistNote = $derived.by(() => {
		if (!lists) {
			return undefined;
		}

		if (!lists.whitelistEnabled) {
			return t('web.instancePlayersTab.whitelistOff');
		}

		return lists.enforceWhitelist
			? t('web.instancePlayersTab.whitelistEnforced')
			: t('web.instancePlayersTab.whitelistOn');
	});
</script>

<div class="players">
	<StatGrid min={10}>
		<StatTile
			label={t('web.instancePlayersTab.tileOnline')}
			value={onlineCount}
			loading={onlineCount === null && knownCount === null}
			href={viewHref('online')}
		/>
		<StatTile
			label={t('web.instancePlayersTab.tileKnown')}
			value={knownCount}
			secondary={recentCount === null ? undefined : t('web.instancePlayersTab.seenThisWeek', { count: recentCount })}
			loading={knownCount === null}
			href={viewHref('known')}
		/>
		<StatTile
			label={t('web.instancePlayersTab.tileWhitelisted')}
			value={lists?.whitelist.length ?? null}
			secondary={whitelistNote}
			info={t('web.instancePlayersTab.whitelistInfo')}
			loading={lists === null}
			href={viewHref('whitelist')}
		/>
		<StatTile
			label={t('web.access.operators')}
			value={lists?.ops.length ?? null}
			loading={lists === null}
			href={viewHref('ops')}
		/>
		<StatTile
			label={t('web.instancePlayersTab.tileBanned')}
			value={lists?.bans.length ?? null}
			secondary={lists ? t('web.instancePlayersTab.addressesBanned', { count: lists.ipBans.length }) : undefined}
			tone={lists && lists.bans.length > 0 ? 'warning' : 'default'}
			loading={lists === null}
			href={viewHref('bans')}
		/>
	</StatGrid>

	<div class="views">
		<div class="segments">
			<SegmentedControl
				options={viewOptions}
				value={view}
				label={t('web.instancePlayersTab.viewLabel')}
				onchange={setView}
			/>
		</div>
		<div class="picker">
			<Select
				ariaLabel={t('web.instancePlayersTab.viewLabel')}
				value={view}
				options={viewOptions.map((option) => ({ value: option.id, label: option.label }))}
				onchange={setView}
			/>
		</div>
	</div>

	<div class="view" class:off={view !== 'online'}>
		<InstanceOnlinePlayers
			{instance}
			{access}
			refreshKey={tableKey}
			bind:count={onlineCount}
			onchanged={() => void accessLists?.refresh()}
		/>
	</div>

	<div class="view" class:off={view !== 'known'}>
		<InstanceKnownPlayers
			{instance}
			{access}
			refreshKey={tableKey}
			bind:count={knownCount}
			bind:recent={recentCount}
			onchanged={() => void accessLists?.refresh()}
		/>
	</div>

	<div class="view" class:off={view === 'online' || view === 'known'}>
		<AccessLists
			bind:this={accessLists}
			{instance}
			view={view === 'online' || view === 'known' ? 'whitelist' : view}
			{refreshKey}
			bind:lists
		/>
	</div>
</div>

<style lang="scss">
	.players {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.views {
		min-width: 0;
		max-width: 100%;

		.picker {
			display: none;
			min-width: 12rem;
		}

		@include below($bp-medium) {
			.segments {
				display: none;
			}

			.picker {
				display: block;
			}
		}
	}

	.view.off {
		display: none;
	}
</style>
