<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { api, put } from '$lib/api';
	import Wizard from '$lib/components/Wizard.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Select from '$lib/components/Select.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import { consumersLine, poolsPayload, samePool } from '$lib/pools';
	import type { PortPool } from '$core/types';

	interface OverrideDraft {
		from: string;
		to: string;
		reserved: string;
	}

	interface PoolDraft {
		id: string;
		/** A built-in pool: its id is what consumers ask for, so it is locked and
		 *  can only be reverted to its default, never removed. */
		builtin: boolean;
		label: string;
		protocol: string;
		from: string;
		to: string;
		reserved: string;
		/** Per-machine departures; empty fields mean "use the pool's numbers" */
		overrides: Record<string, OverrideDraft>;
	}

	let drafts: PoolDraft[] = $state([]);
	let defaults: PortPool[] = $state([]);
	let machines: Array<{ machine: string; label: string }> = $state([]);
	let consumers: Record<string, any[]> = $state({});
	let loaded = $state(false);
	let saving = $state(false);
	let saveError: string | null = $state(null);

	/** "24455, 24470" → numbers; junk is dropped rather than guessed at. */
	function parsePorts(text: string): number[] {
		return text
			.split(/[\s,]+/)
			.filter(Boolean)
			.map(Number)
			.filter((port) => Number.isInteger(port));
	}

	function toDraft(pool: PortPool, builtinIds: Set<string>): PoolDraft {
		const overrides: Record<string, OverrideDraft> = {};

		for (const entry of machines) {
			const override = pool.overrides?.[entry.machine];

			overrides[entry.machine] = {
				from: override?.range ? String(override.range[0]) : '',
				to: override?.range ? String(override.range[1]) : '',
				reserved: (override?.reserved ?? []).join(', ')
			};
		}

		return {
			id: pool.id,
			builtin: builtinIds.has(pool.id),
			label: pool.label ?? '',
			protocol: pool.protocol,
			from: String(pool.range[0]),
			to: String(pool.range[1]),
			reserved: (pool.reserved ?? []).join(', '),
			overrides
		};
	}

	function toPool(draft: PoolDraft): PortPool {
		const pool: PortPool = {
			id: draft.id.trim(),
			protocol: (draft.protocol as PortPool['protocol']) ?? 'tcp',
			range: [Number(draft.from), Number(draft.to)]
		};

		const label = draft.label.trim();

		if (label) {
			pool.label = label;
		}

		const reserved = parsePorts(draft.reserved);

		if (reserved.length) {
			pool.reserved = reserved;
		}

		for (const [machine, override] of Object.entries(draft.overrides)) {
			const hasRange = override.from.trim() !== '' && override.to.trim() !== '';
			const held = parsePorts(override.reserved);

			if (!hasRange && !held.length) {
				continue;
			}

			pool.overrides ??= {};
			pool.overrides[machine] = {
				...(hasRange ? { range: [Number(override.from), Number(override.to)] } : {}),
				...(held.length ? { reserved: held } : {})
			};
		}

		return pool;
	}

	async function load(): Promise<void> {
		try {
			const data = await api('/ports');

			defaults = data.defaults;
			machines = data.machines;
			consumers = data.consumers;

			const builtinIds = new Set<string>(data.defaults.map((pool: PortPool) => pool.id));

			drafts = (data.catalog as PortPool[]).map((pool) => toDraft(pool, builtinIds));
			loaded = true;
		} catch (err) {
			Notify.error(t('web.poolsPage.loadFailed'), { detail: (err as Error).message });
		}
	}

	onMount(load);

	/** Whether a draft departs from its built-in default (custom pools always do). */
	function customized(draft: PoolDraft): boolean {
		const fallback = defaults.find((pool) => pool.id === draft.id);

		return !fallback || !samePool(toPool(draft), fallback);
	}

	function revert(index: number): void {
		const fallback = defaults.find((pool) => pool.id === drafts[index]!.id);

		if (fallback) {
			drafts[index] = toDraft(fallback, new Set(defaults.map((pool) => pool.id)));
		}
	}

	function addPool(): void {
		const overrides: Record<string, OverrideDraft> = {};

		for (const entry of machines) {
			overrides[entry.machine] = { from: '', to: '', reserved: '' };
		}

		drafts = [
			...drafts,
			{ id: '', builtin: false, label: '', protocol: 'tcp', from: '', to: '', reserved: '', overrides }
		];
	}

	function removePool(index: number): void {
		drafts = drafts.filter((_, at) => at !== index);
	}

	const customizedCount = $derived(loaded ? drafts.filter(customized).length : 0);
	const overrideCount = $derived(
		drafts.reduce(
			(count, draft) =>
				count +
				Object.values(draft.overrides).filter(
					(override) => (override.from && override.to) || override.reserved.trim()
				).length,
			0
		)
	);

	const invalid = $derived(
		drafts.some(
			(draft) =>
				!draft.id.trim() ||
				!Number.isInteger(Number(draft.from)) ||
				!Number.isInteger(Number(draft.to)) ||
				draft.from.trim() === '' ||
				draft.to.trim() === ''
		)
	);

	async function save(): Promise<void> {
		saving = true;
		saveError = null;

		try {
			const res = await put('/ports', {
				pools: poolsPayload(drafts.map(toPool), defaults)
			});

			Notify.success(t('web.poolsPage.saved'), {
				detail: res.warnings?.length ? res.warnings.join(' · ') : '',
				closeable: !!res.warnings?.length
			});

			await goto('/network');
		} catch (err) {
			saveError = (err as Error).message;
		}

		saving = false;
	}
</script>

<Wizard
	title={t('web.poolsPage.portPools')}
	windowTitle={t('web.poolsPage.portPools')}
	description={t('web.poolsPage.namedRangesTheClusterHands')}
	submitLabel={t('web.poolsPage.savePools')}
	disabled={!loaded || invalid}
	loading={saving}
	onsubmit={save}
>
	{#snippet summary()}
		{drafts.length} pool(s) · {customizedCount} customized · {overrideCount} machine override(s)
	{/snippet}

	{#if saveError}
		<Flash kind="error">{saveError}</Flash>
	{/if}

	{#each drafts as draft, index (index)}
		<Panel title={draft.id || '(new pool)'} description="Consumed by: {consumersLine(consumers, draft.id)}">
			{#snippet actions()}
				{#if draft.builtin}
					<Btn
						variant="tool"
						icon="rotate"
						title={customized(draft) ? 'Revert to the built-in default' : 'Matches the built-in default'}
						disabled={!customized(draft)}
						onclick={() => revert(index)}
					/>
				{:else}
					<Btn variant="tool" icon="trash" title={t('web.poolsPage.removeThisPool')} onclick={() => removePool(index)} />
				{/if}
			{/snippet}

			<div class="pool-grid">
				<label class="field">
					<span class="lbl">{t('web.poolsPage.id')}</span>
					<input
						class="input mono"
						bind:value={draft.id}
						placeholder={t('web.poolsPage.eGWebhooks')}
						disabled={draft.builtin}
						title={draft.builtin ? 'consumers ask for this id; it cannot be renamed' : undefined}
					/>
				</label>
				<label class="field">
					<span class="lbl">{t('web.poolsPage.label')}</span>
					<input class="input" bind:value={draft.label} placeholder={t('web.poolsPage.whatThePoolIsFor')} />
				</label>
				<div class="field">
					<span class="lbl">{t('web.poolsPage.protocol')}</span>
					<Select
						bind:value={draft.protocol}
						width="100%"
						options={[
							{ value: 'tcp', label: t('web.poolsPage.tcp') },
							{ value: 'udp', label: t('web.poolsPage.udp') },
							{ value: 'both', label: t('web.poolsPage.both') }
						]}
					/>
				</div>
				<label class="field">
					<span class="lbl">{t('web.poolsPage.from')}</span>
					<input class="input mono" bind:value={draft.from} placeholder="32560" />
				</label>
				<label class="field">
					<span class="lbl">{t('web.poolsPage.to')}</span>
					<input class="input mono" bind:value={draft.to} placeholder="32599" />
				</label>
				<label class="field">
					<span class="lbl">{t('web.poolsPage.heldBack')}</span>
					<input class="input mono" bind:value={draft.reserved} placeholder={t('web.poolsPage.none')} />
				</label>
			</div>

			<div class="overrides">
				<span class="oh">Per-machine ranges; blank inherits {draft.from || '…'}-{draft.to || '…'}</span>
				{#each machines as entry (entry.machine)}
					{@const override = draft.overrides[entry.machine]!}
					<div class="orow">
						<span class="mname">{entry.label}</span>
						<input class="input mono" bind:value={override.from} placeholder={draft.from || 'from'} />
						<span class="dash">–</span>
						<input class="input mono" bind:value={override.to} placeholder={draft.to || 'to'} />
						<input
							class="input mono held"
							bind:value={override.reserved}
							placeholder="held back on {entry.label}"
						/>
					</div>
				{/each}
			</div>
		</Panel>
	{/each}

	<div>
		<Btn icon="plus" onclick={addPool}>{t('web.poolsPage.addAPool')}</Btn>
	</div>
</Wizard>

<style lang="scss">
	// id · label · protocol · from · to · held back
	.pool-grid {
		display: grid;
		grid-template-columns: 7rem 1fr 6rem 5.5rem 5.5rem 9rem;
		gap: 0.5rem 0.75rem;
		align-items: end;

		:global(.field) {
			margin-bottom: 0;
		}

		@include below($bp-medium) {
			grid-template-columns: 1fr 1fr;
		}
	}

	.overrides {
		margin-top: 0.875rem;
		padding-top: 0.75rem;
		border-top: 0.1rem solid var(--border-divider);

		.oh {
			display: block;
			font-size: 0.75rem;
			color: var(--text-secondary);
			margin-bottom: 0.375rem;
		}
	}

	.orow {
		display: grid;
		grid-template-columns: 9rem 5.5rem auto 5.5rem 1fr;
		gap: 0.5rem;
		align-items: center;

		& + .orow {
			margin-top: 0.375rem;
		}

		.mname {
			color: var(--text-label);
			font-size: 0.875rem;
		}

		.dash {
			color: var(--text-disabled);
		}

		@include below($bp-medium) {
			grid-template-columns: 1fr 1fr;

			.dash {
				display: none;
			}
		}
	}
</style>
