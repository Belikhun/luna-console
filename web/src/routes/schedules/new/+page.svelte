<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { api, post } from '$lib/api';
	import Wizard from '$lib/components/Wizard.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Select from '$lib/components/Select.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
	import FormGrid from '$lib/components/FormGrid.svelte';
	import PickGrid from '$lib/components/PickGrid.svelte';
	import { Notify } from '$lib/notifications.svelte';

	/** Create a schedule; same form shape as the instance launch wizard. */

	let name = $state('');
	let action = $state('restart');
	let kind = $state('cron');
	let at = $state('');
	let cron = $state('0 4 * * *');
	let rate = $state('60');
	let maxRuns = $state('');
	let enabled = $state(true);
	let instances: Set<string> = $state(new Set());
	let instanceNames: string[] = $state([]);
	let creating = $state(false);

	onMount(async () => {
		const data = await api('/instances');

		instanceNames = data.instances.map((inst: any) => inst.name);
	});

	function toggleInstance(instance: string, on: boolean): void {
		const next = new Set(instances);

		if (on) {
			next.add(instance);
		} else {
			next.delete(instance);
		}

		instances = next;
	}

	const triggerText = $derived.by(() => {
		if (kind === 'at') {
			return at ? t('web.schedules.onceAt', { time: at.replace('T', ' ') }) : t('web.scheduleNew.onceAtEllipsis');
		}

		if (kind === 'cron') {
			return `cron(${cron})`;
		}

		return t('web.schedules.everyMin', { minutes: rate });
	});

	async function create(): Promise<void> {
		creating = true;

		const trigger =
			kind === 'at'
				? { kind: 'at', at: new Date(at).toISOString() }
				: kind === 'cron'
					? { kind: 'cron', expr: cron }
					: { kind: 'rate', minutes: Number(rate) };

		const note = Notify.loading(t('web.scheduleNew.creating', { name }));

		try {
			await post('/schedules', {
				name,
				action,
				instances: [...instances],
				trigger,
				maxRuns: maxRuns ? Number(maxRuns) : undefined,
				enabled
			});

			note.set({
				level: 'success',
				message: t('web.scheduleNew.created', { name }),
				detail: enabled ? '' : t('web.scheduleNew.createdPaused'),
				closeable: true
			});

			await goto('/schedules');
		} catch (err) {
			note.set({
				level: 'error',
				message: t('web.scheduleNew.createFailed', { name }),
				detail: (err as Error).message,
				closeable: true
			});

			creating = false;
		}
	}
</script>

<Wizard
	title={t('web.scheduleNew.title')}
	windowTitle={t('web.schedules.create')}
	description={t('web.schedules.pageDescription')}
	submitLabel={t('web.schedules.create')}
	disabled={!name || !instances.size || (kind === 'at' && !at)}
	loading={creating}
	onsubmit={create}
>
	{#snippet summary()}
		{name || t('web.scheduleNew.namePlaceholder')} · {action} · {triggerText} · {t('web.scheduleNew.instanceCount', { count: instances.size })}
		{#if maxRuns}· {t('web.scheduleNew.stopsAfter', { count: maxRuns })}{/if}
	{/snippet}

	<Panel title={t('web.scheduleNew.nameAction')}>
		<label class="field">
			<span class="lbl">{t('web.scheduleNew.scheduleName')}</span>
			<input
				class="input"
				bind:value={name}
				placeholder={t('web.scheduleNew.namePlaceholderHint')}
				disabled={creating}
			/>
		</label>
		<div class="field">
			<span class="lbl">{t('web.schedules.colAction')}</span>
			<Select
				bind:value={action}
				width="100%"
				options={[
					{ value: 'start', label: t('web.scheduleModal.start') },
					{ value: 'stop', label: t('web.scheduleModal.stop') },
					{ value: 'restart', label: t('web.scheduleModal.restart') },
					{ value: 'backup', label: t('web.scheduleModal.backupWorld') }
				]}
			/>
		</div>
	</Panel>

	<Panel
		title={t('web.schedules.colTrigger')}
		description={t('web.scheduleNew.triggerDescription')}
	>
		<div class="field">
			<span class="lbl">{t('web.scheduleNew.scheduleType')}</span>
			<Select
				bind:value={kind}
				width="100%"
				options={[
					{ value: 'at', label: t('web.scheduleNew.oneTime') },
					{ value: 'cron', label: t('web.scheduleNew.recurringCron') },
					{ value: 'rate', label: t('web.scheduleNew.recurringRate') }
				]}
			/>
		</div>
		{#if kind === 'at'}
			<label class="field">
				<span class="lbl">{t('web.scheduleNew.runAt')}</span>
				<input class="input" type="datetime-local" bind:value={at} disabled={creating} />
			</label>
		{:else if kind === 'cron'}
			<label class="field">
				<span class="lbl">{t('web.scheduleNew.cronExpression')}</span>
				<span class="hint">{t('web.scheduleNew.cronHint')}</span>
				<input class="input mono" bind:value={cron} disabled={creating} />
			</label>
		{:else}
			<label class="field">
				<span class="lbl">{t('web.scheduleNew.everyNMinutes')}</span>
				<input class="input" type="number" min="1" bind:value={rate} disabled={creating} />
			</label>
		{/if}
		{#if kind !== 'at'}
			<FormGrid cols={2}>
				<label class="field">
					<span class="lbl">{t('web.scheduleNew.stopAfterNRuns')}</span>
					<span class="hint">{t('web.scheduleNew.maxRunsHint')}</span>
					<input
						class="input"
						type="number"
						min="1"
						bind:value={maxRuns}
						placeholder="∞"
						disabled={creating}
					/>
				</label>
			</FormGrid>
		{/if}
		<label class="reg">
			<Checkbox
				checked={enabled}
				label={t('web.scheduleNew.enabledImmediately')}
				onchange={(value) => (enabled = value)}
			/>
			{t('web.scheduleNew.enabledNote')}
		</label>
	</Panel>

	<Panel
		title={t('web.nav.instancesList')}
		count={instances.size}
		description={t('web.scheduleNew.instancesDescription')}
	>
		<PickGrid
			items={instanceNames}
			selected={instances}
			disabled={creating}
			ontoggle={toggleInstance}
		/>
	</Panel>
</Wizard>

<style lang="scss">
	.reg {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		margin-top: 0.25rem;
	}
</style>
