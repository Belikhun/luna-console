<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { untrack } from 'svelte';
	import { t } from '$lib/i18n.svelte';
	import { api, post, fileToBase64 } from '$lib/api';
	import { Notify } from '$lib/notifications.svelte';
	import Modal from './Modal.svelte';
	import Btn from './Btn.svelte';
	import Select from './Select.svelte';
	import FileDrop from './FileDrop.svelte';
	import Checkbox from './Checkbox.svelte';
	import Flash from './Flash.svelte';
	import SearchInput from './SearchInput.svelte';
	import AddonPicker from './AddonPicker.svelte';
	import ChannelSelect from './ChannelSelect.svelte';
	import type { AddonHit } from './addons';
	import type { ReleaseChannel } from '$core/channels';
	import type { AddonCollisionReport } from '$core/pluginstate';
	import type { PluginFamily } from '$core/types';
	import {
		INSTANCE_ADDON_KINDS,
		suggestName,
		type AddonSource,
		type InstanceAddonKind,
		type PoolChoice,
		type VersionChoice
	} from './instanceaddon';

	/**
	 * Put an addon on one instance, from the pool, from a provider, or from a file.
	 *
	 * All three in one dialog because they are one intent. The pool screens can
	 * already install and upload, but cluster-wide: getting a plugin onto one
	 * backend meant leaving the instance, finding the pool screen, and ticking that
	 * instance out of the whole fleet's list. Here the target is already decided.
	 *
	 * Everything goes through the pool rather than writing into the instance
	 * directory, because a jar luna did not pool is an unmanaged jar, which is the
	 * state this instance's addon tab reports as a problem.
	 */
	let {
		instance,
		kind,
		families = [],
		source = 'pool',
		provider = $bindable('modrinth'),
		open = $bindable(false),
		ondone
	}: {
		instance: string;
		kind: InstanceAddonKind;
		/** platform families this instance can take; a single entry hides the picker */
		families?: PluginFamily[];
		/**
		 * Which source this dialog opened on. Chosen by the button that opened it
		 * rather than switched inside: the three sources are three different intents,
		 * and a row of segments above the form made the operator pick twice.
		 */
		source?: AddonSource;
		/** provider to search, when the caller opened straight onto one */
		provider?: string;
		open?: boolean;
		/** called after a successful add, so the tab can re-read itself */
		ondone?: () => void | Promise<void>;
	} = $props();

	const spec = $derived(INSTANCE_ADDON_KINDS[kind]);
	let deployNow = $state(true);
	let busy = $state(false);

	// -- pool ------------------------------------------------------------------
	let pool = $state<PoolChoice[]>([]);
	let poolQuery = $state('');
	let poolPick = $state('');
	let poolLoading = $state(false);

	// -- provider --------------------------------------------------------------
	let slug = $state('');
	let projectId = $state('');
	let channel = $state<ReleaseChannel>('release');

	// -- upload ----------------------------------------------------------------
	let file: File | null = $state(null);
	let name = $state('');
	let touched = $state(false);
	let family = $state<PluginFamily>('paper');

	// -- manual version override -------------------------------------------------
	let pickVersion = $state(false);
	let versionPick = $state('');
	let versions = $state<VersionChoice[]>([]);
	let versionsLoading = $state(false);
	let versionsError = $state('');

	// -- duplicate detection ---------------------------------------------------
	let collisions = $state<AddonCollisionReport | null>(null);
	let replaceExisting = $state(true);

	/**
	 * A fresh slate every time it opens; a name left over from last time is the one
	 * mistake this form can make that nothing downstream would catch.
	 *
	 * The body is untracked so this depends on `open` alone. It reads `families`,
	 * which the instance page re-derives into a new array on every refresh, and a
	 * tracked read of it made the whole form reset itself; picking a project and
	 * watching the selection vanish a few seconds later.
	 */
	$effect(() => {
		if (!open) {
			return;
		}

		untrack(() => {
			deployNow = true;
			poolQuery = '';
			poolPick = '';
			slug = '';
			projectId = '';
			channel = 'release';
			file = null;
			name = '';
			touched = false;
			family = families[0] ?? 'paper';
			collisions = null;
			replaceExisting = true;
			pickVersion = false;
			versionPick = '';
			versions = [];
			versionsError = '';

			void loadPool();
		});
	});

	/** Pooled addons, minus the ones this instance already gets. */
	async function loadPool(): Promise<void> {
		poolLoading = true;

		try {
			// the two listings answer different shapes, so each is read explicitly
			// rather than through a chain of fallbacks that silently yields nothing:
			// a data pack's "where does it already go" field is `effectiveTargets`, and
			// reading it as `effective` left every pack looking un-deployed
			const rows: PoolChoice[] =
				kind === 'datapack'
					? ((await api('/datapacks')).packs ?? []).map((row: any) => ({
							plugin: row.name,
							displayName: row.name,
							description: null,
							families: [],
							effective: row.effectiveTargets ?? []
						}))
					: ((await api('/plugins')).plugins ?? []).map((row: any) => ({
							plugin: row.plugin,
							displayName: row.displayName ?? row.plugin,
							description: row.description ?? null,
							families: (row.families ?? []).map((entry: any) => entry.family),
							effective: row.effective ?? []
						}));

			pool = rows
				.filter((row: PoolChoice) => {
					if (row.effective.includes(instance)) {
						return false;
					}

					// a velocity plugin offered to a paper backend is worse than useless:
					// `deploy` skips a build whose family has no directory here, so it
					// would report success and put nothing anywhere
					if (!spec.family || !row.families.length) {
						return true;
					}

					return row.families.some(
						(entry) => entry === 'universal' || families.includes(entry as PluginFamily)
					);
				});
		} catch {
			// the other two sources still work; an empty pool list says so itself
			pool = [];
		}

		poolLoading = false;
	}

	const poolShown = $derived.by(() => {
		const needle = poolQuery.trim().toLowerCase();

		if (!needle) {
			return pool;
		}

		return pool.filter((row) =>
			`${row.plugin} ${row.displayName} ${row.description ?? ''}`.toLowerCase().includes(needle)
		);
	});

	// the name follows the picked file until the operator types over it
	$effect(() => {
		if (file && !touched) {
			name = suggestName(file.name);
		}
	});

	/**
	 * The addon this dialog would install, as a pool name; what the duplicate check
	 * is asked about. A provider install keys off the project slug, which is what
	 * `installFromProvider` names the entry.
	 */
	const candidate = $derived(
		source === 'upload' ? name.trim() : source === 'pool' ? poolPick : slug
	);

	$effect(() => {
		const plugin = candidate;
		const fam = family;

		if (!open || !spec.supersedes || !plugin) {
			collisions = null;

			return;
		}

		let cancelled = false;

		void (async () => {
			try {
				const found = await api(
					`/instances/${instance}/addons/collisions?plugin=${encodeURIComponent(plugin)}&family=${fam}`
				);

				if (!cancelled) {
					collisions = found;
				}
			} catch {
				if (!cancelled) {
					collisions = null;
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	});

	/** The instance's MC version, as the versions endpoint judged against. */
	let instanceMc = $state<string | null>(null);

	/**
	 * The provider's builds for the candidate, fetched only once the operator asks
	 * to choose one: the automatic path needs no list, and fetching per project
	 * picked would spend a provider round trip on a control most adds never open.
	 */
	$effect(() => {
		const plugin = candidate;
		const fam = family;
		const from = source;

		if (!open || !pickVersion || !spec.pickVersion || !plugin || from === 'upload') {
			return;
		}

		let cancelled = false;

		versionsLoading = true;
		versionsError = '';
		versions = [];
		versionPick = '';

		void (async () => {
			try {
				const query =
					from === 'pool'
						? `name=${encodeURIComponent(plugin)}`
						: `provider=${encodeURIComponent(provider)}&slug=${encodeURIComponent(plugin)}` +
							(projectId ? `&id=${encodeURIComponent(projectId)}` : '') +
							`&family=${fam}`;

				const res = await api(`/plugins/versions?instance=${encodeURIComponent(instance)}&${query}`);

				if (cancelled) {
					return;
				}

				versions = res.versions ?? [];
				instanceMc = res.mcVersion ?? null;

				// the newest compatible build is what the automatic path would take, so
				// it is also the honest place to start the manual list from
				versionPick =
					versions.find((row) => row.compatible !== false)?.id ?? versions[0]?.id ?? '';
			} catch (err) {
				if (!cancelled) {
					versionsError = (err as Error).message;
				}
			} finally {
				if (!cancelled) {
					versionsLoading = false;
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	});

	const pickedVersion = $derived(versions.find((row) => row.id === versionPick));

	/** Duplicates of the same addon under another name; the hazard worth a warning. */
	const duplicates = $derived([
		...(collisions?.managed ?? []),
		...(collisions?.unmanaged ?? [])
	]);

	const canSubmit = $derived.by(() => {
		if (busy) {
			return false;
		}

		// asking for a manual version and not having picked one yet is a half-made
		// choice; submitting it would silently fall back to the automatic path
		if (pickVersion && spec.pickVersion && source !== 'upload' && !versionPick) {
			return false;
		}

		if (source === 'pool') {
			return !!poolPick;
		}

		if (source === 'provider') {
			return !!slug;
		}

		return !!file && !!name.trim();
	});

	async function submit(): Promise<void> {
		if (!canSubmit) {
			return;
		}

		busy = true;

		const label = source === 'upload' ? (file?.name ?? '') : candidate;
		const note = Notify.loading(t('web.instanceAddon.adding', { name: label }));

		try {
			// the kind travels with the body: a data pack and a jar share this dialog
			// and this route, and "family" cannot tell them apart (a pack has none)
			const body: Record<string, unknown> = { source, kind, deploy: deployNow };

			if (source === 'upload') {
				body.plugin = name.trim();
				body.family = family;
				body.data = await fileToBase64(file!);
			} else if (source === 'pool') {
				body.plugin = poolPick;
			} else {
				body.provider = provider;
				body.slug = slug;
				body.id = projectId || undefined;
				body.family = family;
				body.channel = channel === 'release' ? undefined : channel;
			}

			if (pickVersion && spec.pickVersion && source !== 'upload' && versionPick) {
				body.version = versionPick;
			}

			if (replaceExisting && duplicates.length) {
				body.supersede = {
					plugins: (collisions?.managed ?? [])
						.map((row) => row.key)
						.filter((key): key is string => !!key),
					files: (collisions?.unmanaged ?? []).map((row) => row.file)
				};
			}

			const res = await post(`/instances/${instance}/addons`, body);

			// which build this instance ended up with, and the caveat when reaching one
			// meant a less stable channel or an operator override past the compat gate
			const versionNote = !res.version
				? ''
				: res.incompatible
					? t('web.instanceAddon.pinnedIncompatible', { version: res.version })
					: res.pinned
						? t('web.instanceAddon.pinnedVersion', { version: res.version, instance })
						: res.escalatedTo
							? t('web.instanceAddon.resolvedEscalated', {
									version: res.version,
									channel: res.escalatedTo
								})
							: t('web.instanceAddon.resolvedVersion', { version: res.version });

			note.set({
				level: res.incompatible ? 'warning' : 'success',
				message: t('web.instanceAddon.added', { name: res.name }),
				detail: [
					deployNow
						? t('web.instanceAddon.deployedTo', { instance })
						: t('web.instanceAddon.pooledOnly'),
					versionNote,
					res.removed?.length
						? t('web.instanceAddon.superseded', { files: res.removed.join(', ') })
						: ''
				]
					.filter(Boolean)
					.join(' '),
				closeable: true
			});

			open = false;

			await ondone?.();
		} catch (err) {
			note.set({
				level: 'error',
				message: t('web.instanceAddon.failed'),
				detail: (err as Error).message,
				closeable: true
			});
		}

		busy = false;
	}

	/** The dialog says which of the three it is; nothing else in it does. */
	const SOURCE_TITLE: Record<AddonSource, string> = {
		pool: 'web.instanceAddon.titlePool',
		provider: 'web.instanceAddon.titleProvider',
		upload: 'web.instanceAddon.titleUpload'
	};
</script>

<Modal title={t(SOURCE_TITLE[source], { noun: t(spec.noun), instance })} bind:open wide>
	{#if source === 'pool'}
		<p class="dim lead">{t('web.instanceAddon.poolLead', { instance })}</p>
		<SearchInput bind:value={poolQuery} placeholder={t('web.instanceAddon.poolSearch')} />
		<div class="list">
			{#if poolLoading}
				<p class="dim empty">{t('web.common.loading')}</p>
			{:else if !poolShown.length}
				<p class="dim empty">{t('web.instanceAddon.poolEmpty', { instance })}</p>
			{:else}
				{#each poolShown as row (row.plugin)}
					<button
						type="button"
						class="row"
						class:picked={poolPick === row.plugin}
						disabled={busy}
						onclick={() => (poolPick = row.plugin)}
					>
						<span class="rname">{row.displayName}</span>
						<span class="dim rkey">{row.plugin}</span>
						{#if row.families.length}
							<span class="dim rfam">{row.families.join(', ')}</span>
						{/if}
					</button>
				{/each}
			{/if}
		</div>
	{:else if source === 'provider'}
		<AddonPicker
			endpoint={spec.search}
			kind={spec.pickerKind}
			params={spec.family ? { family } : {}}
			bind:selected={slug}
			bind:provider
			placeholder={t('web.instanceAddon.providerSearch')}
			onpick={(hit: AddonHit | undefined) => (projectId = hit?.project_id ?? '')}
		/>
		{#if slug}
			<div class="chan">
				<ChannelSelect bind:value={channel} />
			</div>
		{/if}
	{:else}
		<FileDrop
			bind:file
			accept={spec.accept}
			disabled={busy}
			hint={t('web.instanceAddon.drop', { ext: spec.accept })}
		/>
		<label class="field named">
			<span class="lbl">{t('web.instanceAddon.poolName')}</span>
			<span class="hint">{t('web.instanceAddon.poolNameHint')}</span>
			<input
				class="input"
				bind:value={name}
				disabled={busy}
				oninput={() => (touched = true)}
				placeholder="my-{kind}"
			/>
		</label>
	{/if}

	<!-- the exact-build override: off, the instance gets the newest build its MC
	     version can run; on, the operator's pick is pinned here, compatible or not -->
	{#if spec.pickVersion && source !== 'upload' && candidate}
		<div class="verpick">
			<label class="verhead">
				<Checkbox
					checked={pickVersion}
					disabled={busy}
					label={t('web.instanceAddon.pickVersion')}
					onchange={(value) => (pickVersion = value)}
				/>
				{t('web.instanceAddon.pickVersion')}
			</label>
			<p class="dim verhint">{t('web.instanceAddon.pickVersionHint', { instance })}</p>

			{#if pickVersion}
				{#if versionsLoading}
					<p class="dim verstate">{t('web.instanceAddon.versionsLoading')}</p>
				{:else if versionsError}
					<Flash kind="error">{t('web.instanceAddon.versionsFailed', { reason: versionsError })}</Flash>
				{:else if !versions.length}
					<p class="dim verstate">{t('web.instanceAddon.versionsEmpty')}</p>
				{:else}
					<Select
						value={versionPick}
						width="100%"
						disabled={busy}
						options={versions.map((row) => ({
							value: row.id,
							label:
								`${row.versionNumber} · ${row.channel} · ` +
								(row.gameVersions.length
									? `MC ${row.gameVersions.join(', ')}`
									: t('web.instanceAddon.versionAnyMc')) +
								(row.compatible === false && instanceMc
									? ` · ${t('web.instanceAddon.versionNotForMc', { mc: instanceMc })}`
									: '')
						}))}
						onchange={(value) => (versionPick = value)}
					/>

					{#if pickedVersion?.compatible === false && instanceMc}
						<Flash kind="warning">
							{t('web.instanceAddon.versionIncompatiblePick', {
								version: pickedVersion.versionNumber,
								mc: instanceMc,
								instance
							})}
						</Flash>
					{/if}
				{/if}
			{/if}
		</div>
	{/if}

	{#if spec.family && families.length > 1 && source !== 'pool'}
		<div class="field">
			<span class="lbl">{t('web.instanceAddon.platform')}</span>
			<span class="hint">{t('web.instanceAddon.platformHint')}</span>
			<Select
				value={family}
				width="12rem"
				disabled={busy}
				options={families.map((entry) => ({ value: entry, label: entry }))}
				onchange={(value) => (family = value as PluginFamily)}
			/>
		</div>
	{/if}

	<!-- the pool entry this would overwrite is not a hazard, it is the point; said
	     plainly so nobody is surprised by a version changing under them. Never for
	     the pool source: there the entry is not being rewritten, it is the very
	     thing that was picked. -->
	{#if collisions?.overwrites && source !== 'pool'}
		<Flash kind="info">
			<!-- a manually pooled jar has no recorded version, and "currently ?" is
			     worse than not mentioning it -->
			{collisions.overwrites.version
				? t('web.instanceAddon.overwrites', {
						key: collisions.overwrites.key,
						version: collisions.overwrites.version
					})
				: t('web.instanceAddon.overwritesUnversioned', { key: collisions.overwrites.key })}
		</Flash>
	{/if}

	{#if duplicates.length}
		<Flash kind="warning">
			<b>{t('web.instanceAddon.duplicateTitle', { instance })}</b>
			<ul class="dups">
				{#each duplicates as row}
					<li>
						<b>{row.displayName}</b>
						<span class="mono dim">{row.file}</span>
						{#if row.version}<span class="dim">{row.version}</span>{/if}
						{#if !row.key}<span class="dim">{t('web.instanceAddon.unmanagedTag')}</span>{/if}
					</li>
				{/each}
			</ul>
			<label class="repl">
				<Checkbox
					checked={replaceExisting}
					disabled={busy}
					label={t('web.instanceAddon.replaceLabel')}
					onchange={(value) => (replaceExisting = value)}
				/>
				{t('web.instanceAddon.replaceLabel')}
			</label>
			<p class="dim replhint">
				{replaceExisting
					? t('web.instanceAddon.replaceOn')
					: t('web.instanceAddon.replaceOff')}
			</p>
		</Flash>
	{/if}

	<label class="deploy">
		<Checkbox
			checked={deployNow}
			disabled={busy}
			label={t('web.instanceAddon.deployHere', { instance })}
			onchange={(value) => (deployNow = value)}
		/>
		{t('web.instanceAddon.deployHere', { instance })}
	</label>
	<p class="dim restart">{t('web.instanceAddon.restartNote')}</p>

	{#snippet footer()}
		<Btn disabled={busy} onclick={() => (open = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="primary" disabled={!canSubmit} loading={busy} onclick={submit}>
			{t('web.instanceAddon.add')}
		</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.lead {
		margin: 0 0 0.5rem;
		font-size: 0.8125rem;
	}

	// a bounded scroller: the pool runs to dozens of entries and the dialog must
	// not grow past the viewport to show them
	.list {
		margin-top: 0.5rem;
		max-height: 18rem;
		overflow-y: auto;
		border: var(--border-control) solid var(--border-divider);
		border-radius: var(--radius-input);
	}

	.empty {
		margin: 0;
		padding: 1.25rem;
		text-align: center;
		font-size: 0.8125rem;
	}

	.row {
		@include bare-button;

		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		width: 100%;
		padding: 0.5rem 0.75rem;
		text-align: left;
		cursor: pointer;
		border-bottom: var(--hairline) solid var(--border-divider);

		&:last-child {
			border-bottom: none;
		}

		&:hover {
			background: var(--bg-hover);
		}

		&.picked {
			background: color-mix(in srgb, var(--link) 18%, transparent);
		}

		&:focus-visible {
			@include focus-ring;
		}
	}

	.rname {
		font-weight: 700;
	}

	.rkey,
	.rfam {
		font-size: 0.75rem;
	}

	.rfam {
		margin-left: auto;
	}

	// every block below the source picker keeps the same breathing room, whether
	// or not the optional blocks between them (version, collisions) are rendered
	.chan,
	.field {
		margin-top: 0.875rem;
	}

	.dups {
		margin: 0.375rem 0 0.5rem;
		padding-left: 1.25rem;

		li {
			margin-bottom: 0.125rem;
		}

		span {
			margin-left: 0.375rem;
		}
	}

	.verpick {
		margin-top: 0.875rem;
		// the version list is followed by the platform field, whose label needs
		// room to read as the next control's caption rather than this one's tail
		margin-bottom: 0.875rem;

		// the incompatibility warning sits right under the select it talks about;
		// Flash brings its own bottom margin but no top one
		:global(.flash) {
			margin-top: 0.5rem;
		}
	}

	.verhead {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
	}

	.verhint {
		margin: 0.375rem 0 0.5rem;
		font-size: 0.75rem;
	}

	.verstate {
		margin: 0;
		font-size: 0.8125rem;
	}

	.deploy,
	.repl {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
	}

	.deploy {
		margin-top: 0.875rem;
	}

	.restart,
	.replhint {
		margin: 0.375rem 0 0;
		font-size: 0.75rem;
	}
</style>
