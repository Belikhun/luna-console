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
	import PickGrid from '$lib/components/PickGrid.svelte';
	import SearchInput from '$lib/components/SearchInput.svelte';
	import { Notify } from '$lib/notifications.svelte';

	/** Create an addon group; same form shape as the instance launch wizard. */

	let name = $state('');
	let description = $state('');
	let creating = $state(false);
	let existing: string[] = $state([]);

	/** One picker per addon kind: the universe, what is picked, and its filter. */
	interface Kind {
		id: 'plugins' | 'respacks' | 'datapacks';
		title: string;
		description: string;
		placeholder: string;
		universe: string[];
		picked: Set<string>;
		filter: string;
	}

	let kinds: Kind[] = $state([
		{
			id: 'plugins',
			title: t('web.groupNew.plugins'),
			description:
				'Members deploy to every instance using the group; paper builds to backends, velocity builds to the proxy, universal to both',
			placeholder: 'Find a plugin',
			universe: [],
			picked: new Set(),
			filter: ''
		},
		{
			id: 'respacks',
			title: t('web.groupNew.resourcePacks'),
			description:
				"The proxy serves these to players on the group's backends; membership is written into the pack's server rules",
			placeholder: 'Find a resource pack',
			universe: [],
			picked: new Set(),
			filter: ''
		},
		{
			id: 'datapacks',
			title: t('web.groupNew.dataPacks'),
			description: "Deployed into each member instance's world; servers load them on their next restart",
			placeholder: 'Find a data pack',
			universe: [],
			picked: new Set(),
			filter: ''
		}
	]);

	onMount(async () => {
		const data = await api('/addons/groups');

		kinds[0]!.universe = data.pluginNames;
		kinds[1]!.universe = data.respackKeys;
		kinds[2]!.universe = data.datapackNames;
		existing = data.groups.map((group: any) => group.name);
	});

	const total = $derived(kinds.reduce((sum, kind) => sum + kind.picked.size, 0));

	const nameError = $derived.by(() => {
		if (!name) {
			return '';
		}

		if (!/^[a-z0-9_-]+$/.test(name)) {
			return 'lowercase letters, digits, - and _ only';
		}

		return existing.includes(name) ? 'a group with this name already exists' : '';
	});

	/** The universe of one kind, narrowed by its own filter box. */
	function shown(kind: Kind): string[] {
		if (!kind.filter) {
			return kind.universe;
		}

		const needle = kind.filter.toLowerCase();

		return kind.universe.filter((member) => member.includes(needle));
	}

	function toggle(kind: Kind, member: string, on: boolean): void {
		const next = new Set(kind.picked);

		if (on) {
			next.add(member);
		} else {
			next.delete(member);
		}

		kind.picked = next;
	}

	async function create(): Promise<void> {
		creating = true;

		const note = Notify.loading(`Creating group ${name}…`);

		try {
			await post('/addons/groups', {
				name,
				description,
				plugins: [...kinds[0]!.picked],
				respacks: [...kinds[1]!.picked],
				datapacks: [...kinds[2]!.picked]
			});

			note.set({
				level: 'success',
				message: `Group ${name} created`,
				detail: `${total} addon(s). Attach it to instances from their configuration tab.`,
				closeable: true
			});

			await goto(`/addons/groups/${name}`);
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
	title={t('web.groupNew.createAnAddonGroup')}
	windowTitle={t('web.groupNew.createAddonGroup')}
	description={t('web.groupNew.aNamedSetOfPlugins')}
	submitLabel={t('web.groupNew.createGroup')}
	disabled={!name || !!nameError}
	loading={creating}
	onsubmit={create}
>
	{#snippet summary()}
		{name || '(name)'} · {kinds[0]!.picked.size} plugin(s), {kinds[1]!.picked.size} resource pack(s),
		{kinds[2]!.picked.size} data pack(s)
		{#if description}· {description}{/if}
	{/snippet}

	<Panel title={t('web.groupNew.name')}>
		<label class="field">
			<span class="lbl">{t('web.groupNew.groupName')}</span>
			<span class="hint">{t('web.groupNew.lowercaseLettersDigitsAnd')}</span>
			<input
				class="input"
				bind:value={name}
				placeholder={t('web.groupNew.eGSurvivalExtras')}
				disabled={creating}
			/>
			{#if nameError}<span class="err">{nameError}</span>{/if}
		</label>
		<label class="field">
			<span class="lbl">{t('web.groupNew.description')}</span>
			<input
				class="input"
				bind:value={description}
				placeholder={t('web.groupNew.whatThisSetIsFor')}
				disabled={creating}
			/>
		</label>
	</Panel>

	{#each kinds as kind (kind.id)}
		<Panel title={kind.title} count={kind.picked.size} description={kind.description}>
			{#if kind.universe.length}
				<div class="findrow">
					<SearchInput bind:value={kind.filter} placeholder={kind.placeholder} width="20rem" />
				</div>
				<PickGrid
					items={shown(kind)}
					selected={kind.picked}
					disabled={creating}
					ontoggle={(member, on) => toggle(kind, member, on)}
					min="11rem"
					maxHeight="22rem"
				/>
			{:else}
				<p class="dim none">{t('web.groupNew.nothingPooledYetInstall')}</p>
			{/if}
		</Panel>
	{/each}
</Wizard>

<style lang="scss">
	.findrow {
		margin-bottom: 0.75rem;
	}

	.none {
		margin: 0;
		font-size: 0.8125rem;
	}
</style>
