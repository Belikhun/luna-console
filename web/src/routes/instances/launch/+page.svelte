<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { api, post } from '$lib/api';
	import { jobFlash } from '$lib/jobflash';
	import { instanceStateJob } from '$lib/instancejobs';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Select from '$lib/components/Select.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
	import Btn from '$lib/components/Btn.svelte';
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
	/** the machine the instance will be created on — a daemon name, always set */
	let daemon = $state('');
	let daemons: Array<{ name: string; mode: string; online: boolean }> = $state([]);
	let primaryName = $state('');

	let schema: any[] = $state([]);
	let groups: any[] = $state([]);
	let settings: Record<string, string> = $state({});
	let pluginGroups: string[] = $state([]);
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
		// there — creation on a follower is forwarded over its link
		primaryName = daemons.find((row) => row.mode === 'primary')?.name ?? '';
		daemon = primaryName;

		// the java profiles and the settings schema both come off any existing
		// backend's config route — there is no instance yet to read them from
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
			return 'lowercase letters, digits, - and _ only';
		}

		return existing.includes(name) ? 'an instance with this name already exists' : '';
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
				label: `${row.name} (${row.mode}${row.online ? '' : ', offline'})`,
				disabled: !row.online
			}))
	);

	async function launch(): Promise<void> {
		creating = true;

		// the page navigates away as soon as the job is accepted, so everything
		// the flow needs afterwards is captured here rather than read from state
		const target = name;

		const done = await jobFlash({
			title: `Creating ${target}…`,

			start: () =>
				post('/instances/create', {
					name: target,
					mcVersion,
					memory,
					profile,
					register,
					settings: changedSettings,
					javaArgs,
					pluginGroups,
					pluginOverrides,
					// the registry records an owner only for follower-held instances, so
					// the primary is sent as "no daemon" rather than by name
					daemon: daemon === primaryName ? '' : daemon
				}),

			// back to the list, where the new row shows up as "provisioning"
			started: () => void goto('/instances'),

			success: (result) => {
				const res = result as {
					name: string;
					port: number;
					build: number;
					pluginsDeployed: number;
					velocityUpdated: boolean;
				};

				const proxied = res.velocityUpdated ? ', proxy registered' : '';

				return {
					message: `Created ${res.name} on port ${res.port}`,
					detail: `Paper build ${res.build}, ${res.pluginsDeployed} plugin(s) deployed${proxied}.`,
					actions: [
						{ label: 'Start now', run: () => void instanceStateJob(res.name, 'start') },
						{ label: 'View instance', run: () => void goto(`/instances/${res.name}`) }
					]
				};
			},

			failure: () => ({ message: `Could not create ${target}` })
		});

		// a failed start (validation, name clash) leaves the user on the form
		if (!done) {
			creating = false;
		}
	}
</script>

<svelte:head><title>Launch instance | Luna Console</title></svelte:head>

<PageHeader
	title="Launch an instance"
	description="Creates a Paper server, wires velocity forwarding, allocates a port and deploys wildcard-targeted plugins"
/>

<div class="wizard">
	<Panel title="Name">
		<label class="field">
			<span class="lbl">Instance name</span>
			<span class="hint">Also used as the directory name and velocity server id</span>
			<input class="input" bind:value={name} placeholder="e.g. bedwars" disabled={creating} />
			{#if nameError}<span class="err">{nameError}</span>{/if}
		</label>
	</Panel>

	<Panel title="Software">
		<FormGrid cols={2}>
			<label class="field">
				<span class="lbl">Server software</span>
				<input class="input" value="Paper (latest build)" disabled />
			</label>
			<div class="field">
				<span class="lbl">Minecraft version</span>
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

	<Panel title="Resources & network">
		<FormGrid cols={2}>
			<div class="field">
				<span class="lbl">Memory (heap)</span>
				<Select
					bind:value={memory}
					width="100%"
					options={MEMORY_CHOICES.map((size) => ({ value: size, label: size }))}
				/>
			</div>
			<div class="field">
				<span class="lbl">Java profile</span>
				<Select
					bind:value={profile}
					width="100%"
					options={profiles.map((entry) => ({ value: entry, label: entry }))}
				/>
			</div>
		</FormGrid>
		<FormGrid cols={2}>
			<div class="field">
				<span class="lbl">Machine</span>
				<span class="hint">
					Daemon the instance is created on and runs under — followers mirror the plugin
					pool from the primary and the proxy routes to them over the LAN. An offline
					daemon cannot be given work, so it is listed but not selectable.
				</span>
				<Select bind:value={daemon} width="100%" options={daemonOptions} />
			</div>
		</FormGrid>
		<label class="field">
			<span class="lbl">Extra JVM arguments</span>
			<span class="hint">
				Appended after the profile's own flags, so they win where the JVM takes the last
				value — don't restate something the profile already sets (a second garbage
				collector will refuse to start). Space separated, flags only.
			</span>
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
				label="Register with the velocity proxy"
				onchange={(value) => (register = value)}
			/>
			Register with the velocity proxy (port auto-allocated, forwarding secret wired, wildcard
			plugins deployed)
		</label>
	</Panel>

	<Panel
		title="Plugins"
		count={pluginGroups.length ? `default + ${pluginGroups.length}` : 'default'}
		description="Plugin groups applied to the new instance — the default group always is. The table shows how each plugin lands on this platform and Minecraft version."
	>
		<GroupsField
			software="paper"
			{mcVersion}
			bind:selected={pluginGroups}
			bind:overrides={pluginOverrides}
			disabled={creating}
		/>
	</Panel>

	<Panel
		title="Server settings"
		count={changedCount ? `${changedCount} changed` : undefined}
		description="Written into the new instance's server.properties — every one of these can be changed later"
	>
		{#if schema.length}
			<SettingsForm {schema} {groups} bind:values={settings} showManaged={false} />
		{:else}
			<span class="dim">Loading the settings schema…</span>
		{/if}
	</Panel>

	<div class="summary">
		<span class="dim">
			{name || '(name)'} · paper {mcVersion} · {memory} · profile {profile} ·
			{register ? 'proxied' : 'standalone'}
			{#if changedCount}· {changedCount} setting(s) changed{/if}
		</span>
		<Btn
			variant="primary"
			disabled={!name || !!nameError || !mcVersion}
			loading={creating}
			onclick={launch}
		>
			Launch instance
		</Btn>
	</div>
</div>

<style lang="scss">
	.wizard {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		max-width: 47.5rem;
	}

	.err {
		color: var(--error);
		font-size: 0.75rem;
	}

	.reg {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		margin-top: 0.25rem;
	}

	// the summary bar stays reachable while the form scrolls
	.summary {
		position: sticky;
		bottom: 0;
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		background: var(--bg-panel);
		border: 0.1rem solid var(--border-divider);
		border-radius: var(--radius-container);
		padding: 0.75rem 1.25rem;
	}
</style>
