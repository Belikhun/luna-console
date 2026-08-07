<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { api, patch, post } from '$lib/api';
	import Wizard from '$lib/components/Wizard.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Select from '$lib/components/Select.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * Define a java profile, or edit one that exists (`?name=`), or start from a
	 * copy of one (`?copy=`).
	 *
	 * A profile is a flag set, and a flag set is a long, dense field that wants
	 * room and a explanation beside it; the dialog this replaced put a twenty-flag
	 * textarea in a box the size of a confirm prompt. The wizard also lets the
	 * recap state the thing that actually surprises people: an explicit java path
	 * silently wins over a pinned runtime.
	 */

	interface ProfileRow {
		name: string;
		java: string | null;
		runtime: string | null;
		flags: string[];
		jarArgs: string[];
		usedBy: string[];
	}

	let profiles: ProfileRow[] = $state([]);
	let runtimeIds: string[] = $state([]);
	let loaded = $state(false);
	let saving = $state(false);

	let profileName = $state('');
	let runtime = $state('');
	let java = $state('');
	let flags = $state('');
	let jarArgs = $state('');

	/** The profile this form opened on, when it is an edit rather than a create. */
	const editingName = $derived(page.url.searchParams.get('name') ?? '');
	const editing = $derived(!!editingName);
	const copyFrom = $derived(page.url.searchParams.get('copy') ?? '');

	const current = $derived(profiles.find((row) => row.name === editingName));

	const nameError = $derived.by(() => {
		if (!profileName) {
			return '';
		}

		if (!/^[a-z0-9][a-z0-9_-]*$/.test(profileName)) {
			return t('web.profiles.nameHint');
		}

		if (profileName !== editingName && profiles.some((row) => row.name === profileName)) {
			return t('web.profilesNew.nameTaken', { name: profileName });
		}

		return '';
	});

	const flagList = $derived(flags.split(/\s+/).filter((flag) => flag.length > 0));

	/** A java path wins over a runtime id, so the form says so rather than implying both apply. */
	const shadowed = $derived(!!java && !!runtime);
	const ready = $derived(!!profileName && !nameError);

	onMount(async () => {
		const data = await api('/profiles');

		profiles = (data.profiles as Array<any>).map((profile) => ({
			name: profile.name,
			java: profile.java ?? null,
			runtime: profile.runtime ?? null,
			flags: profile.flags ?? [],
			jarArgs: profile.jarArgs ?? [],
			usedBy: profile.usedBy ?? []
		}));

		// runtimes the fleet holds, for the picker; a profile may still name one
		// nothing has installed yet, which is why the field stays free text too
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

		const base = profiles.find((row) => row.name === (editingName || copyFrom));

		if (base) {
			profileName = editingName ? base.name : '';
			runtime = base.runtime ?? '';
			java = base.java ?? '';
			flags = base.flags.join(' ');
			jarArgs = base.jarArgs.join(' ');
		}

		loaded = true;
	});

	/** Which java this profile ends up on, in words; the recap and the hint share it. */
	const javaText = $derived(
		java
			? t('web.profilesNew.runsPath', { path: java })
			: runtime
				? t('web.profilesNew.runsRuntime', { id: runtime })
				: t('web.profiles.machineDefault')
	);

	async function submit(): Promise<void> {
		saving = true;

		const note = Notify.loading(t('web.profilesNew.saving', { name: profileName }));

		try {
			if (editing) {
				await patch(`/profiles/${encodeURIComponent(editingName)}`, {
					name: profileName,
					runtime,
					java,
					flags,
					jarArgs
				});
			} else {
				await post('/profiles', { name: profileName, runtime, java, flags, jarArgs });
			}

			note.set({
				level: 'success',
				message: editing
					? t('web.profiles.saved', { name: profileName })
					: t('web.profiles.created', { name: profileName }),
				detail: current?.usedBy.length
					? t('web.profilesNew.savedUsedBy', { instances: current.usedBy.join(', ') })
					: undefined,
				closeable: true
			});

			await goto('/runtime/profiles');
		} catch (err) {
			note.set({
				level: 'error',
				message: t('web.profiles.saveFailed', { name: profileName }),
				detail: (err as Error).message,
				closeable: true
			});

			saving = false;
		}
	}
</script>

<Wizard
	title={editing ? t('web.profiles.editTitle', { name: editingName }) : t('web.profiles.newProfile')}
	description={t('web.profilesNew.pageDescription')}
	submitLabel={editing ? t('web.profiles.save') : t('web.profiles.create')}
	disabled={!ready || !loaded}
	loading={saving}
	onsubmit={submit}
>
	{#snippet summary()}
		{profileName || t('web.profilesNew.unnamed')} · {javaText} · {t('web.profilesNew.flagCount', {
			count: flagList.length
		})}
	{/snippet}

	<Panel title={t('web.profilesNew.identity')} description={t('web.profilesNew.identityDescription')}>
		<label class="field">
			<span class="lbl">{t('web.common.name')}</span>
			<span class="hint">{t('web.profiles.nameHint')}</span>
			<input class="input mono" bind:value={profileName} placeholder="aikar" disabled={saving} />
			{#if nameError}<span class="err">{nameError}</span>{/if}
		</label>

		{#if editing && current?.usedBy.length}
			<p class="dim used">
				{t('web.profilesNew.renameMoves', { instances: current.usedBy.join(', ') })}
			</p>
		{/if}

		{#if copyFrom && !editing}
			<p class="dim used">{t('web.profiles.copiedFrom', { name: copyFrom })}</p>
		{/if}
	</Panel>

	<Panel title={t('web.profilesNew.javaPanel')} description={t('web.profilesNew.javaPanelDescription')}>
		<div class="field">
			<span class="lbl">{t('web.profiles.colRuntime')}</span>
			<span class="hint">{t('web.profiles.runtimeHint')}</span>
			<Select
				bind:value={runtime}
				width="100%"
				searchable
				options={[
					{ value: '', label: t('web.profiles.machineDefault') },
					...runtimeIds.map((id) => ({ value: id, label: id })),
					...(runtime && !runtimeIds.includes(runtime) ? [{ value: runtime, label: runtime }] : [])
				]}
			/>
		</div>

		<label class="field">
			<span class="lbl">{t('web.profiles.colJava')}</span>
			<span class="hint">{t('web.profiles.javaHint')}</span>
			<input class="input mono" bind:value={java} placeholder={t('web.profiles.none')} />
		</label>

		{#if shadowed}
			<p class="shadow">
				<StatusBadge state="warning" label={t('web.profilesNew.pathWins')} />
				<span class="dim">{t('web.profiles.javaShadows')}</span>
			</p>
		{/if}
	</Panel>

	<Panel title={t('web.profilesNew.flagsPanel')} description={t('web.profilesNew.flagsPanelDescription')}>
		<label class="field">
			<span class="lbl">{t('web.profiles.colFlags')}</span>
			<span class="hint">{t('web.profiles.flagsHint')}</span>
			<textarea class="input mono flags" rows="10" bind:value={flags}></textarea>
			<span class="hint">{t('web.profilesNew.flagCount', { count: flagList.length })}</span>
		</label>

		<label class="field">
			<span class="lbl">{t('web.profiles.colJarArgs')}</span>
			<span class="hint">{t('web.profiles.jarArgsHint')}</span>
			<input class="input mono" bind:value={jarArgs} placeholder={t('web.profiles.none')} />
		</label>
	</Panel>
</Wizard>

<style lang="scss">
	.field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;

		& + .field {
			margin-top: 1rem;
		}
	}

	.lbl {
		font-weight: 600;
	}

	.hint {
		font-size: 0.75rem;
		color: var(--text-dim);
	}

	.err {
		font-size: 0.75rem;
		color: var(--danger);
	}

	.used {
		margin-top: 0.75rem;
		font-size: 0.875rem;
	}

	.shadow {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 1rem;
		font-size: 0.875rem;
	}

	.flags {
		resize: vertical;
		line-height: 1.5;
	}
</style>
