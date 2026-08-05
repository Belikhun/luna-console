<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { api, post } from '$lib/api';
	import { jobFlash } from '$lib/jobflash';
	import { createFlashConfig } from '$lib/instancejobs';
	import Wizard from '$lib/components/Wizard.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Select from '$lib/components/Select.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
	import FormGrid from '$lib/components/FormGrid.svelte';
	import SettingsForm from '$lib/components/SettingsForm.svelte';
	import GroupsField from '$lib/components/GroupsField.svelte';

	/** how many recent Minecraft versions the picker offers */
	const VERSION_CHOICES = 25;

	const MEMORY_CHOICES = ['1G', '2G', '4G', '6G', '8G'];

	let name = $state('');
	let versions: string[] = $state([]);
	let mcVersion = $state('');
	let memory = $state('2G');
	let profile = $state('aikar');
	let profiles: string[] = $state(['aikar']);
	let register = $state(true);
	let javaArgs = $state('');
	let creating = $state(false);
	let existing: string[] = $state([]);
	/** the machine the instance will be created on; a daemon name, always set */
	let daemon = $state('');
	let daemons: Array<{ name: string; mode: string; online: boolean }> = $state([]);
	let primaryName = $state('');

	let schema: any[] = $state([]);
	let groups: any[] = $state([]);
	let settings: Record<string, string> = $state({});
	let addonGroups: string[] = $state([]);
	let pluginOverrides: Record<string, boolean> = $state({});

	onMount(async () => {
		const [paper, insts, cluster] = await Promise.all([
			api('/paper'),
			api('/instances'),
			api('/daemons')
		]);

		versions = paper.versions;
		mcVersion = versions[0] ?? '';
		existing = insts.instances.map((inst: any) => inst.name);

		daemons = cluster.daemons.map((row: any) => ({
			name: row.name,
			mode: row.mode,
			online: !!row.online
		}));

		// the primary is the default target and the only machine guaranteed to be
		// there; creation on a follower is forwarded over its link
		primaryName = daemons.find((row) => row.mode === 'primary')?.name ?? '';
		daemon = primaryName;

		// the java profiles and the settings schema both come off any existing
		// backend's config route; there is no instance yet to read them from
		const other = existing.find((entry: string) => entry !== 'proxy');

		if (other) {
			const cfg = await api(`/instances/${other}/config`);

			profiles = cfg.profiles;
			schema = cfg.schema;
			groups = cfg.groups;

			// a new instance starts from the schema's own defaults, never from the
			// instance the schema happened to be read through
			settings = Object.fromEntries(
				cfg.schema.map((spec: any) => [spec.key, spec.fallback])
			);
		}
	});

	const nameError = $derived.by(() => {
		if (!name) {
			return '';
		}

		if (!/^[a-z0-9_-]+$/.test(name)) {
			return t('web.launch.nameRule');
		}

		return existing.includes(name) ? t('web.launch.nameTaken') : '';
	});

	/** Only the settings that differ from the schema default are worth sending. */
	const changedSettings = $derived.by(() => {
		const out: Record<string, string> = {};

		for (const spec of schema) {
			const value = settings[spec.key];

			if (!spec.managed && value !== undefined && value !== spec.fallback) {
				out[spec.key] = value;
			}
		}

		return out;
	});

	const changedCount = $derived(Object.keys(changedSettings).length);

	/** Every daemon, primary first, with offline ones listed but unpickable. */
	const daemonOptions = $derived(
		[...daemons]
			.sort((a, b) => (a.mode === 'primary' ? -1 : b.mode === 'primary' ? 1 : 0))
			.map((row) => ({
				value: row.name,
				label: `${row.name} (${row.mode}${row.online ? '' : `, ${t('web.launch.offline')}`})`,
				disabled: !row.online
			}))
	);

	async function launch(): Promise<void> {
		creating = true;

		// the page navigates away as soon as the job is accepted, so everything
		// the flow needs afterwards is captured here rather than read from state
		const target = name;

		const done = await jobFlash({
			// the shared card wording; the same config an instance page attaching
			// to a discovered create job renders
			...createFlashConfig(target),

			start: () =>
				post('/instances', {
					name: target,
					mcVersion,
					memory,
					profile,
					register,
					settings: changedSettings,
					javaArgs,
					addonGroups,
					pluginOverrides,
					// the registry records an owner only for follower-held instances, so
					// the primary is sent as "no daemon" rather than by name
					daemon: daemon === primaryName ? '' : daemon
				}),

			// back to the list, where the new row shows up as "provisioning"
			started: () => void goto('/instances')
		});

		// a failed start (validation, name clash) leaves the user on the form
		if (!done) {
			creating = false;
		}
	}
</script>

<Wizard
	title={t('web.launch.title')}
	windowTitle={t('web.nav.launchInstance')}
	description={t('web.launch.pageDescription')}
	submitLabel={t('web.nav.launchInstance')}
	disabled={!name || !!nameError || !mcVersion}
	loading={creating}
	onsubmit={launch}
>
	{#snippet summary()}
		{name || t('web.scheduleNew.namePlaceholder')} · paper {mcVersion} · {memory} · {t('web.launch.profileWord')} {profile} ·
		{register ? t('web.launch.proxied') : t('web.launch.standalone')}
		{#if changedCount}· {t('web.launch.settingsChanged', { count: changedCount })}{/if}
	{/snippet}

	<Panel title={t('web.common.name')}>
		<label class="field">
			<span class="lbl">{t('web.launch.instanceName')}</span>
			<span class="hint">{t('web.launch.nameHint')}</span>
			<input class="input" bind:value={name} placeholder={t('web.launch.namePlaceholder')} disabled={creating} />
			{#if nameError}<span class="err">{nameError}</span>{/if}
		</label>
	</Panel>

	<Panel title={t('web.instances.colSoftware')}>
		<FormGrid cols={2}>
			<label class="field">
				<span class="lbl">{t('web.launch.serverSoftware')}</span>
				<input class="input" value={t('web.launch.paperLatest')} disabled />
			</label>
			<div class="field">
				<span class="lbl">{t('web.launch.minecraftVersion')}</span>
				<Select
					bind:value={mcVersion}
					width="100%"
					options={versions
						.slice(0, VERSION_CHOICES)
						.map((version) => ({ value: version, label: version }))}
				/>
			</div>
		</FormGrid>
	</Panel>

	<Panel title={t('web.launch.resourcesNetwork')}>
		<FormGrid cols={2}>
			<div class="field">
				<span class="lbl">{t('web.instances.memoryHeap')}</span>
				<Select
					bind:value={memory}
					width="100%"
					options={MEMORY_CHOICES.map((size) => ({ value: size, label: size }))}
				/>
			</div>
			<div class="field">
				<span class="lbl">{t('web.instances.colProfile')}</span>
				<Select
					bind:value={profile}
					width="100%"
					options={profiles.map((entry) => ({ value: entry, label: entry }))}
				/>
			</div>
		</FormGrid>
		<FormGrid cols={2}>
			<div class="field">
				<span class="lbl">{t('web.instances.colMachine')}</span>
				<span class="hint">{t('web.launch.machineHint')}</span>
				<Select bind:value={daemon} width="100%" options={daemonOptions} />
			</div>
		</FormGrid>
		<label class="field">
			<span class="lbl">{t('web.launch.extraJvmArgs')}</span>
			<span class="hint">{t('web.launch.jvmArgsHint')}</span>
			<input
				class="input mono"
				bind:value={javaArgs}
				placeholder="-XX:+UseStringDeduplication -Dfile.encoding=UTF-8"
				disabled={creating}
			/>
		</label>
		<label class="reg">
			<Checkbox
				checked={register}
				label={t('web.launch.registerLabel')}
				onchange={(value) => (register = value)}
			/>
			{t('web.launch.registerNote')}
		</label>
	</Panel>

	<Panel
		title={t('web.nav.addons')}
		count={addonGroups.length ? `default + ${addonGroups.length}` : 'default'}
		description={t('web.launch.addonsDescription')}
	>
		<GroupsField
			software="paper"
			{mcVersion}
			bind:selected={addonGroups}
			bind:overrides={pluginOverrides}
			disabled={creating}
		/>
	</Panel>

	<Panel
		title={t('web.launch.serverSettings')}
		count={changedCount ? t('web.launch.changedCount', { count: changedCount }) : undefined}
		description={t('web.launch.settingsDescription')}
	>
		{#if schema.length}
			<SettingsForm {schema} {groups} bind:values={settings} showManaged={false} />
		{:else}
			<span class="dim">{t('web.launch.loadingSchema')}</span>
		{/if}
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
