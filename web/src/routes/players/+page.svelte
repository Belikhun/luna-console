<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { api, post } from '$lib/api';
	import { fmtDuration, fmtDateTime } from '$lib/format';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import MultiSelect from '$lib/components/MultiSelect.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import OverviewBar from '$lib/components/OverviewBar.svelte';
	import OverviewCell from '$lib/components/OverviewCell.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import PlayerSkin from '$lib/components/PlayerSkin.svelte';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * The player directory: every player the network has ever recorded, from
	 * LunaCore's persisted profiles — online or not. The live roster has its own
	 * screen (Online players); this one is for administration: finding a player,
	 * opening their profile, and bulk moderation across instances.
	 */

	interface Player {
		uuid: string;
		username: string;
		firstSeenAtEpochMillis: number;
		lastSeenAtEpochMillis: number;
		lastServer: string;
		lastAddress: string;
		lastClientVersion: string;
		onlineMode: boolean;
		sessionCount: number;
		hasSkin: boolean;
		online: boolean;
		server: string;
		pingMillis: number;
		sessionMillis: number;
		totalPlayMillis: number;
	}

	/** LunaCore pages at 200 max; the sweep stops here even if the DB has more. */
	const PAGE_LIMIT = 200;
	const SWEEP_CAP = 2000;

	let players: Player[] = $state([]);
	let total = $state(0);
	let available = $state(true);
	let problem = $state('');
	let loading = $state(true);
	let lastUpdated: number | null = $state(null);
	let instances: string[] = $state([]);

	let selected: Set<string> = $state(new Set());

	/** The bulk-moderation dialog: one verb applied to the selection. */
	let moderateOpen = $state(false);
	let moderateAction = $state('');
	let moderateTargets: string[] = $state([]);
	let moderateInstances: string[] = $state([]);
	let moderateReason = $state('');

	const selection = $derived(players.filter((player) => selected.has(player.uuid)));

	async function refresh(): Promise<void> {
		try {
			const collected: Player[] = [];
			let offset = 0;
			let reported = 0;

			// The directory outlives any one proxy uptime, so it can be larger than a
			// single LunaCore page; sweep until it is all here (capped defensively).
			for (;;) {
				const data = await api(`/players?limit=${PAGE_LIMIT}&offset=${offset}`);

				if (data.available === false) {
					available = false;
					problem = data.error ?? 'LunaCore is unreachable';
					loading = false;
					return;
				}

				reported = data.total ?? 0;
				collected.push(...(data.players ?? []));

				if (collected.length >= reported || collected.length >= SWEEP_CAP || !(data.players ?? []).length) {
					break;
				}

				offset = collected.length;
			}

			available = true;
			problem = '';
			players = collected;
			total = reported;
			lastUpdated = Date.now();
		} catch (err) {
			available = false;
			problem = (err as Error).message;
		}

		loading = false;
	}

	onMount(() => {
		void refresh();

		// backends the moderation verbs can target — the proxy keeps no lists
		void api('/instances').then((data) => {
			instances = data.instances
				.filter((inst: any) => inst.software !== 'velocity' && inst.name !== 'proxy')
				.map((inst: any) => inst.name)
				.sort();
		});
	});

	const columns: Column[] = [
		{ id: 'username', label: 'Player', sortable: true, minWidth: 180 },
		{ id: 'status', label: 'Status', sortable: true },
		{ id: 'lastSeen', label: 'Last seen', sortable: true },
		{ id: 'playtime', label: 'Playtime', sortable: true },
		{ id: 'sessions', label: 'Sessions', sortable: true, width: 110, align: 'right' },
		{ id: 'firstSeen', label: 'First seen', sortable: true, hidden: true },
		{ id: 'mode', label: 'Auth' },
		{ id: 'client', label: 'Client', hidden: true },
		{ id: 'address', label: 'Last address', hidden: true },
		{ id: 'uuid', label: 'UUID', width: 300, hidden: true }
	];

	const onlineCount = $derived(players.filter((player) => player.online).length);

	const filters: TableFilterGroup<Player>[] = $derived([
		{
			id: 'status',
			label: 'Filter status',
			options: [
				{ value: 'any', label: 'Any status' },
				{ value: 'online', label: `Online (${onlineCount})`, match: (player: Player) => player.online },
				{ value: 'offline', label: 'Offline', match: (player: Player) => !player.online }
			]
		},
		{
			id: 'server',
			label: 'Filter backend',
			options: [
				{ value: 'any', label: 'Any backend' },
				...[...new Set(players.map((player) => player.online ? player.server : player.lastServer))]
					.filter(Boolean)
					.sort()
					.map((name) => ({
						value: name,
						label: name,
						match: (player: Player) => (player.online ? player.server : player.lastServer) === name
					}))
			]
		}
	]);

	function sortValue(player: Player, col: string): string | number | null {
		switch (col) {
			case 'username':
				return player.username.toLowerCase();

			case 'status':
				return player.online ? 0 : 1;

			case 'lastSeen':
				return player.online ? Date.now() : player.lastSeenAtEpochMillis;

			case 'playtime':
				return player.totalPlayMillis;

			case 'sessions':
				return player.sessionCount;

			case 'firstSeen':
				return player.firstSeenAtEpochMillis;

			default:
				return null;
		}
	}

	/** Open the moderation dialog for one verb over a set of players. */
	function openModerate(action: string, targets: Player[]): void {
		moderateAction = action;
		moderateTargets = targets.map((player) => player.username);
		moderateInstances = action === 'kick' ? [] : [...instances];
		moderateReason = '';
		moderateOpen = true;
	}

	/** Verbs over a selection — the Actions dropdown and each row's menu share these. */
	function bulkActions(rows: Player[]): ContextMenuItem[] {
		const none = rows.length === 0;
		const anyOnline = rows.some((player) => player.online);

		return [
			{
				label: 'Kick from the network',
				icon: 'userSlash',
				disabled: none || !anyOnline,
				hint: none ? 'select players first' : anyOnline ? undefined : 'nobody selected is online',
				action: () => openModerate('kick', rows.filter((player) => player.online))
			},
			{ separator: true },
			{
				label: 'Add to whitelist…',
				icon: 'userTick',
				disabled: none,
				action: () => openModerate('whitelist-add', rows)
			},
			{
				label: 'Remove from whitelist…',
				icon: 'userMinus',
				disabled: none,
				action: () => openModerate('whitelist-remove', rows)
			},
			{
				label: 'Grant operator…',
				icon: 'userCog',
				disabled: none,
				action: () => openModerate('op', rows)
			},
			{
				label: 'Revoke operator…',
				icon: 'userLock',
				disabled: none,
				action: () => openModerate('deop', rows)
			},
			{ separator: true },
			{
				label: 'Ban…',
				icon: 'gavel',
				color: 'danger',
				disabled: none,
				action: () => openModerate('ban', rows)
			},
			{
				label: 'Pardon…',
				icon: 'handshake',
				disabled: none,
				action: () => openModerate('pardon', rows)
			}
		];
	}

	/** A row's menu: profile verbs first, then the bulk verbs over the selection. */
	function rowActions(player: Player): ContextMenuItem[] {
		// right-clicking inside the selection acts on all of it, outside on the row
		const rows = selected.has(player.uuid) && selection.length > 1 ? selection : [player];

		return [
			{
				label: 'View profile',
				icon: 'user',
				action: () => goto(`/players/${player.uuid}`)
			},
			{
				label: 'Copy UUID',
				icon: 'copy',
				action: () => void copy(player.uuid)
			},
			{ separator: true },
			...bulkActions(rows)
		];
	}

	async function copy(text: string): Promise<void> {
		const { copyText } = await import('$lib/clipboard');

		await copyText(text);
	}

	const ACTION_LABELS: Record<string, string> = {
		kick: 'Kick',
		'whitelist-add': 'Add to whitelist',
		'whitelist-remove': 'Remove from whitelist',
		op: 'Grant operator',
		deop: 'Revoke operator',
		ban: 'Ban',
		pardon: 'Pardon'
	};

	const needsInstances = $derived(moderateAction !== 'kick');
	const needsReason = $derived(['kick', 'ban'].includes(moderateAction));

	async function doModerate(): Promise<void> {
		moderateOpen = false;

		const label = ACTION_LABELS[moderateAction] ?? moderateAction;
		const note = Notify.loading(`${label}: ${moderateTargets.length} player(s)…`);

		try {
			const result = await post('/players/moderate', {
				action: moderateAction,
				targets: moderateTargets,
				instances: moderateInstances,
				reason: moderateReason
			});

			const outcomes: Array<{ ok: boolean; target: string; instance: string; error?: string }> =
				result.outcomes ?? [];
			const failed = outcomes.filter((outcome) => !outcome.ok);

			if (failed.length === 0) {
				note.set({
					level: 'success',
					message: `${label} applied to ${moderateTargets.length} player(s)`,
					closeable: true
				});
			} else {
				note.set({
					level: 'warning',
					message: `${label}: ${outcomes.length - failed.length}/${outcomes.length} succeeded`,
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
</script>

<svelte:head><title>Players | Luna Console</title></svelte:head>

<PageHeader
	title="Players"
	count="{selected.size ? `${selected.size}/` : ''}{players.length}"
	info
	description="Everyone the network has ever seen — profiles, playtime and moderation, recorded by LunaCore"
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="players-directory" />
		<Dropdown label="Actions" disabled={selection.length === 0} menu={bulkActions(selection)} />
		<Btn icon="userPortrait" onclick={() => goto('/players/online')}>Online players</Btn>
	{/snippet}
</PageHeader>

{#if !available}
	<Flash kind="warning">
		<b>LunaCore is not answering:</b> {problem}. The proxy may be stopped, or running a build
		without the player directory.
	</Flash>
{/if}

<OverviewBar title="Directory overview">
	<OverviewCell label="Registered players">
		{total}
	</OverviewCell>
	<OverviewCell label="Online now">
		{onlineCount}
	</OverviewCell>
	<OverviewCell label="Total playtime">
		{players.length
			? fmtDuration(players.reduce((sum, player) => sum + player.totalPlayMillis, 0))
			: '–'}
	</OverviewCell>
	<OverviewCell label="Sessions recorded">
		{players.reduce((sum, player) => sum + player.sessionCount, 0)}
	</OverviewCell>
</OverviewBar>

<div class="body">
	<Panel flush>
		<ResourceTable
			tableId="players-directory"
			initialSearch={page.url.searchParams.get('q') ?? ''}
			{columns}
			rows={players}
			getId={(player) => player.uuid}
			searchValue={(player) =>
				`${player.username} ${player.uuid} ${player.lastServer} ${player.lastAddress} ${player.lastClientVersion}`}
			searchPlaceholder="Find player by name, backend or UUID"
			selectable="multi"
			bind:selected
			{rowActions}
			rowLabel={(player) => player.username}
			noun="player"
			{sortValue}
			{filters}
			pageSize={25}
			emptyTitle="No players recorded yet"
			emptyText="Profiles appear here after the first join once LunaCore's player directory is running on the proxy."
		>
			{#snippet cell(player, col)}
				{#if col === 'username'}
					<span class="who">
						<PlayerSkin player={player.uuid} view="face" px={3} />
						<a href="/players/{player.uuid}"><b>{player.username}</b></a>
					</span>
				{:else if col === 'status'}
					{#if player.online}
						<span class="status">
							<StatusBadge state="ok" label="Online" />
							<a href="/instances/{player.server}" class="dim">{player.server}</a>
						</span>
					{:else}
						<StatusBadge state="stopped" label="Offline" />
					{/if}
				{:else if col === 'lastSeen'}
					{#if player.online}
						<span class="dim">now — on for {fmtDuration(player.sessionMillis)}</span>
					{:else if player.lastSeenAtEpochMillis}
						<span title={fmtDateTime(player.lastSeenAtEpochMillis)}>
							{fmtDateTime(player.lastSeenAtEpochMillis)}
						</span>
					{:else}
						<span class="dim">–</span>
					{/if}
				{:else if col === 'playtime'}
					{player.totalPlayMillis ? fmtDuration(player.totalPlayMillis) : '–'}
				{:else if col === 'sessions'}
					{player.sessionCount}
				{:else if col === 'firstSeen'}
					{player.firstSeenAtEpochMillis ? fmtDateTime(player.firstSeenAtEpochMillis) : '–'}
				{:else if col === 'mode'}
					<StatusBadge
						state={player.onlineMode ? 'passed' : 'warning'}
						label={player.onlineMode ? 'Premium' : 'Offline'}
					/>
				{:else if col === 'client'}
					<span class="dim">{player.lastClientVersion || '–'}</span>
				{:else if col === 'address'}
					<span class="mono dim">{player.lastAddress || '–'}</span>
				{:else if col === 'uuid'}
					<span class="mono dim">{player.uuid}</span>
				{/if}
			{/snippet}
		</ResourceTable>
	</Panel>
</div>

<Modal title="{ACTION_LABELS[moderateAction] ?? moderateAction}: {moderateTargets.length} player(s)" bind:open={moderateOpen}>
	<p class="targets">
		{moderateTargets.join(', ')}
	</p>

	{#if needsInstances}
		<div class="field">
			<span class="lbl">Instances</span>
			<span class="hint">The change is applied on each selected instance</span>
			<MultiSelect
				bind:value={moderateInstances}
				width="100%"
				options={instances.map((name) => ({ value: name, label: name }))}
			/>
		</div>
	{/if}

	{#if needsReason}
		<label class="field">
			<span class="lbl">Reason</span>
			<span class="hint">Optional — recorded in the moderation log{moderateAction === 'ban' ? ' and shown to the player' : ''}</span>
			<input class="input" bind:value={moderateReason} placeholder="e.g. griefing on survival" />
		</label>
	{/if}

	{#snippet footer()}
		<Btn onclick={() => (moderateOpen = false)}>Cancel</Btn>
		<Btn
			variant={moderateAction === 'ban' || moderateAction === 'kick' ? 'danger' : 'primary'}
			disabled={needsInstances && moderateInstances.length === 0}
			onclick={doModerate}
		>
			{ACTION_LABELS[moderateAction] ?? 'Apply'}
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

	.who {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}

	.status {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}

	.targets {
		color: var(--text-secondary);
		word-break: break-word;
	}
</style>
