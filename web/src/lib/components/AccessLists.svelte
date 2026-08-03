<script lang="ts">
	import { onMount } from 'svelte';
	import { api, post } from '$lib/api';
	import Panel from './Panel.svelte';
	import Btn from './Btn.svelte';
	import Select from './Select.svelte';
	import Toggle from './Toggle.svelte';
	import Flash from './Flash.svelte';
	import DataTable from './DataTable.svelte';
	import StatusBadge from './StatusBadge.svelte';
	import type { Column } from './table';
	import type { ContextMenuItem } from './contextmenu';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * One instance's player access lists: whitelist, operators, player bans and
	 * IP bans, with the whitelist on/off switch.
	 *
	 * Changes go to the daemon, which uses the running server's console when the
	 * instance is up (so vanilla persists the files itself) and edits the JSON
	 * directly when it is stopped — the state note above the lists says which.
	 */

	let { instance }: { instance: string } = $props();

	interface WhitelistEntry {
		uuid: string;
		name: string;
	}

	interface OpEntry {
		uuid: string;
		name: string;
		level: number;
		bypassesPlayerLimit: boolean;
	}

	interface BanEntry {
		uuid: string;
		name: string;
		created: string;
		source: string;
		expires: string;
		reason?: string;
	}

	interface IpBanEntry {
		ip: string;
		created: string;
		source: string;
		expires: string;
		reason?: string;
	}

	let instState = $state('stopped');
	let whitelistEnabled = $state(false);
	let enforceWhitelist = $state(false);
	let whitelist: WhitelistEntry[] = $state([]);
	let ops: OpEntry[] = $state([]);
	let bans: BanEntry[] = $state([]);
	let ipBans: IpBanEntry[] = $state([]);
	let problem = $state('');
	let loaded = $state(false);

	let addList = $state('whitelist');
	let addTarget = $state('');
	let addReason = $state('');

	async function refresh(): Promise<void> {
		try {
			const data = await api(`/instances/${instance}/access`);

			instState = data.state ?? 'stopped';
			whitelistEnabled = data.whitelistEnabled ?? false;
			enforceWhitelist = data.enforceWhitelist ?? false;
			whitelist = data.whitelist ?? [];
			ops = data.ops ?? [];
			bans = data.bans ?? [];
			ipBans = data.ipBans ?? [];
			problem = '';
		} catch (err) {
			problem = (err as Error).message;
		}

		loaded = true;
	}

	onMount(() => {
		void refresh();
	});

	async function change(
		list: string,
		action: 'add' | 'remove',
		target: string,
		reason = ''
	): Promise<void> {
		const note = Notify.loading(`${action === 'add' ? 'Adding' : 'Removing'} ${target}…`);

		try {
			const result = await post(`/instances/${instance}/access`, {
				kind: 'change',
				list,
				action,
				target,
				reason
			});

			if (!result.ok) {
				throw new Error(result.result?.error ?? 'the change was not applied');
			}

			note.set({
				level: 'success',
				message: `${target} ${action === 'add' ? 'added to' : 'removed from'} ${list} (${result.result.method})`,
				closeable: true
			});

			await refresh();
		} catch (err) {
			note.set({
				level: 'error',
				message: `Change to ${list} failed`,
				detail: (err as Error).message,
				closeable: true
			});
		}
	}

	async function toggleWhitelist(enabled: boolean): Promise<void> {
		const note = Notify.loading(`Turning the whitelist ${enabled ? 'on' : 'off'}…`);

		try {
			await post(`/instances/${instance}/access`, { kind: 'whitelist', enabled });

			note.set({
				level: 'success',
				message: `Whitelist is now ${enabled ? 'on' : 'off'}`,
				closeable: true
			});

			await refresh();
		} catch (err) {
			note.set({
				level: 'error',
				message: 'Whitelist toggle failed',
				detail: (err as Error).message,
				closeable: true
			});
		}
	}

	function doAdd(): void {
		const target = addTarget.trim();

		if (!target) {
			return;
		}

		void change(addList, 'add', target, addReason.trim());
		addTarget = '';
		addReason = '';
	}

	const whitelistCols: Column[] = [
		{ id: 'name', label: 'Player', sortable: true },
		{ id: 'uuid', label: 'UUID' }
	];

	const opCols: Column[] = [
		{ id: 'name', label: 'Player', sortable: true },
		{ id: 'level', label: 'Level', width: 90, align: 'right' },
		{ id: 'uuid', label: 'UUID' }
	];

	const banCols: Column[] = [
		{ id: 'name', label: 'Player', sortable: true },
		{ id: 'created', label: 'Banned', sortable: true },
		{ id: 'source', label: 'By' },
		{ id: 'expires', label: 'Expires' },
		{ id: 'reason', label: 'Reason' }
	];

	const ipBanCols: Column[] = [
		{ id: 'ip', label: 'Address', sortable: true },
		{ id: 'created', label: 'Banned', sortable: true },
		{ id: 'source', label: 'By' },
		{ id: 'reason', label: 'Reason' }
	];

	function removeAction(list: string, target: string, label: string): ContextMenuItem[] {
		return [
			{
				label,
				icon: 'trash',
				color: 'danger',
				action: () => void change(list, 'remove', target)
			}
		];
	}
</script>

{#if problem}
	<Flash kind="error"><b>Access lists unavailable:</b> {problem}</Flash>
{:else if loaded}
	<Panel
		title="Whitelist"
		count={whitelist.length}
		description={instState === 'running'
			? 'The server is running — changes are applied live through its console'
			: 'The server is stopped — changes are written straight into its files'}
		flush
	>
		{#snippet actions()}
			<span class="wl">
				<Toggle
					checked={whitelistEnabled}
					label="Whitelist enabled"
					onchange={(checked) => void toggleWhitelist(checked)}
				/>
				<span class="wl-label">
					{whitelistEnabled ? 'On — only listed players may join' : 'Off — everyone may join'}
				</span>
				{#if whitelistEnabled && enforceWhitelist}
					<StatusBadge state="warning" label="enforced" />
				{/if}
			</span>
		{/snippet}

		<div class="add">
			<Select
				bind:value={addList}
				options={[
					{ value: 'whitelist', label: 'Whitelist' },
					{ value: 'ops', label: 'Operators' },
					{ value: 'bans', label: 'Player bans' },
					{ value: 'ban-ips', label: 'IP bans' }
				]}
				width="11rem"
			/>
			<input
				class="input target"
				bind:value={addTarget}
				placeholder={addList === 'ban-ips' ? 'IP address' : 'Player name'}
				onkeydown={(event) => {
					if (event.key === 'Enter') {
						doAdd();
					}
				}}
			/>
			{#if addList === 'bans' || addList === 'ban-ips'}
				<input class="input reason" bind:value={addReason} placeholder="Reason (optional)" />
			{/if}
			<Btn variant="primary" icon="plus" disabled={!addTarget.trim()} onclick={doAdd}>Add</Btn>
		</div>

		<DataTable
			tableId="access-whitelist"
			columns={whitelistCols}
			rows={whitelist}
			getId={(entry) => entry.uuid || entry.name}
			rowActions={(entry) => removeAction('whitelist', entry.name, 'Remove from whitelist')}
			rowLabel={(entry) => entry.name}
			emptyTitle="The whitelist is empty"
			emptyText={whitelistEnabled
				? 'The whitelist is ON with nobody listed — no one can join this instance.'
				: 'Names added here only matter once the whitelist is turned on.'}
		>
			{#snippet cell(entry, col)}
				{#if col === 'name'}
					<a href="/players/{entry.name}"><b>{entry.name}</b></a>
				{:else if col === 'uuid'}
					<span class="mono dim">{entry.uuid}</span>
				{/if}
			{/snippet}
		</DataTable>
	</Panel>

	<div class="gap"></div>

	<Panel title="Operators" count={ops.length} flush>
		<DataTable
			tableId="access-ops"
			columns={opCols}
			rows={ops}
			getId={(entry) => entry.uuid || entry.name}
			rowActions={(entry) => removeAction('ops', entry.name, 'Revoke operator')}
			rowLabel={(entry) => entry.name}
			emptyTitle="No operators"
			emptyText="Operators can run every server command in-game; grant it sparingly."
		>
			{#snippet cell(entry, col)}
				{#if col === 'name'}
					<a href="/players/{entry.name}"><b>{entry.name}</b></a>
				{:else if col === 'level'}
					{entry.level}
				{:else if col === 'uuid'}
					<span class="mono dim">{entry.uuid}</span>
				{/if}
			{/snippet}
		</DataTable>
	</Panel>

	<div class="gap"></div>

	<Panel title="Player bans" count={bans.length} flush>
		<DataTable
			tableId="access-bans"
			columns={banCols}
			rows={bans}
			getId={(entry) => entry.uuid || entry.name}
			rowActions={(entry) => removeAction('bans', entry.name, 'Pardon player')}
			rowLabel={(entry) => entry.name}
			emptyTitle="Nobody is banned"
			emptyText="Bans issued through luna or in-game both land in this list."
		>
			{#snippet cell(entry, col)}
				{#if col === 'name'}
					<a href="/players/{entry.name}"><b>{entry.name}</b></a>
				{:else if col === 'created'}
					<span class="dim">{entry.created}</span>
				{:else if col === 'source'}
					{entry.source}
				{:else if col === 'expires'}
					{entry.expires === 'forever' ? 'never' : entry.expires}
				{:else if col === 'reason'}
					{entry.reason || '–'}
				{/if}
			{/snippet}
		</DataTable>
	</Panel>

	<div class="gap"></div>

	<Panel title="IP bans" count={ipBans.length} flush>
		<DataTable
			tableId="access-ipbans"
			columns={ipBanCols}
			rows={ipBans}
			getId={(entry) => entry.ip}
			rowActions={(entry) => removeAction('ban-ips', entry.ip, 'Pardon address')}
			rowLabel={(entry) => entry.ip}
			emptyTitle="No IP bans"
			emptyText="An IP ban blocks every account connecting from the address."
		>
			{#snippet cell(entry, col)}
				{#if col === 'ip'}
					<span class="mono"><b>{entry.ip}</b></span>
				{:else if col === 'created'}
					<span class="dim">{entry.created}</span>
				{:else if col === 'source'}
					{entry.source}
				{:else if col === 'reason'}
					{entry.reason || '–'}
				{/if}
			{/snippet}
		</DataTable>
	</Panel>
{/if}

<style lang="scss">
	.wl {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}

	.wl-label {
		color: var(--text-secondary);
		font-size: 0.875rem;
	}

	.add {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		padding: 0.75rem 1rem;
		border-bottom: 0.1rem solid var(--border-divider);

		.target {
			min-width: 12rem;
		}

		.reason {
			flex: 1;
			min-width: 12rem;
		}
	}

	.gap {
		height: 1rem;
	}
</style>
