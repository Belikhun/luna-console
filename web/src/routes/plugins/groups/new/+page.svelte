<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { api, post } from '$lib/api';
	import Wizard from '$lib/components/Wizard.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import PickGrid from '$lib/components/PickGrid.svelte';
	import SearchInput from '$lib/components/SearchInput.svelte';
	import { Notify } from '$lib/notifications.svelte';

	/** Create a plugin group — same form shape as the instance launch wizard. */

	let name = $state('');
	let description = $state('');
	let picked: Set<string> = $state(new Set());
	let pluginNames: string[] = $state([]);
	let existing: string[] = $state([]);
	let filter = $state('');
	let creating = $state(false);

	onMount(async () => {
		const data = await api('/plugins/groups');

		pluginNames = data.pluginNames;
		existing = data.groups.map((group: any) => group.name);
	});

	const nameError = $derived.by(() => {
		if (!name) {
			return '';
		}

		if (!/^[a-z0-9_-]+$/.test(name)) {
			return 'lowercase letters, digits, - and _ only';
		}

		return existing.includes(name) ? 'a group with this name already exists' : '';
	});

	const shownPlugins = $derived.by(() => {
		if (!filter) {
			return pluginNames;
		}

		const needle = filter.toLowerCase();

		return pluginNames.filter((plugin) => plugin.includes(needle));
	});

	function toggle(plugin: string, on: boolean): void {
		const next = new Set(picked);

		if (on) {
			next.add(plugin);
		} else {
			next.delete(plugin);
		}

		picked = next;
	}

	async function create(): Promise<void> {
		creating = true;

		const note = Notify.loading(`Creating group ${name}…`);

		try {
			await post('/plugins/groups', {
				name,
				description,
				plugins: [...picked]
			});

			note.set({
				level: 'success',
				message: `Group ${name} created`,
				detail: `${picked.size} plugin(s). Attach it to instances from their configuration tab.`,
				closeable: true
			});

			await goto(`/plugins/groups/${name}`);
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

<Wizard
	title="Create a plugin group"
	windowTitle="Create plugin group"
	description="A named set of plugins applied to instances as a unit — every family of a member deploys where it fits"
	submitLabel="Create group"
	disabled={!name || !!nameError}
	loading={creating}
	onsubmit={create}
>
	{#snippet summary()}
		{name || '(name)'} · {picked.size} plugin(s)
		{#if description}· {description}{/if}
	{/snippet}

	<Panel title="Name">
		<label class="field">
			<span class="lbl">Group name</span>
			<span class="hint">lowercase letters, digits, - and _</span>
			<input
				class="input"
				bind:value={name}
				placeholder="e.g. survival-extras"
				disabled={creating}
			/>
			{#if nameError}<span class="err">{nameError}</span>{/if}
		</label>
		<label class="field">
			<span class="lbl">Description</span>
			<input
				class="input"
				bind:value={description}
				placeholder="What this set is for"
				disabled={creating}
			/>
		</label>
	</Panel>

	<Panel
		title="Plugins"
		count={picked.size}
		description="Members deploy to every instance using the group — paper builds to backends, velocity builds to the proxy, universal to both"
	>
		<div class="findrow">
			<SearchInput bind:value={filter} placeholder="Find a plugin" width="20rem" />
		</div>
		<PickGrid
			items={shownPlugins}
			selected={picked}
			disabled={creating}
			ontoggle={toggle}
			min="11rem"
			maxHeight="22rem"
		/>
	</Panel>
</Wizard>

<style lang="scss">
	.findrow {
		margin-bottom: 0.75rem;
	}
</style>
