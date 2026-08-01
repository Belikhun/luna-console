<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { api, post } from '$lib/api';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Select from '$lib/components/Select.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import FormGrid from '$lib/components/FormGrid.svelte';
	import { Notify } from '$lib/notifications.svelte';

	/** how many recent Minecraft versions the picker offers */
	const VERSION_CHOICES = 25;

	const MEMORY_CHOICES = ['1G', '2G', '4G', '6G', '8G'];

	/** how long the success flash stays up before the new instance page opens */
	const REDIRECT_DELAY_MS = 1200;

	let name = $state('');
	let versions: string[] = $state([]);
	let mcVersion = $state('');
	let memory = $state('2G');
	let profile = $state('aikar');
	let profiles: string[] = $state(['aikar']);
	let register = $state(true);
	let creating = $state(false);
	let existing: string[] = $state([]);

	onMount(async () => {
		const [paper, insts] = await Promise.all([api('/paper'), api('/instances')]);

		versions = paper.versions;
		mcVersion = versions[0] ?? '';
		existing = insts.instances.map((inst: any) => inst.name);

		// the java profile list lives in the registry, so read it off any backend
		const other = existing.find((entry: string) => entry !== 'proxy');

		if (other) {
			profiles = (await api(`/instances/${other}/config`)).profiles;
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

	async function launch(): Promise<void> {
		creating = true;

		const note = Notify.loading(
			`Creating ${name} — downloading Paper ${mcVersion} and deploying plugins…`
		);

		try {
			const res = await post('/instances/create', {
				name,
				mcVersion,
				memory,
				profile,
				register
			});

			const proxied = res.velocityUpdated ? ', proxy registered' : '';

			note.set({
				level: 'success',
				message: `Created ${res.name} on port ${res.port}`,
				detail: `Paper build ${res.build}, ${res.pluginsDeployed} plugins deployed${proxied}.`,
				closeable: true
			});

			setTimeout(() => goto(`/instances/${res.name}`), REDIRECT_DELAY_MS);
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not create ${name}`,
				detail: (err as Error).message,
				closeable: true
			});

			creating = false;
		}
	}
</script>

<svelte:head><title>Launch instance | MRDS Console</title></svelte:head>

<PageHeader
	title="Launch an instance"
	description="Creates a Paper server, wires velocity forwarding, allocates a port and deploys wildcard-targeted plugins"
/>

<div class="wizard">
	<Panel title="Name">
		<label class="field">
			<span class="lbl">Instance name</span>
			<span class="hint">Also used as the directory name and velocity server id</span>
			<input class="input" bind:value={name} placeholder="e.g. bedwars" />
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

	<div class="summary">
		<span class="dim">
			{name || '(name)'} · paper {mcVersion} · {memory} · profile {profile} ·
			{register ? 'proxied' : 'standalone'}
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
