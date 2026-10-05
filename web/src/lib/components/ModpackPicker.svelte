<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { api } from '$lib/api';
	import Icon from './Icon.svelte';
	import SearchInput from './SearchInput.svelte';
	import Select from './Select.svelte';
	import type { PickedModpack } from './modpackpicker';

	/**
	 * Pick a Modrinth modpack and one of its versions, for the create wizard.
	 *
	 * Search runs as the operator types, narrowed to packs on a loader luna can
	 * host. Picking a pack lists its versions; ones on a loader luna cannot run
	 * (quilt) are listed but unpickable, so the newest build is never silently
	 * skipped. `onpick` hands the page the loader and Minecraft version of the
	 * chosen build, which is what the addon-group check and the summary read.
	 */

	interface Hit {
		slug: string;
		id: string;
		title: string;
		description: string;
		downloads: number;
		mcVersions?: string[];
		iconUrl?: string;
		author?: string;
	}

	interface Version {
		id: string;
		versionNumber: string;
		channel: string;
		mcVersions: string[];
		loaders: string[];
		publishedAt: string;
		sizeBytes: number;
		runnable: boolean;
	}

	let {
		disabled = false,
		onpick
	}: {
		disabled?: boolean;
		/** the chosen build, null while nothing (or nothing runnable) is chosen */
		onpick: (pick: PickedModpack | null) => void;
	} = $props();

	const HOSTED_LOADERS = ['neoforge', 'forge', 'fabric'];

	let query = $state('');
	let hits: Hit[] = $state([]);
	let searching = $state(false);
	let searchError = $state('');
	let picked: Hit | null = $state(null);
	let versions: Version[] = $state([]);
	let versionsLoading = $state(false);
	let versionId = $state('');

	/** the query the newest request was issued for; older answers are dropped */
	let inflight = '';

	async function search(term: string): Promise<void> {
		if (!term) {
			hits = [];
			searchError = '';

			return;
		}

		inflight = term;
		searching = true;

		try {
			const res = await api(`/modpacks/search?q=${encodeURIComponent(term)}`);

			if (inflight !== term) {
				return;
			}

			hits = res.hits ?? [];
			searchError = '';
		} catch (err) {
			hits = [];
			searchError = err instanceof Error ? err.message : String(err);
		}

		searching = false;
	}

	$effect(() => {
		const term = query.trim();
		const id = setTimeout(() => void search(term), 350);

		return () => clearTimeout(id);
	});

	function loaderOf(version: Version): string {
		return version.loaders.find((loader) => HOSTED_LOADERS.includes(loader)) ?? version.loaders[0] ?? '';
	}

	function announce(): void {
		const version = versions.find((entry) => entry.id === versionId);

		if (!picked || !version || !version.runnable) {
			onpick(null);

			return;
		}

		onpick({
			slug: picked.slug,
			title: picked.title,
			versionId: version.id,
			versionNumber: version.versionNumber,
			loader: loaderOf(version),
			mcVersion: version.mcVersions[0] ?? ''
		});
	}

	async function choose(hit: Hit): Promise<void> {
		if (picked?.id === hit.id) {
			return;
		}

		picked = hit;
		versions = [];
		versionId = '';
		onpick(null);
		versionsLoading = true;

		try {
			const res = await api(`/modpacks/versions?slug=${encodeURIComponent(hit.slug)}`);

			// a slower answer for a pack the operator already moved off is dropped
			if (picked?.id !== hit.id) {
				return;
			}

			versions = res.versions ?? [];

			const first = versions.find((entry) => entry.runnable && entry.channel === 'release')
				?? versions.find((entry) => entry.runnable);

			versionId = first?.id ?? '';
		} catch {
			versions = [];
		}

		versionsLoading = false;
		announce();
	}

	function fmtDownloads(count: number): string {
		if (count >= 1_000_000) {
			return `${(count / 1_000_000).toFixed(1)}M`;
		}

		if (count >= 1_000) {
			return `${Math.round(count / 1_000)}k`;
		}

		return String(count);
	}

	const versionOptions = $derived(
		versions.map((version) => ({
			value: version.id,
			label: `${version.versionNumber} · ${loaderOf(version)} ${version.mcVersions.join(', ')}${version.channel === 'release' ? '' : ` · ${version.channel}`}`,
			disabled: !version.runnable
		}))
	);

	const chosen = $derived(versions.find((entry) => entry.id === versionId));
</script>

<div class="picker">
	<SearchInput bind:value={query} placeholder={t('web.launch.modpack.searchPlaceholder')} width="100%" />

	<div class="results">
		{#if searchError}
			<div class="state err">{searchError}</div>
		{:else if !query.trim()}
			<div class="state dim">{t('web.launch.modpack.searchHint')}</div>
		{:else if searching && !hits.length}
			<div class="state">
				<Icon name="rotate" size="1rem" spin />
				<span class="dim">{t('web.launch.modpack.searching')}</span>
			</div>
		{:else if !hits.length}
			<div class="state dim">{t('web.launch.modpack.noMatches', { query: query.trim() })}</div>
		{:else}
			<div class="list" class:stale={searching}>
				{#each hits as hit (hit.id)}
					<button type="button" class="hit" class:sel={picked?.id === hit.id} {disabled} onclick={() => void choose(hit)}>
						{#if hit.iconUrl}
							<img class="art" src={hit.iconUrl} alt="" loading="lazy" />
						{:else}
							<span class="art blank"><Icon name="box" size="1rem" /></span>
						{/if}
						<span class="body">
							<b class="title">{hit.title}</b>
							<span class="desc dim">{hit.description}</span>
						</span>
						<span class="meta dim">
							<span>{fmtDownloads(hit.downloads)} <Icon name="download" size="0.75rem" /></span>
							{#if hit.mcVersions?.length}<span>{hit.mcVersions.at(-1)}</span>{/if}
						</span>
						{#if picked?.id === hit.id}
							<span class="tick"><Icon name="circleCheck" size="1rem" style="solid" /></span>
						{/if}
					</button>
				{/each}
			</div>
		{/if}
	</div>

	{#if picked}
		<div class="field">
			<span class="lbl">{t('web.launch.modpack.version')}</span>
			<span class="hint">{t('web.launch.modpack.versionHint')}</span>
			<Select
				bind:value={versionId}
				width="100%"
				searchable
				disabled={disabled || versionsLoading || !versions.length}
				options={versionOptions}
				onchange={() => announce()}
			/>
			{#if versionsLoading}
				<span class="hint">{t('web.launch.modpack.loadingVersions')}</span>
			{:else if !versions.some((entry) => entry.runnable)}
				<span class="err">{t('web.launch.modpack.noRunnable')}</span>
			{:else if chosen}
				<span class="hint">
					{t('web.launch.modpack.runsOn', {
						loader: loaderOf(chosen),
						mc: chosen.mcVersions[0] ?? '',
						size: (chosen.sizeBytes / 1024 / 1024).toFixed(1)
					})}
				</span>
			{/if}
		</div>
	{/if}
</div>

<style lang="scss">
	.picker {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.results {
		max-height: 20rem;
		overflow-y: auto;
		border: 0.1rem solid var(--border-divider);
		border-radius: var(--radius-input);
	}

	.state {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		padding: 0.75rem 1rem;
		font-size: 0.875rem;
	}

	.list {
		display: flex;
		flex-direction: column;

		&.stale {
			opacity: 0.6;
		}
	}

	.hit {
		@include bare-button;

		display: flex;
		gap: 0.75rem;
		align-items: center;
		padding: 0.5rem 0.75rem;
		border-bottom: 0.1rem solid var(--border-divider);
		text-align: left;
		cursor: pointer;

		&:last-child {
			border-bottom: none;
		}

		&:hover {
			background: var(--bg-hover);
		}

		&.sel {
			background: var(--bg-selected);
		}

		&:disabled {
			cursor: default;
		}
	}

	.art {
		flex: none;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 0.375rem;
		object-fit: cover;

		&.blank {
			display: grid;
			place-items: center;
			background: var(--bg-panel-raised);
			color: var(--text-disabled);
		}
	}

	.body {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
		gap: 0.125rem;
	}

	.title {
		@include ellipsis;

		font-size: 0.875rem;
	}

	.desc {
		@include ellipsis;

		font-size: 0.75rem;
	}

	.meta {
		display: flex;
		flex: none;
		flex-direction: column;
		align-items: flex-end;
		gap: 0.125rem;
		font-size: 0.75rem;
	}

	.tick {
		flex: none;
		color: var(--link);
	}
</style>
