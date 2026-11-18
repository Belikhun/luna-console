<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->
<script lang="ts">
	import { goto } from '$app/navigation';

	import { t } from '$lib/i18n.svelte';
	import { del, post } from '$lib/api';
	import Btn from '$lib/components/Btn.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import ScreenLink from '$lib/components/ScreenLink.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import { menuGroups, type ContextMenuItem } from '$lib/components/contextmenu';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import { resourceId } from '$shared/iam/resources';
	import type { MachineVar } from './machine';

	/**
	 * A machine's Environment tab: the effective set every instance on it
	 * resolves, the cluster-wide values plus this machine's own departures, with
	 * the source saying which layer won. The cluster-wide values themselves are
	 * edited on the environment screen.
	 */
	let {
		name,
		vars,
		loaded,
		onchanged
	}: {
		name: string;
		vars: MachineVar[];
		/** The first read has landed */
		loaded: boolean;
		/** An override was removed; the screen reads the environment again */
		onchanged: () => Promise<void>;
	} = $props();

	/** Secrets revealed this session, dropped on reload */
	let revealed: Record<string, string> = $state({});
	let removeOpen = $state(false);
	/** the override the remove dialog is about; set by the remove verb, read on confirm */
	let removeTarget = $state<MachineVar | null>(null);

	const ownCount = $derived(vars.filter((entry) => entry.source === 'machine').length);

	function variableHref(entry: MachineVar): string {
		return `/environment/${encodeURIComponent(entry.name)}`;
	}

	async function reveal(entry: MachineVar): Promise<void> {
		try {
			// an inherited value's secret lives at the global scope, so that is where
			// the reveal has to look; asking this machine for it would 404
			const result = await post(`/env/${encodeURIComponent(entry.name)}/reveal`, {
				machine: entry.source === 'machine' ? name : undefined
			});

			revealed = { ...revealed, [entry.name]: result.value };
		} catch (err) {
			Notify.error(t('web.machineDetail.revealFailed', { name: entry.name }), { detail: (err as Error).message });
		}
	}

	function hide(varName: string): void {
		const next = { ...revealed };

		delete next[varName];
		revealed = next;
	}

	function askRemove(entry: MachineVar): void {
		removeTarget = entry;
		removeOpen = true;
	}

	async function remove(): Promise<void> {
		const entry = removeTarget;

		if (!entry) {
			return;
		}

		try {
			await del(`/env?name=${encodeURIComponent(entry.name)}&machine=${encodeURIComponent(name)}`);

			Notify.success(t('web.machineDetail.overrideRemoved', { name: entry.name }), {
				detail: t('web.machineDetail.overrideRemovedDetail')
			});

			await onchanged();
		} catch (err) {
			Notify.error(t('web.machineDetail.overrideRemoveFailed', { name: entry.name }), { detail: (err as Error).message });
		}
	}

	const columns: Column[] = $derived([
		{ id: 'name', label: t('web.machineDetail.colVariable'), sortable: true, width: 260 },
		{ id: 'value', label: t('web.machineDetail.colValueHere') },
		{ id: 'source', label: t('web.machineDetail.colSource'), sortable: true, width: 150 },
		{ id: 'global', label: t('web.machineDetail.colClusterValue') }
	]);

	const filters: TableFilterGroup<MachineVar>[] = $derived([
		{
			id: 'source',
			label: t('web.machineDetail.filterSource'),
			options: [
				{ value: 'any', label: t('web.machineDetail.anySource') },
				{
					value: 'machine',
					label: t('web.machineDetail.sourceMachine'),
					match: (entry) => entry.source === 'machine'
				},
				{
					value: 'global',
					label: t('web.machineDetail.sourceCluster'),
					match: (entry) => entry.source === 'global'
				}
			]
		}
	]);

	function rowActions(entry: MachineVar): ContextMenuItem[] {
		const own = entry.source === 'machine';
		const shown = revealed[entry.name] !== undefined;

		return menuGroups(
			[
				{
					label: t('web.machineDetail.openVariable'),
					icon: 'circleInfo',
					action: () => goto(variableHref(entry))
				}
			],
			[
				{
					label: own
						? t('web.machineDetail.editOverride')
						: t('web.machineDetail.overrideHere'),
					icon: own
						? 'pen'
						: 'layerGroup',
					action: () =>
						goto(`/environment/new?name=${encodeURIComponent(entry.name)}&machine=${encodeURIComponent(name)}`)
				},
				{
					label: shown
						? t('web.machineDetail.hideValue')
						: t('web.machineDetail.revealValue'),
					icon: shown
						? 'eyeSlash'
						: 'eye',
					disabled: !entry.secret,
					hint: entry.secret ? undefined : t('web.machineDetail.notSecret'),
					action: () => (shown ? hide(entry.name) : reveal(entry))
				}
			],
			[
				{
					label: t('web.machineDetail.removeOverride'),
					icon: 'trash',
					color: 'danger',
					// an inherited value has nothing to remove here; it lives at the cluster
					// level, and deleting it from this screen would surprise every machine
					disabled: !own,
					hint: own ? undefined : t('web.machineDetail.inheritedNoRemove'),
					action: () => askRemove(entry)
				}
			]
		);
	}
</script>

<Panel
	title={t('web.machineDetail.environmentTitle', { name })}
	count={vars.length}
	description={t('web.machineDetail.environmentHint', { own: ownCount })}
	flush
>
	{#snippet actions()}
		<Btn icon="key" href="/environment">{t('web.machineDetail.allVariables')}</Btn>
		<Btn variant="primary" icon="plus" href="/environment/new?machine={encodeURIComponent(name)}">
			{t('web.machineDetail.addOverride')}
		</Btn>
	{/snippet}

	<ResourceTable
		tableId="machine-environment"
		{columns}
		{filters}
		rows={vars}
		loading={!loaded}
		getId={(entry) => entry.name}
		searchValue={(entry) => `${entry.name} ${entry.secret ? '' : entry.value} ${entry.source}`}
		searchPlaceholder={t('web.machineDetail.findVariable')}
		{rowActions}
		rowLabel={(entry) => entry.name}
		resourceId={(entry) => resourceId('env', entry.name)}
		noun={t('web.machineDetail.variableNoun')}
		defaultSort={{ col: 'name' }}
		emptyTitle={t('web.machineDetail.noVariables')}
		emptyText={t('web.machineDetail.noVariablesHint')}
	>
		{#snippet cell(entry, col)}
			{#if col === 'name'}
				<ScreenLink class="mono" href={variableHref(entry)}><b>{entry.name}</b></ScreenLink>
			{:else if col === 'value'}
				{#if !entry.secret}
					{#if entry.value}
						<span class="mono">{entry.value}</span>
					{:else}
						<span class="dim">{t('web.machineDetail.emptyValue')}</span>
					{/if}
				{:else if revealed[entry.name] !== undefined}
					<span class="mono">{revealed[entry.name] || t('web.machineDetail.emptyValue')}</span>
					<button class="peek" onclick={() => hide(entry.name)}>{t('web.machineDetail.hideValue')}</button>
				{:else}
					<StatusBadge state="warning" label={t('web.machineDetail.secret')} />
					<span class="dim">••••••••</span>
					<button class="peek" title={t('web.machineDetail.revealHint')} onclick={() => reveal(entry)}>
						{t('web.machineDetail.revealValue')}
					</button>
				{/if}
			{:else if col === 'source'}
				<span class="scope {entry.source}">
					{entry.source === 'machine' ? t('web.machineDetail.sourceMachine') : t('web.machineDetail.sourceCluster')}
				</span>
			{:else if col === 'global'}
				{#if entry.source === 'global'}
					<span class="dim">{t('web.machineDetail.sameAsCluster')}</span>
				{:else if entry.global === null}
					<span class="dim">{t('web.machineDetail.onlyHere')}</span>
				{:else if entry.globalSecret}
					<span class="dim">••••••••</span>
				{:else if entry.global}
					<span class="mono dim">{entry.global}</span>
				{:else}
					<span class="dim">{t('web.machineDetail.emptyValue')}</span>
				{/if}
			{/if}
		{/snippet}
	</ResourceTable>
</Panel>

<ConfirmModal
	bind:open={removeOpen}
	title={t('web.machineDetail.removeOverrideTitle', { name: removeTarget?.name ?? '' })}
	lead={t('web.machineDetail.removeOverrideLead', {
		name: removeTarget?.name ?? '',
		machine: name
	})}
	notes={[t('web.machineDetail.removeOverrideNote')]}
	confirmLabel={t('web.common.remove')}
	onconfirm={() => void remove()}
/>

<style lang="scss">
	// one colour per layer, matching the environment screens
	.scope {
		font-size: 0.8125rem;

		&.global {
			color: var(--link);
		}

		&.machine {
			color: var(--warning);
		}
	}

	.peek {
		@include bare-button;

		margin-left: 0.5rem;
		color: var(--link);
		font-size: 0.75rem;

		&:hover {
			text-decoration: underline;
		}
	}
</style>
