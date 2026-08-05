<script lang="ts">
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
			return 'ALL_UPPERCASE_WITH_UNDERSCORES, starting with a letter';
		}

		if (varName.startsWith('LUNA_')) {
			return 'LUNA_* names are builtin — they are computed per instance, not stored';
		}

		if (!editing && variables.some((row) => row.name === varName) && scope === 'global') {
			return 'already defined globally — open it from the table to change its value';
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

	/** Where the value lands, in words — the recap and the success note share it. */
	const scopeText = $derived(
		scope === 'machine'
			? `every instance on ${machine || '(machine)'}`
			: scope === 'instance'
				? `${instance || '(instance)'} only`
				: 'every instance in the cluster'
	);

	async function submit(): Promise<void> {
		saving = true;

		const note = Notify.loading(`Saving ${varName}…`);

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
				message: `${varName} saved`,
				detail: `Applies to ${scopeText}. Instances pick it up on their next start.`,
				closeable: true
			});

			await goto('/environment');
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not save ${varName}`,
				detail: (err as Error).message,
				closeable: true
			});

			saving = false;
		}
	}
</script>

<Wizard
	title={editing ? `Edit ${editingName}` : 'Define an environment variable'}
	windowTitle={editing ? `Edit ${editingName}` : 'New environment variable'}
	description="Variables are exported into every instance's JVM at startup and substituted into config templates as $&lbrace;NAME&rbrace;"
	submitLabel={editing ? 'Save variable' : 'Define variable'}
	disabled={!ready || !loaded}
	loading={saving}
	onsubmit={submit}
>
	{#snippet summary()}
		{varName || '(name)'} = {secret && scope === 'global'
			? '••••••••'
			: value || '(empty)'} · applies to {scopeText}
	{/snippet}

	<Panel title="Variable" description="The name config files and start-up scripts refer to">
		<label class="field">
			<span class="lbl">Name</span>
			<span class="hint">ALL_UPPERCASE_WITH_UNDERSCORES; LUNA_* is reserved for builtins</span>
			<input
				class="input mono"
				bind:value={varName}
				placeholder="DB_HOST"
				disabled={editing || saving}
			/>
			{#if nameError}<span class="err">{nameError}</span>{/if}
		</label>
		<label class="field">
			<span class="lbl">Value</span>
			{#if secretBlank}
				<span class="hint">
					This variable is secret, so its stored value never leaves the server — enter a new one to
					replace it, or leave it blank to keep it and change only the fields below.
				</span>
			{/if}
			<input class="input mono" bind:value placeholder="10.0.0.10" disabled={saving} />
		</label>
	</Panel>

	<Panel
		title="Scope"
		description="Builtin < global < machine < instance — an instance resolves the narrowest value defined for it"
	>
		<div class="field">
			<span class="lbl">This value applies to</span>
			<Select
				bind:value={scope}
				width="100%"
				options={[
					{ value: 'global', label: 'Globally — every instance in the cluster' },
					{ value: 'machine', label: 'One machine — every instance on that host' },
					{ value: 'instance', label: 'One instance' }
				]}
			/>
		</div>

		{#if scope === 'machine'}
			<div class="field">
				<span class="lbl">Machine</span>
				<span class="hint">Overrides the global value for every instance this daemon owns</span>
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
				<span class="lbl">Instance</span>
				<span class="hint">Overrides both the global and the machine value, for this one server</span>
				<Select
					bind:value={instance}
					width="100%"
					options={instances.map((entry) => ({ value: entry, label: entry }))}
				/>
			</div>
		{/if}

		{#if scope !== 'global' && definition}
			<p class="shadow dim">
				Shadows the global value
				<span class="mono">{definition.secret ? '••••••••' : definition.value || '(empty)'}</span>
				for {scopeText}.
			</p>
		{:else if scope !== 'global' && varName && !definition}
			<p class="shadow dim">
				<StatusBadge state="warning" label="no global value" /> This name is defined only at this
				scope — instances outside it will not resolve it, and a config file referencing
				<span class="mono">${'{'}{varName}{'}'}</span> there refuses to render.
			</p>
		{/if}
	</Panel>

	{#if scope === 'global'}
		<Panel title="Presentation" description="How the console treats this variable">
			<label class="field">
				<span class="lbl">Description</span>
				<input
					class="input"
					bind:value={description}
					placeholder="What reads this"
					disabled={saving}
				/>
			</label>
			<label class="check">
				<Checkbox checked={secret} label="Secret" onchange={(on) => (secret = on)} />
				Secret — mask the value everywhere in the console, and never send it to a browser
			</label>
			<p class="note dim">
				A secret is still written into each instance's <span class="mono">.luna-env</span> file (mode
				0600) — masking is about the console, not about the server.
			</p>
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
