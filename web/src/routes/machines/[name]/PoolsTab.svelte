<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->
<script lang="ts">
	import { untrack } from 'svelte';

	import { t } from '$lib/i18n.svelte';
	import { put } from '$lib/api';
	import Btn from '$lib/components/Btn.svelte';
	import CellStack from '$lib/components/CellStack.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import DistributionBar from '$lib/components/DistributionBar.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import { consumersLine, poolsPayload } from '$lib/pools';
	import type { PortPool } from '$core/types';
	import type { PortPoolUsage } from '$core/ports';
	import type { DistributionSegment } from '$lib/components/distribution';
	import type { Column } from '$lib/components/table';
	import { applyDrafts, overrideDrafts, sameDrafts, type OverrideDraft, type PortsAnswer } from './machine';

	/**
	 * A machine's Port pools tab. The catalog is cluster-wide; what belongs here
	 * is the one column of it this machine serves: the range it hands out, the
	 * numbers it holds back, and how much of each pool is taken.
	 */
	let {
		name,
		machineKey,
		ports,
		onsaved
	}: {
		name: string;
		/** This machine's key in the port registry ("" is the primary) */
		machineKey: string;
		/** The port map; null until the first read lands */
		ports: PortsAnswer | null;
		/** The ranges were saved; the screen reads the port map again */
		onsaved: () => Promise<void>;
	} = $props();

	const catalog = $derived(ports?.catalog ?? []);
	const views = $derived((ports?.pools ?? []).filter((view) => view.machine === machineKey));

	// what the catalog holds, and what is typed over it. A reload replaces the
	// typed fields only while nobody has touched them, so a refresh never eats
	// an edit in progress.
	let baseline: Record<string, OverrideDraft> = $state({});
	let drafts: Record<string, OverrideDraft> = $state({});
	let saving = $state(false);

	const dirty = $derived(!sameDrafts(drafts, baseline));

	$effect(() => {
		const stored = overrideDrafts(catalog, machineKey);

		untrack(() => {
			if (!dirty) {
				drafts = structuredClone(stored);
			}

			baseline = stored;
		});
	});

	function viewOf(poolId: string): PortPoolUsage | undefined {
		return views.find((view) => view.pool.id === poolId);
	}

	function segments(view: PortPoolUsage): DistributionSegment[] {
		return [
			{ key: 'used', label: t('web.machineDetail.allocated'), count: view.used.length, color: 'var(--link)' },
			{ key: 'reserved', label: t('web.machineDetail.heldBack'), count: view.reserved.length, color: 'var(--warning)' },
			{ key: 'pending', label: t('web.machineDetail.inFlight'), count: view.pending.length, color: 'var(--primary)' },
			{ key: 'free', label: t('web.machineDetail.free'), count: view.free, color: 'var(--bg-track)' }
		];
	}

	const columns: Column[] = $derived([
		{ id: 'pool', label: t('web.machineDetail.colPool'), minWidth: 220 },
		{ id: 'range', label: t('web.machineDetail.colRange'), width: 220 },
		{ id: 'held', label: t('web.machineDetail.colHeld'), width: 200 },
		{ id: 'usage', label: t('web.machineDetail.colUsage'), width: 240 },
		{ id: 'next', label: t('web.machineDetail.colNext'), width: 120, align: 'right' }
	]);

	/** Write this machine's ranges back into the cluster catalog. */
	async function save(): Promise<void> {
		saving = true;

		const note = Notify.loading(t('web.machineDetail.savingPools'));

		try {
			const updated: PortPool[] = applyDrafts(catalog, drafts, machineKey);
			const res = await put('/ports', { pools: poolsPayload(updated, ports?.defaults ?? []) });

			note.set({
				level: 'success',
				message: t('web.machineDetail.poolsSaved', { name }),
				detail: res.warnings?.length ? res.warnings.join(' · ') : '',
				closeable: true
			});

			// what was typed is now what is stored, so the next read may replace it
			baseline = structuredClone($state.snapshot(drafts));

			await onsaved();
		} catch (err) {
			note.set({
				level: 'error',
				message: t('web.machineDetail.poolsSaveFailed'),
				detail: (err as Error).message,
				closeable: true
			});
		}

		saving = false;
	}

	function discard(): void {
		drafts = structuredClone($state.snapshot(baseline));
	}
</script>

<Panel
	title={t('web.machineDetail.poolsOn', { name })}
	count={catalog.length}
	description={t('web.machineDetail.poolsHint')}
	flush
>
	{#snippet actions()}
		<Btn icon="sitemap" href="/network/pools">{t('web.machineDetail.poolCatalog')}</Btn>
		<Btn icon="rotateLeft" disabled={!dirty || saving} onclick={discard}>{t('web.common.discard')}</Btn>
		<Btn variant="primary" icon="floppyDisk" disabled={!dirty} loading={saving} onclick={save}>
			{t('web.machineDetail.saveRanges')}
		</Btn>
	{/snippet}

	<DataTable
		{columns}
		rows={catalog}
		getId={(pool) => pool.id}
		loading={ports === null}
		emptyTitle={t('web.machineDetail.noPools')}
	>
		{#snippet cell(pool, col)}
			{@const view = viewOf(pool.id)}
			{@const draft = drafts[pool.id]}
			{#if col === 'pool'}
				<CellStack>
					{#snippet main()}
						<b>{pool.id}</b>
						<span class="dim">{pool.protocol}</span>
						{#if view?.overridden}
							<StatusBadge state="info" label={t('web.machineDetail.ownRange')} detail={t('web.machineDetail.ownRangeHint')} />
						{/if}
					{/snippet}
					{#snippet sub()}
						{consumersLine(ports?.consumers ?? {}, pool.id)}
					{/snippet}
				</CellStack>
			{:else if col === 'range'}
				{#if draft}
					<span class="range">
						<input
							class="input mono"
							inputmode="numeric"
							aria-label={t('web.machineDetail.rangeFrom', { pool: pool.id })}
							bind:value={draft.from}
							placeholder={String(pool.range[0])}
						/>
						<span class="dim">–</span>
						<input
							class="input mono"
							inputmode="numeric"
							aria-label={t('web.machineDetail.rangeTo', { pool: pool.id })}
							bind:value={draft.to}
							placeholder={String(pool.range[1])}
						/>
					</span>
				{/if}
			{:else if col === 'held'}
				{#if draft}
					<input
						class="input mono"
						aria-label={t('web.machineDetail.heldFor', { pool: pool.id })}
						bind:value={draft.reserved}
						placeholder={(pool.reserved ?? []).join(', ') || t('web.machineDetail.heldNone')}
					/>
				{/if}
			{:else if col === 'usage'}
				{#if view}
					<span class="usage">
						<DistributionBar segments={segments(view)} legend={false} />
						<span class="dim">{t('web.machineDetail.usedOf', { used: String(view.used.length), capacity: String(view.capacity) })}</span>
					</span>
				{:else}
					<span class="dim">–</span>
				{/if}
			{:else if col === 'next'}
				{#if !view}
					<span class="dim">–</span>
				{:else if view.next === null}
					<StatusBadge state="failed" label={t('web.machineDetail.exhausted')} />
				{:else}
					<span class="mono">{view.next}</span>
				{/if}
			{/if}
		{/snippet}
	</DataTable>
</Panel>

<style lang="scss">
	.range {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
		align-items: center;
		gap: 0.375rem;
		width: 100%;
	}

	.usage {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		width: 100%;
		font-size: 0.75rem;
	}
</style>
