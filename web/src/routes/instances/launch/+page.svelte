<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

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
	import InstanceRuntimeFields from '$lib/components/InstanceRuntimeFields.svelte';
	import type { AgentAddon } from '$lib/components/javaagents';
	import type { Software } from '$core/types';
	import { traitsOf } from '$core/software';
	import WorldUpload from '$lib/components/WorldUpload.svelte';
	import { isStagedWorldReady, type StagedWorld } from '$lib/components/worldupload';

	/** how many recent Minecraft versions the picker offers */
	const VERSION_CHOICES = 25;

	/** One server software, as /api/software describes it. */
	interface SoftwareOption {
		id: Software;
		label: string;
		usesJava: boolean;
		provisionable: boolean;
		hasLoaderVersions: boolean;
		experimental: boolean;
	}

	let name = $state('');
	let softwares: SoftwareOption[] = $state([]);
	let software: Software = $state('paper');
	let versions: string[] = $state([]);
	let mcVersion = $state('');
	let loaderVersions: string[] = $state([]);
	let loaderVersion = $state('');
	let versionsLoading = $state(false);
	let versionError = $state('');
	let memory = $state('2G');
	let profile = $state('aikar');
	let profiles: string[] = $state(['aikar']);
	let register = $state(true);
	let javaArgs = $state('');
	let javaAgents: string[] = $state([]);
	let autoRestart = $state(true);
	let restartDelay = $state(3);
	/** pooled addons the selected groups would put on this instance */
	let agentAddons: AgentAddon[] = $state([]);
	/** managed runtime id, empty = whatever the java profile resolves */
	let runtime = $state('');
	let runtimeIds: string[] = $state([]);
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
		const [catalog, insts, cluster] = await Promise.all([
			api('/software'),
			api('/instances'),
			api('/daemons')
		]);

		// a proxy is created by the cluster's own bootstrap, never from this form
		softwares = (catalog.software as SoftwareOption[]).filter(
			(entry) => entry.provisionable && !(entry as any).isProxy
		);

		await loadVersions();

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

		// runtimes the fleet already holds; picking one the target machine lacks is
		// allowed too, it just installs on the first start
		try {
			const fleet = await api('/runtimes');
			const ids = new Set<string>();

			for (const machine of fleet.machines as Array<any>) {
				for (const entry of machine.runtimes ?? []) {
					ids.add(entry.id);
				}
			}

			runtimeIds = [...ids].sort();
		} catch {
			runtimeIds = [];
		}
	});

	/**
	 * The chosen software's version lists. Refetched on every software change,
	 * because each publishes its own; the loader list then follows the MC pick,
	 * for the loaders whose build is identified by both.
	 */
	async function loadVersions(): Promise<void> {
		versionsLoading = true;
		versionError = '';
		versions = [];

		try {
			const res = await api(`/software/${software}/versions`);

			versions = res.mcVersions;
			mcVersion = versions[0] ?? '';

			await loadLoaderVersions();
		} catch (err) {
			versionError = err instanceof Error ? err.message : String(err);
			mcVersion = '';
		} finally {
			versionsLoading = false;
		}
	}

	/** Loader builds for the chosen MC version, when the software pins one. */
	async function loadLoaderVersions(): Promise<void> {
		loaderVersions = [];
		loaderVersion = '';

		if (!selected?.hasLoaderVersions || !mcVersion) {
			return;
		}

		try {
			const res = await api(`/software/${software}/versions?mc=${encodeURIComponent(mcVersion)}`);

			loaderVersions = res.loaderVersions;
		} catch {
			// the MC list already loaded, so a missing loader list only means the
			// newest build is taken rather than pinned
			loaderVersions = [];
		}
	}

	const selected = $derived(softwares.find((entry) => entry.id === software));

	/**
	 * Whether the chosen software has a world at all.
	 *
	 * The `levelName` trait is the codebase's own test for it, and the same one
	 * the instance page's tabs use; a proxy has none.
	 */
	const hasWorld = $derived(traitsOf(software).levelName !== undefined);

	/** A world zip to provision onto, once the wizard has been through it. */
	let world: StagedWorld | null = $state(null);

	/**
	 * A world is staged but the operator has not finished checking it.
	 *
	 * Blocks the submit rather than being quietly dropped: they picked a file,
	 * and creating the instance without it would be the one outcome nobody asked
	 * for.
	 */
	const worldPending = $derived(!!world && !isStagedWorldReady(world));

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

	/**
	 * The one-line recap under the form. Built as a list rather than inline
	 * markup: an `{#if}` between two separators swallows the whitespace around
	 * it, which reads as a missing space in the rendered line.
	 */
	const summaryLine = $derived.by(() => {
		const parts = [
			name || t('web.scheduleNew.namePlaceholder'),
			`${software} ${mcVersion}`,
			memory
		];

		if (selected?.usesJava) {
			parts.push(`${t('web.launch.profileWord')} ${profile}`);
		}

		parts.push(register ? t('web.launch.proxied') : t('web.launch.standalone'));

		parts.push(
			isStagedWorldReady(world)
				? t('web.launch.worldSummary', { name: world!.level })
				: t('web.launch.worldGenerated')
		);

		if (changedCount) {
			parts.push(t('web.launch.settingsChanged', { count: changedCount }));
		}

		return parts.join(' · ');
	});

	/**
	 * The addons this instance would receive, so a java agent can be attached before
	 * the instance exists. It has to be prospective: an agent-only plugin (Nova is
	 * the usual example) has to be on the command line from the very first boot, and
	 * there is no instance yet to read a deployed list off.
	 *
	 * This is the same route the group validation table already uses; a disabled
	 * override or a build that does not fit the MC version would not be deployed, so
	 * neither is offered.
	 */
	async function loadAgentAddons(): Promise<void> {
		if (!selected?.usesJava) {
			agentAddons = [];
			return;
		}

		const params = new URLSearchParams();

		params.set('groups', addonGroups.join(','));
		params.set('software', software);

		if (mcVersion) {
			params.set('mcVersion', mcVersion);
		}

		if (Object.keys(pluginOverrides).length) {
			params.set('overrides', JSON.stringify(pluginOverrides));
		}

		try {
			const data = await api(`/plugins/validate?${params}`);

			agentAddons = (data.rows as Array<any>)
				.filter((row) => row.entry && row.deployPath && !row.disabled)
				.filter((row) => row.status === 'ok' || row.status === 'unverified')
				.map((row) => ({ key: row.entry, path: row.deployPath, version: row.version ?? null }));
		} catch {
			// the picker falls back to free text; nothing here should block creating
			agentAddons = [];
		}
	}

	$effect(() => {
		// re-read whenever anything that decides the answer moves
		void [software, mcVersion, addonGroups, pluginOverrides];
		void loadAgentAddons();
	});

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
					software,
					mcVersion,
					loaderVersion,
					memory,
					profile,
					register,
					settings: changedSettings,
					javaArgs: selected?.usesJava ? javaArgs : '',
					javaAgents: selected?.usesJava ? javaAgents : [],
					runtime: selected?.usesJava ? runtime : '',
					autoRestart,
					restartDelay,
					// a token, never the bytes: options cross the daemon socket as
					// JSON, and the archive is already on disk there
					worldStage: isStagedWorldReady(world) ? world!.token : undefined,
					worldLevel: isStagedWorldReady(world) ? world!.level : undefined,
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
	disabled={!name || !!nameError || !mcVersion || worldPending}
	loading={creating}
	onsubmit={launch}
>
	{#snippet summary()}
		{summaryLine}
	{/snippet}

	<Panel title={t('web.common.name')}>
		<label class="field">
			<span class="lbl">{t('web.launch.instanceName')}</span>
			<span class="hint">{t('web.launch.nameHint')}</span>
			<input class="input" bind:value={name} placeholder={t('web.launch.namePlaceholder')} disabled={creating} />
			{#if nameError}<span class="err">{nameError}</span>{/if}
		</label>
	</Panel>

	<Panel title={t('web.instances.colSoftware')} description={t('web.launch.softwareHint')}>
		<FormGrid cols={2}>
			<div class="field">
				<span class="lbl">{t('web.launch.serverSoftware')}</span>
				<Select
					value={software}
					width="100%"
					onchange={(value) => {
						software = value as Software;
						void loadVersions();
					}}
					options={softwares.map((entry) => ({
						value: entry.id,
						label: entry.experimental
							? `${t(entry.label)} (${t('web.launch.experimental')})`
							: t(entry.label)
					}))}
				/>
				{#if selected?.experimental}
					<span class="hint">{t('web.launch.experimentalNote')}</span>
				{/if}
			</div>
			<div class="field">
				<span class="lbl">{t('web.launch.minecraftVersion')}</span>
				<Select
					value={mcVersion}
					width="100%"
					disabled={!versions.length}
					onchange={(value) => {
						mcVersion = value;
						void loadLoaderVersions();
					}}
					options={versions
						.slice(0, VERSION_CHOICES)
						.map((version) => ({ value: version, label: version }))}
				/>
				{#if versionError}<span class="err">{versionError}</span>{/if}
			</div>
			{#if selected?.hasLoaderVersions && loaderVersions.length}
				<div class="field">
					<span class="lbl">{t('web.launch.loaderVersion')}</span>
					<span class="hint">{t('web.launch.loaderVersionHint')}</span>
					<Select
						bind:value={loaderVersion}
						width="100%"
						searchable
						options={[
							{ value: '', label: t('web.launch.loaderNewest') },
							...loaderVersions
								.slice(0, VERSION_CHOICES)
								.map((version) => ({ value: version, label: version }))
						]}
					/>
				</div>
			{/if}
		</FormGrid>
	</Panel>

	{#if hasWorld}
		<Panel title={t('web.launch.worldTitle')} description={t('web.launch.worldHint')}>
			<WorldUpload
				bind:value={world}
				{software}
				{mcVersion}
				level={settings['level-name'] ?? ''}
				disabled={creating}
				hint={t('web.launch.worldDrop')}
				confirmLabel={t('web.launch.useThisWorld')}
			/>
			<p class="dim worldnote">{t('web.launch.worldOptional')}</p>
		</Panel>
	{/if}

	<Panel title={t('web.launch.resourcesNetwork')}>
		<FormGrid cols={2}>
			<div class="field">
				<span class="lbl">{t('web.instances.colMachine')}</span>
				<span class="hint">{t('web.launch.machineHint')}</span>
				<Select bind:value={daemon} width="100%" options={daemonOptions} />
			</div>
		</FormGrid>
		<InstanceRuntimeFields
			usesJava={selected?.usesJava ?? true}
			{profiles}
			runtimeOptions={[
				{ value: '', label: t('web.launch.profileDefault') },
				...runtimeIds.map((id) => ({ value: id, label: id }))
			]}
			runtimeHint={t('web.launch.runtimeHint')}
			addons={agentAddons}
			disabled={creating}
			bind:memory
			bind:profile
			bind:runtime
			bind:javaArgs
			bind:javaAgents
			bind:autoRestart
			bind:restartDelay
		/>
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
			{software}
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
