<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { api, post } from '$lib/api';
	import Panel from './Panel.svelte';
	import Btn from './Btn.svelte';
	import Select from './Select.svelte';
	import Toggle from './Toggle.svelte';
	import Checkbox from './Checkbox.svelte';
	import Flash from './Flash.svelte';
	import Modal from './Modal.svelte';
	import PlayerPicker from './PlayerPicker.svelte';
	import ResourceTable from './ResourceTable.svelte';
	import PlayerName from './PlayerName.svelte';
	import StatusBadge from './StatusBadge.svelte';
	import type { Column, TableFilterGroup } from './table';
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

	type ListKind = 'whitelist' | 'ops' | 'bans' | 'ban-ips';

	// the add dialog: one modal whose fields follow the list being added to.
	// the uuid rides along whenever the picker supplied one, so the change
	// lands on that exact profile even when two profiles share the name
	let addOpen = $state(false);
	let addFor: ListKind = $state('whitelist');
	let addTarget = $state('');
	let addUuid = $state('');
	let addReason = $state('');
	let addLevel = $state('4');
	let addBypass = $state(false);

	// the edit dialog: an operator's level/bypass, or a ban's reason
	let editOpen = $state(false);
	let editFor: ListKind = $state('ops');
	let editTarget = $state('');
	let editUuid = $state('');
	let editReason = $state('');
	let editLevel = $state('4');
	let editBypass = $state(false);

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

	interface ChangeFields {
		uuid?: string;
		reason?: string;
		level?: number;
		bypassesPlayerLimit?: boolean;
	}

	const CHANGE_VERBS = {
		add: { busy: 'web.access.adding', done: 'web.access.addedTo' },
		remove: { busy: 'web.access.removing', done: 'web.access.removedFrom' },
		update: { busy: 'web.access.updating', done: 'web.access.updatedIn' }
	} as const;

	async function change(
		list: string,
		action: 'add' | 'remove' | 'update',
		target: string,
		fields: ChangeFields = {}
	): Promise<void> {
		const verbs = CHANGE_VERBS[action];
		const note = Notify.loading(t(verbs.busy, { target }));

		try {
			const result = await post(`/instances/${instance}/access`, {
				kind: 'change',
				list,
				action,
				target,
				reason: fields.reason ?? '',
				...(fields.uuid ? { uuid: fields.uuid } : {}),
				...(fields.level !== undefined ? { level: fields.level } : {}),
				...(fields.bypassesPlayerLimit !== undefined
					? { bypassesPlayerLimit: fields.bypassesPlayerLimit }
					: {})
			});

			if (!result.ok) {
				throw new Error(result.result?.error ?? t('web.access.notApplied'));
			}

			if (result.result.verified === false) {
				note.set({
					level: 'warning',
					message: t('web.access.unconfirmed', { target }),
					detail: t('web.access.unconfirmedDetail'),
					closeable: true
				});
			} else {
				note.set({
					level: 'success',
					message: t(verbs.done, { target, list, method: result.result.method }),
					closeable: true
				});
			}

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

	function openAdd(list: ListKind): void {
		addFor = list;
		addTarget = '';
		addUuid = '';
		addReason = '';
		addLevel = '4';
		addBypass = false;
		addOpen = true;
	}

	function submitAdd(): void {
		const target = addTarget.trim();

		addOpen = false;

		if (!target) {
			return;
		}

		const fields: ChangeFields = { reason: addReason.trim() };

		if (addUuid) {
			fields.uuid = addUuid;
		}

		if (addFor === 'ops') {
			fields.level = Number(addLevel);
			fields.bypassesPlayerLimit = addBypass;
		}

		void change(addFor, 'add', target, fields);
	}

	function openOpEdit(entry: OpEntry): void {
		editFor = 'ops';
		editTarget = entry.name;
		editUuid = entry.uuid;
		editLevel = String(entry.level);
		editBypass = entry.bypassesPlayerLimit;
		editOpen = true;
	}

	function openReasonEdit(
		list: ListKind,
		target: string,
		uuid: string | undefined,
		reason: string | undefined
	): void {
		editFor = list;
		editTarget = target;
		editUuid = uuid ?? '';
		editReason = reason ?? '';
		editOpen = true;
	}

	function submitEdit(): void {
		editOpen = false;

		const fields: ChangeFields =
			editFor === 'ops'
				? { level: Number(editLevel), bypassesPlayerLimit: editBypass }
				: { reason: editReason.trim() };

		if (editUuid) {
			fields.uuid = editUuid;
		}

		void change(editFor, 'update', editTarget, fields);
	}

	const levelOptions = $derived([
		{ value: '1', label: t('web.access.opLevel1') },
		{ value: '2', label: t('web.access.opLevel2') },
		{ value: '3', label: t('web.access.opLevel3') },
		{ value: '4', label: t('web.access.opLevel4') }
	]);

	const addTitles: Record<ListKind, string> = $derived({
		whitelist: t('web.access.addToWhitelistTitle'),
		ops: t('web.access.addOperatorTitle'),
		bans: t('web.access.banPlayerTitle'),
		'ban-ips': t('web.access.banAddressTitle')
	});

	const whitelistCols: Column[] = $derived([
		{ id: 'name', label: t('web.access.colPlayer'), sortable: true },
		{ id: 'uuid', label: 'UUID' }
	]);

	const opCols: Column[] = $derived([
		{ id: 'name', label: t('web.access.colPlayer'), sortable: true },
		{ id: 'level', label: t('web.access.colLevel'), width: 90, align: 'right' },
		{ id: 'bypass', label: t('web.access.colBypass'), width: 140 },
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

	const banFilters: TableFilterGroup<BanEntry>[] = $derived([
		{
			id: 'expiry',
			label: t('web.access.filterExpiry'),
			options: [
				{ value: 'any', label: t('web.access.anyExpiry') },
				{
					value: 'permanent',
					label: t('web.access.permanent'),
					match: (ban: BanEntry) => ban.expires === 'forever'
				},
				{
					value: 'expiring',
					label: t('web.access.expiring'),
					match: (ban: BanEntry) => ban.expires !== 'forever'
				}
			]
		}
	]);

	function removeAction(
		list: string,
		target: string,
		uuid: string | undefined,
		label: string
	): ContextMenuItem {
		return {
			label,
			icon: 'trash',
			color: 'danger',
			action: () => void change(list, 'remove', target, uuid ? { uuid } : {})
		};
	}

	function opActions(entry: OpEntry): ContextMenuItem[] {
		return [
			{
				label: t('web.access.editOperator'),
				icon: 'pen',
				action: () => openOpEdit(entry),
				// a live server grants op through /op and rewrites ops.json on
				// its own saves, so there is nothing a level edit could stick to
				disabled: instState === 'running',
				hint: instState === 'running' ? t('web.access.opEditNeedsStop') : undefined
			},
			removeAction('ops', entry.name, entry.uuid, t('web.access.revokeOperator'))
		];
	}

	function banActions(entry: BanEntry): ContextMenuItem[] {
		return [
			{
				label: t('web.access.editReason'),
				icon: 'pen',
				action: () => openReasonEdit('bans', entry.name, entry.uuid, entry.reason)
			},
			removeAction('bans', entry.name, entry.uuid, t('web.access.pardonPlayer'))
		];
	}

	function ipBanActions(entry: IpBanEntry): ContextMenuItem[] {
		return [
			{
				label: t('web.access.editReason'),
				icon: 'pen',
				action: () => openReasonEdit('ban-ips', entry.ip, undefined, entry.reason)
			},
			removeAction('ban-ips', entry.ip, undefined, t('web.access.pardonAddress'))
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
				<Btn variant="primary" icon="plus" onclick={() => openAdd('whitelist')}>
					{t('web.access.addPlayer')}
				</Btn>
			</span>
		{/snippet}

		<ResourceTable
			tableId="access-whitelist"
			columns={whitelistCols}
			rows={whitelist}
			getId={(entry) => entry.uuid || entry.name}
			searchValue={(entry) => `${entry.name} ${entry.uuid}`}
			searchPlaceholder={t('web.access.findPlayer')}
			searchWidth="20rem"
			noun={t('web.access.nounPlayer')}
			pageSize={15}
			rowActions={(entry) => [
				removeAction('whitelist', entry.name, entry.uuid, t('web.access.removeFromWhitelist'))
			]}
			rowLabel={(entry) => entry.name}
			emptyTitle={t('web.access.whitelistEmpty')}
			emptyText={whitelistEnabled
				? t('web.access.whitelistEmptyOn')
				: t('web.access.whitelistEmptyOff')}
		>
			{#snippet cell(entry, col)}
				{#if col === 'name'}
					<PlayerName player={entry.uuid || entry.name} name={entry.name} />
				{:else if col === 'uuid'}
					<span class="mono dim">{entry.uuid}</span>
				{/if}
			{/snippet}
		</ResourceTable>
	</Panel>

	<div class="gap"></div>

	<Panel title={t('web.access.operators')} count={ops.length} flush>
		{#snippet actions()}
			<Btn variant="primary" icon="plus" onclick={() => openAdd('ops')}>
				{t('web.access.addOperator')}
			</Btn>
		{/snippet}

		<ResourceTable
			tableId="access-ops"
			columns={opCols}
			rows={ops}
			getId={(entry) => entry.uuid || entry.name}
			searchValue={(entry) => `${entry.name} ${entry.uuid}`}
			searchPlaceholder={t('web.access.findPlayer')}
			searchWidth="20rem"
			noun={t('web.access.nounOperator')}
			pageSize={15}
			rowActions={opActions}
			rowLabel={(entry) => entry.name}
			emptyTitle={t('web.access.noOperators')}
			emptyText={t('web.access.operatorsHint')}
		>
			{#snippet cell(entry, col)}
				{#if col === 'name'}
					<PlayerName player={entry.uuid || entry.name} name={entry.name} />
				{:else if col === 'level'}
					{entry.level}
				{:else if col === 'bypass'}
					{#if entry.bypassesPlayerLimit}
						{t('web.access.bypassYes')}
					{:else}
						<span class="dim">–</span>
					{/if}
				{:else if col === 'uuid'}
					<span class="mono dim">{entry.uuid}</span>
				{/if}
			{/snippet}
		</ResourceTable>
	</Panel>

	<div class="gap"></div>

	<Panel title={t('web.access.playerBans')} count={bans.length} flush>
		{#snippet actions()}
			<Btn variant="primary" icon="plus" onclick={() => openAdd('bans')}>
				{t('web.access.banPlayer')}
			</Btn>
		{/snippet}

		<ResourceTable
			tableId="access-bans"
			columns={banCols}
			rows={bans}
			getId={(entry) => entry.uuid || entry.name}
			searchValue={(entry) => `${entry.name} ${entry.source} ${entry.reason ?? ''}`}
			searchPlaceholder={t('web.access.findPlayer')}
			searchWidth="20rem"
			noun={t('web.access.nounBan')}
			pageSize={15}
			filters={banFilters}
			rowActions={banActions}
			rowLabel={(entry) => entry.name}
			emptyTitle={t('web.access.noBans')}
			emptyText={t('web.access.bansHint')}
		>
			{#snippet cell(entry, col)}
				{#if col === 'name'}
					<PlayerName player={entry.uuid || entry.name} name={entry.name} />
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
		</ResourceTable>
	</Panel>

	<div class="gap"></div>

	<Panel title={t('web.access.ipBans')} count={ipBans.length} flush>
		{#snippet actions()}
			<Btn variant="primary" icon="plus" onclick={() => openAdd('ban-ips')}>
				{t('web.access.banAddress')}
			</Btn>
		{/snippet}

		<ResourceTable
			tableId="access-ipbans"
			columns={ipBanCols}
			rows={ipBans}
			getId={(entry) => entry.ip}
			searchValue={(entry) => `${entry.ip} ${entry.source} ${entry.reason ?? ''}`}
			searchPlaceholder={t('web.access.findAddress')}
			searchWidth="20rem"
			noun={t('web.access.nounIpBan')}
			pageSize={15}
			rowActions={ipBanActions}
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
		</ResourceTable>
	</Panel>
{/if}

<Modal title={addTitles[addFor]} bind:open={addOpen}>
	<div class="stack">
		{#if addFor === 'ban-ips'}
			<label class="field">
				<span class="lbl">{t('web.access.colAddress')}</span>
				<input class="input" bind:value={addTarget} placeholder={t('web.access.ipAddress')} />
			</label>
		{:else}
			<div class="field">
				<span class="lbl">{t('web.access.colPlayer')}</span>
				{#key addOpen}
					<PlayerPicker
						bind:value={addTarget}
						pickValue="username"
						placeholder={t('web.access.pickerPlaceholder')}
						onpick={(player) => (addUuid = player?.uuid ?? '')}
					/>
				{/key}
			</div>
		{/if}

		{#if addFor === 'ops'}
			<label class="field">
				<span class="lbl">{t('web.access.opLevel')}</span>
				{#if instState === 'running'}
					<span class="hint">{t('web.access.opLiveNote')}</span>
				{/if}
				<Select bind:value={addLevel} options={levelOptions} width="100%" />
			</label>
			<label class="checkrow">
				<Checkbox
					checked={addBypass}
					label={t('web.access.bypassLimit')}
					onchange={(checked) => (addBypass = checked)}
				/>
				{t('web.access.bypassLimit')}
			</label>
		{/if}

		{#if addFor === 'bans' || addFor === 'ban-ips'}
			<label class="field">
				<span class="lbl">{t('web.access.reason')}</span>
				<span class="hint">{t('web.access.reasonHint')}</span>
				<input class="input" bind:value={addReason} placeholder={t('web.access.reasonOptional')} />
			</label>
		{/if}
	</div>
	{#snippet footer()}
		<Btn onclick={() => (addOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="primary" icon="plus" disabled={!addTarget.trim()} onclick={submitAdd}>
			{t('web.common.add')}
		</Btn>
	{/snippet}
</Modal>

<Modal
	title={editFor === 'ops'
		? t('web.access.editOperatorTitle', { name: editTarget })
		: t('web.access.editReasonTitle', { target: editTarget })}
	bind:open={editOpen}
>
	<div class="stack">
		{#if editFor === 'ops'}
			<label class="field">
				<span class="lbl">{t('web.access.opLevel')}</span>
				<Select bind:value={editLevel} options={levelOptions} width="100%" />
			</label>
			<label class="checkrow">
				<Checkbox
					checked={editBypass}
					label={t('web.access.bypassLimit')}
					onchange={(checked) => (editBypass = checked)}
				/>
				{t('web.access.bypassLimit')}
			</label>
		{:else}
			<label class="field">
				<span class="lbl">{t('web.access.reason')}</span>
				<span class="hint">{t('web.access.editReasonHint')}</span>
				<input class="input" bind:value={editReason} placeholder={t('web.access.reasonOptional')} />
			</label>
		{/if}
	</div>
	{#snippet footer()}
		<Btn onclick={() => (editOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="primary" icon="check" onclick={submitEdit}>{t('web.common.save')}</Btn>
	{/snippet}
</Modal>

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

	.stack {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.checkrow {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
	}

	.gap {
		height: 1rem;
	}
</style>
