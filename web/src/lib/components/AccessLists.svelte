<script lang="ts">
	import { t } from '$lib/i18n.svelte';
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
	 * directly when it is stopped; the state note above the lists says which.
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
		const note = Notify.loading(t(action === 'add' ? 'web.access.adding' : 'web.access.removing', { target }));

		try {
			const result = await post(`/instances/${instance}/access`, {
				kind: 'change',
				list,
				action,
				target,
				reason
			});

			if (!result.ok) {
				throw new Error(result.result?.error ?? t('web.access.notApplied'));
			}

			note.set({
				level: 'success',
				message: t(action === 'add' ? 'web.access.addedTo' : 'web.access.removedFrom', { target, list, method: result.result.method }),
				closeable: true
			});

			await refresh();
		} catch (err) {
			note.set({
				level: 'error',
				message: t('web.access.changeFailed', { list }),
				detail: (err as Error).message,
				closeable: true
			});
		}
	}

	async function toggleWhitelist(enabled: boolean): Promise<void> {
		const note = Notify.loading(t(enabled ? 'web.access.turningOn' : 'web.access.turningOff'));

		try {
			await post(`/instances/${instance}/access`, { kind: 'whitelist', enabled });

			note.set({
				level: 'success',
				message: t(enabled ? 'web.access.nowOn' : 'web.access.nowOff'),
				closeable: true
			});

			await refresh();
		} catch (err) {
			note.set({
				level: 'error',
				message: t('web.access.toggleFailed'),
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

	const whitelistCols: Column[] = $derived([
		{ id: 'name', label: t('web.access.colPlayer'), sortable: true },
		{ id: 'uuid', label: 'UUID' }
	]);

	const opCols: Column[] = $derived([
		{ id: 'name', label: t('web.access.colPlayer'), sortable: true },
		{ id: 'level', label: t('web.access.colLevel'), width: 90, align: 'right' },
		{ id: 'uuid', label: 'UUID' }
	]);

	const banCols: Column[] = $derived([
		{ id: 'name', label: t('web.access.colPlayer'), sortable: true },
		{ id: 'created', label: t('web.access.colBanned'), sortable: true },
		{ id: 'source', label: t('web.access.colBy') },
		{ id: 'expires', label: t('web.access.colExpires') },
		{ id: 'reason', label: t('web.access.colReason') }
	]);

	const ipBanCols: Column[] = $derived([
		{ id: 'ip', label: t('web.access.colAddress'), sortable: true },
		{ id: 'created', label: t('web.access.colBanned'), sortable: true },
		{ id: 'source', label: t('web.access.colBy') },
		{ id: 'reason', label: t('web.access.colReason') }
	]);

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
	<Flash kind="error"><b>{t('web.access.unavailable')}</b> {problem}</Flash>
{:else if loaded}
	<Panel
		title={t('web.access.whitelist')}
		count={whitelist.length}
		description={instState === 'running'
			? t('web.access.liveNote')
			: t('web.access.stoppedNote')}
		flush
	>
		{#snippet actions()}
			<span class="wl">
				<Toggle
					checked={whitelistEnabled}
					label={t('web.access.whitelistEnabled')}
					onchange={(checked) => void toggleWhitelist(checked)}
				/>
				<span class="wl-label">
					{whitelistEnabled ? t('web.access.onNote') : t('web.access.offNote')}
				</span>
				{#if whitelistEnabled && enforceWhitelist}
					<StatusBadge state="warning" label={t('web.access.enforced')} />
				{/if}
			</span>
		{/snippet}

		<div class="add">
			<Select
				bind:value={addList}
				options={[
					{ value: 'whitelist', label: t('web.access.whitelist') },
					{ value: 'ops', label: t('web.access.operators') },
					{ value: 'bans', label: t('web.access.playerBans') },
					{ value: 'ban-ips', label: t('web.access.ipBans') }
				]}
				width="11rem"
			/>
			<input
				class="input target"
				bind:value={addTarget}
				placeholder={addList === 'ban-ips' ? t('web.access.ipAddress') : t('web.access.playerName')}
				onkeydown={(event) => {
					if (event.key === 'Enter') {
						doAdd();
					}
				}}
			/>
			{#if addList === 'bans' || addList === 'ban-ips'}
				<input class="input reason" bind:value={addReason} placeholder={t('web.access.reasonOptional')} />
			{/if}
			<Btn variant="primary" icon="plus" disabled={!addTarget.trim()} onclick={doAdd}>{t('web.common.add')}</Btn>
		</div>

		<DataTable
			tableId="access-whitelist"
			columns={whitelistCols}
			rows={whitelist}
			getId={(entry) => entry.uuid || entry.name}
			rowActions={(entry) => removeAction('whitelist', entry.name, t('web.access.removeFromWhitelist'))}
			rowLabel={(entry) => entry.name}
			emptyTitle={t('web.access.whitelistEmpty')}
			emptyText={whitelistEnabled
				? t('web.access.whitelistEmptyOn')
				: t('web.access.whitelistEmptyOff')}
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

	<Panel title={t('web.access.operators')} count={ops.length} flush>
		<DataTable
			tableId="access-ops"
			columns={opCols}
			rows={ops}
			getId={(entry) => entry.uuid || entry.name}
			rowActions={(entry) => removeAction('ops', entry.name, t('web.access.revokeOperator'))}
			rowLabel={(entry) => entry.name}
			emptyTitle={t('web.access.noOperators')}
			emptyText={t('web.access.operatorsHint')}
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

	<Panel title={t('web.access.playerBans')} count={bans.length} flush>
		<DataTable
			tableId="access-bans"
			columns={banCols}
			rows={bans}
			getId={(entry) => entry.uuid || entry.name}
			rowActions={(entry) => removeAction('bans', entry.name, t('web.access.pardonPlayer'))}
			rowLabel={(entry) => entry.name}
			emptyTitle={t('web.access.noBans')}
			emptyText={t('web.access.bansHint')}
		>
			{#snippet cell(entry, col)}
				{#if col === 'name'}
					<a href="/players/{entry.name}"><b>{entry.name}</b></a>
				{:else if col === 'created'}
					<span class="dim">{entry.created}</span>
				{:else if col === 'source'}
					{entry.source}
				{:else if col === 'expires'}
					{entry.expires === 'forever' ? t('web.access.never') : entry.expires}
				{:else if col === 'reason'}
					{entry.reason || '–'}
				{/if}
			{/snippet}
		</DataTable>
	</Panel>

	<div class="gap"></div>

	<Panel title={t('web.access.ipBans')} count={ipBans.length} flush>
		<DataTable
			tableId="access-ipbans"
			columns={ipBanCols}
			rows={ipBans}
			getId={(entry) => entry.ip}
			rowActions={(entry) => removeAction('ban-ips', entry.ip, t('web.access.pardonAddress'))}
			rowLabel={(entry) => entry.ip}
			emptyTitle={t('web.access.noIpBans')}
			emptyText={t('web.access.ipBansHint')}
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
