<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { api, post } from '$lib/api';
	import Wizard from '$lib/components/Wizard.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Select from '$lib/components/Select.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * Define an environment variable, or edit one that exists (`?name=`, plus
	 * `?machine=` / `?instance=` to land on an override).
	 *
	 * The scope panel is the substance of this form: the same name can hold a
	 * cluster-wide value, a different one on a machine, and a third on a single
	 * instance, and which of them an instance sees is decided by the narrowest
	 * scope that defines it. The recap in the sticky bar spells that out, because
	 * "set DB_HOST" without a scope is the mistake this screen exists to prevent.
	 */

	interface EnvRow {
		name: string;
		value: string;
		secret: boolean;
		description: string;
	}

	interface Machine {
		key: string;
		name: string;
		primary: boolean;
	}

	let variables: EnvRow[] = $state([]);
	let machines: Machine[] = $state([]);
	let instances: string[] = $state([]);
	let loaded = $state(false);
	let saving = $state(false);

	let varName = $state('');
	let value = $state('');
	let secret = $state(false);
	let description = $state('');
	let scope = $state('global');
	let machine = $state('');
	let instance = $state('');

	/** The variable this form opened on, when it is an edit rather than a create. */
	const editingName = $derived(page.url.searchParams.get('name') ?? '');
	const editing = $derived(!!editingName);

	/** The global definition of the name being edited, when there is one. */
	const definition = $derived(variables.find((row) => row.name === varName));

	/** A secret's value never reaches the browser, so an edit starts blank. */
	const secretBlank = $derived(editing && !!definition?.secret && !value);

	const nameError = $derived.by(() => {
		if (!varName) {
			return '';
		}

		if (!/^[A-Z][A-Z0-9_]*$/.test(varName)) {
			return t('web.envNew.nameRule');
		}

		if (varName.startsWith('LUNA_')) {
			return t('web.envNew.lunaReserved');
		}

		if (!editing && variables.some((row) => row.name === varName) && scope === 'global') {
			return t('web.envNew.alreadyGlobal');
		}

		return '';
	});

	const ready = $derived(
		!!varName && !nameError && !(scope === 'machine' && !machine) && !(scope === 'instance' && !instance)
	);

	onMount(async () => {
		const [env, instanceList] = await Promise.all([api('/env'), api('/instances')]);

		variables = env.variables;
		machines = env.machines ?? [];
		instances = instanceList.instances.map((row: { name: string }) => row.name);

		// prefill from the query: the table links here to edit a row
		const wantedName = page.url.searchParams.get('name');
		const wantedMachine = page.url.searchParams.get('machine');
		const wantedInstance = page.url.searchParams.get('instance');

		if (wantedName) {
			varName = wantedName;

			const existing = variables.find((row) => row.name === wantedName);

			if (existing) {
				value = existing.secret ? '' : existing.value;
				secret = existing.secret;
				description = existing.description;
			}
		}

		if (wantedMachine) {
			scope = 'machine';
			machine = wantedMachine;
			value = '';
		} else if (wantedInstance) {
			scope = 'instance';
			instance = wantedInstance;
			value = '';
		}

		machine ||= machines.find((entry) => !entry.primary)?.name ?? machines[0]?.name ?? '';
		instance ||= instances[0] ?? '';
		loaded = true;
	});

	/** Where the value lands, in words; the recap and the success note share it. */
	const scopeText = $derived(
		scope === 'machine'
			? t('web.envNew.everyOnMachine', { machine: machine || '(machine)' })
			: scope === 'instance'
				? t('web.envNew.instanceOnly', { instance: instance || '(instance)' })
				: t('web.env.everyInstance')
	);

	async function submit(): Promise<void> {
		saving = true;

		const note = Notify.loading(t('web.envNew.saving', { name: varName }));

		try {
			await post('/env', {
				name: varName,
				value,
				secret: scope === 'global' ? secret : undefined,
				description: scope === 'global' ? description : undefined,
				machine: scope === 'machine' ? machine : undefined,
				instance: scope === 'instance' ? instance : undefined
			});

			note.set({
				level: 'success',
				message: t('web.envNew.saved', { name: varName }),
				detail: t('web.envNew.savedDetail', { scope: scopeText }),
				closeable: true
			});

			await goto('/environment');
		} catch (err) {
			note.set({
				level: 'error',
				message: t('web.envNew.saveFailed', { name: varName }),
				detail: (err as Error).message,
				closeable: true
			});

			saving = false;
		}
	}
</script>

<Wizard
	title={editing ? t('web.envNew.editTitle', { name: editingName }) : t('web.envNew.title')}
	windowTitle={editing ? t('web.envNew.editTitle', { name: editingName }) : t('web.envNew.windowTitle')}
	description={t('web.envNew.pageDescription')}
	submitLabel={editing ? t('web.envNew.saveVariable') : t('web.env.defineVariable')}
	disabled={!ready || !loaded}
	loading={saving}
	onsubmit={submit}
>
	{#snippet summary()}
		{varName || t('web.scheduleNew.namePlaceholder')} = {secret && scope === 'global'
			? '••••••••'
			: value || t('web.env.empty')} · {t('web.envNew.appliesTo')} {scopeText}
	{/snippet}

	<Panel title={t('web.envNew.variable')} description={t('web.envNew.variableDescription')}>
		<label class="field">
			<span class="lbl">{t('web.common.name')}</span>
			<span class="hint">{t('web.envNew.nameHint')}</span>
			<input
				class="input mono"
				bind:value={varName}
				placeholder="DB_HOST"
				disabled={editing || saving}
			/>
			{#if nameError}<span class="err">{nameError}</span>{/if}
		</label>
		<label class="field">
			<span class="lbl">{t('web.common.value')}</span>
			{#if secretBlank}
				<span class="hint">{t('web.envNew.secretBlankHint')}</span>
			{/if}
			<input class="input mono" bind:value placeholder="10.0.0.10" disabled={saving} />
		</label>
	</Panel>

	<Panel
		title={t('web.envNew.scope')}
		description={t('web.envNew.scopeDescription')}
	>
		<div class="field">
			<span class="lbl">{t('web.envNew.valueAppliesTo')}</span>
			<Select
				bind:value={scope}
				width="100%"
				options={[
					{ value: 'global', label: t('web.envNew.globallyLabel') },
					{ value: 'machine', label: t('web.envNew.machineLabel') },
					{ value: 'instance', label: t('web.envNew.instanceLabel') }
				]}
			/>
		</div>

		{#if scope === 'machine'}
			<div class="field">
				<span class="lbl">{t('web.env.machine')}</span>
				<span class="hint">{t('web.envNew.machineOverrideHint')}</span>
				<Select
					bind:value={machine}
					width="100%"
					options={machines.map((entry) => ({
						value: entry.name,
						label: entry.primary ? `${entry.name} (primary)` : entry.name
					}))}
				/>
			</div>
		{/if}

		{#if scope === 'instance'}
			<div class="field">
				<span class="lbl">{t('web.env.instance')}</span>
				<span class="hint">{t('web.envNew.instanceOverrideHint')}</span>
				<Select
					bind:value={instance}
					width="100%"
					options={instances.map((entry) => ({ value: entry, label: entry }))}
				/>
			</div>
		{/if}

		{#if scope !== 'global' && definition}
			<p class="shadow dim">
				{t('web.envNew.shadowsGlobal')}
				<span class="mono">{definition.secret ? '••••••••' : definition.value || t('web.env.empty')}</span>
				{t('web.envNew.forScope', { scope: scopeText })}
			</p>
		{:else if scope !== 'global' && varName && !definition}
			<p class="shadow dim">
				<StatusBadge state="warning" label={t('web.envNew.noGlobalValue')} /> {t('web.envNew.onlyHereNote')}
				<span class="mono">${'{'}{varName}{'}'}</span> {t('web.envNew.refusesRender')}
			</p>
		{/if}
	</Panel>

	{#if scope === 'global'}
		<Panel title={t('web.envNew.presentation')} description={t('web.envNew.presentationDescription')}>
			<label class="field">
				<span class="lbl">{t('web.env.colDescription')}</span>
				<input
					class="input"
					bind:value={description}
					placeholder={t('web.envNew.descriptionPlaceholder')}
					disabled={saving}
				/>
			</label>
			<label class="check">
				<Checkbox checked={secret} label={t('web.env.secret')} onchange={(on) => (secret = on)} />
				{t('web.envNew.secretNote')}
			</label>
			<p class="note dim">{t('web.envNew.secretFileNoteA')} <span class="mono">{t('web.envNew.lunaEnv')}</span> {t('web.envNew.secretFileNoteB')}</p>
		</Panel>
	{/if}
</Wizard>

<style lang="scss">
	.check {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.25rem;
		font-size: 0.875rem;
	}

	.shadow,
	.note {
		margin: 0.75rem 0 0;
		font-size: 0.8125rem;
	}
</style>
