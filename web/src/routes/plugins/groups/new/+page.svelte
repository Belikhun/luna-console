<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { api, post } from '$lib/api';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
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

<svelte:head><title>Create plugin group | Luna Console</title></svelte:head>

<PageHeader
	title="Create a plugin group"
	description="A named set of plugins applied to instances as a unit — every family of a member deploys where it fits"
/>

<div class="wizard">
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
		<div class="plugin-grid">
			{#each shownPlugins as plugin (plugin)}
				<label class="pick">
					<Checkbox
						checked={picked.has(plugin)}
						disabled={creating}
						label={plugin}
						onchange={(on) => toggle(plugin, on)}
					/>
					<span>{plugin}</span>
				</label>
			{/each}
		</div>
	</Panel>

	<div class="summary">
		<span class="dim">
			{name || '(name)'} · {picked.size} plugin(s)
			{#if description}· {description}{/if}
		</span>
		<Btn
			variant="primary"
			disabled={!name || !!nameError}
			loading={creating}
			onclick={create}
		>
			Create group
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

	.findrow {
		margin-bottom: 0.75rem;
	}

	.plugin-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
		gap: 0.375rem 1rem;
		max-height: 22rem;
		overflow-y: auto;
		padding: 0.5rem 0.25rem;
		border: 0.1rem solid var(--border-divider);
		border-radius: 0.5rem;
	}

	.pick {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.8125rem;
		cursor: pointer;
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
