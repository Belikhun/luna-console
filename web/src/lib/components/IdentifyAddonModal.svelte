<script lang="ts">
	import { api, post, del } from '$lib/api';
	import Modal from './Modal.svelte';
	import Btn from './Btn.svelte';
	import Select from './Select.svelte';
	import Toggle from './Toggle.svelte';
	import Flash from './Flash.svelte';
	import StatusBadge from './StatusBadge.svelte';
	import AddonPicker from './AddonPicker.svelte';
	import BrandLink from './BrandLink.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import { fmtBytes } from '$lib/format';
	import type { AddonHit, AddonKindType } from './addons';
	import { IDENTIFY_KINDS, type IdentifyKind, type IdentityProbeView } from './identify';

	/**
	 * Map an addon luna already has to the project it came from.
	 *
	 * Three steps, deliberately not collapsed into one: search a provider, see
	 * what luna can *prove* about the local file, then commit. The middle step is
	 * the reason this dialog exists — the recorded version is what every later
	 * update check compares against, so a guess presented as a fact is how an
	 * "update" silently becomes a downgrade. The verdict is stated in those terms,
	 * and an unproven match never picks a version by itself.
	 *
	 * One dialog serves plugins, mods, resource packs and data packs: the kinds
	 * differ only in which endpoints they use, which `IDENTIFY_KINDS` holds.
	 */
	let {
		open = $bindable(false),
		kind,
		target,
		label,
		family,
		mapped = false,
		onchanged
	}: {
		open?: boolean;
		kind: IdentifyKind;
		/** Lock key: `<plugin>@<family>`, a pack key, or a data pack name */
		target: string;
		/** What to call it in the dialog's own prose */
		label?: string;
		/** Plugin/mod only: narrows the provider search to that platform */
		family?: string;
		/** Whether it is already mapped — the dialog then offers to unmap */
		mapped?: boolean;
		onchanged?: () => void;
	} = $props();

	const spec = $derived(IDENTIFY_KINDS[kind]);
	const name = $derived(label ?? target);

	let provider = $state('modrinth');
	let slug = $state('');
	let projectId = $state('');

	let probing = $state(false);
	let probe = $state<IdentityProbeView | null>(null);
	let failed = $state('');

	/** '' = record no version; otherwise a version id */
	let choice = $state('');

	/**
	 * The verdict lands under a full page of search results, so it is scrolled to
	 * when it appears — the answer to the click the operator just made must not be
	 * below the fold.
	 */
	let verdictEl: HTMLDivElement | undefined = $state();

	$effect(() => {
		if (probe && verdictEl) {
			verdictEl.scrollIntoView({ block: 'end', behavior: 'smooth' });
		}
	});
	let autoUpdate = $state(false);
	let busy = $state('');

	/** Re-arm the dialog whenever it opens, so a second run never shows the first's verdict. */
	$effect(() => {
		if (open) {
			return;
		}

		probe = null;
		failed = '';
		slug = '';
		projectId = '';
		choice = '';
	});

	/**
	 * Ask the daemon what the local file could be at the picked project. The
	 * project is looked up by id when the provider gave one (a slug is not always
	 * enough — CurseForge and Hangar key on ids), else by slug.
	 */
	async function runProbe(hit: AddonHit | undefined): Promise<void> {
		slug = hit?.slug ?? '';
		projectId = hit?.project_id ?? '';
		probe = null;
		failed = '';

		if (!hit) {
			return;
		}

		probing = true;

		try {
			const query = new URLSearchParams({ provider, project: projectId || slug });
			const answer = await api(`${spec.endpoint(target)}?${query}`);

			probe = answer.probe;
			choice = probe?.best?.versionId ?? '';
			autoUpdate = probe?.confidence === 'exact';
		} catch (err) {
			failed = (err as Error).message;
		}

		probing = false;
	}

	/** Versions offered, newest first, with the explicit "no version" entry last. */
	const options = $derived([
		...(probe?.versions ?? []).map((version) => ({
			value: version.versionId,
			label:
				version.versionNumber +
				(version.channel === 'release' ? '' : ` (${version.channel})`) +
				(version.versionId === probe?.best?.versionId ? ' — matched' : '')
		})),
		{ value: '', label: 'Record no version' }
	]);

	const chosen = $derived(probe?.versions.find((version) => version.versionId === choice));

	async function apply(): Promise<void> {
		busy = 'map';

		const note = Notify.loading(`Mapping ${name} to ${provider}…`);

		try {
			const answer = await post(spec.endpoint(target), {
				provider,
				project: projectId || slug,
				versionId: choice || undefined,
				unidentified: !choice,
				autoUpdate
			});

			note.set({
				level: 'success',
				message: `${name} → ${provider}:${slug}`,
				detail: answer.match
					? `Recorded as ${answer.match.versionNumber}. Update checks apply from now on.`
					: 'No version recorded — the next check offers the newest compatible release.',
				closeable: true
			});

			open = false;
			onchanged?.();
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not map ${name}`,
				detail: (err as Error).message,
				closeable: true
			});
		}

		busy = '';
	}

	async function forget(): Promise<void> {
		busy = 'forget';

		const note = Notify.loading(`Unmapping ${name}…`);

		try {
			await del(spec.endpoint(target));

			note.set({
				level: 'success',
				message: `${name} is no longer mapped`,
				detail: 'The file and its deployments are untouched; updates will not be checked.',
				closeable: true
			});

			open = false;
			onchanged?.();
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not unmap ${name}`,
				detail: (err as Error).message,
				closeable: true
			});
		}

		busy = '';
	}
</script>

<Modal title="Map {name} to a provider" bind:open wide>
	<p class="dim lead">
		Point <b>{name}</b> at the project it came from, and luna can check it for updates like any
		installed addon. The file itself is not touched — nothing is downloaded, nothing is renamed.
	</p>

	<div class="picker" class:picked={!!probe}>
		<AddonPicker
			endpoint={spec.search}
			kind={spec.pickerKind}
			params={family ? { family } : {}}
			bind:selected={slug}
			bind:provider
			placeholder={spec.placeholder}
			onpick={runProbe}
		/>
	</div>

	{#if probing}
		<p class="dim probing">Comparing the local file against every published version…</p>
	{:else if failed}
		<Flash kind="error">Could not read that project — {failed}</Flash>
	{:else if probe}
		<div class="verdict" bind:this={verdictEl}>
			<div class="head">
				{#if probe.confidence === 'exact'}
					<StatusBadge state="ok" label="Identified" />
					<span>
						This file <b>is</b> {probe.best?.versionNumber} — its {probe.best?.basis} matches what
						{probe.provider} published.
					</span>
				{:else if probe.confidence === 'likely'}
					<StatusBadge state="warning" label="Probable" />
					<span>
						Looks like {probe.best?.versionNumber}, matched by {probe.best?.basis} rather than a
						hash. Check it, or record no version.
					</span>
				{:else}
					<StatusBadge state="warning" label="Not identified" />
					<span>
						No published version matches this file — it may be repackaged, or built from source.
						Map the project anyway, or pick the version by hand.
					</span>
				{/if}
			</div>

			<dl class="facts">
				<dt>Local file</dt>
				<dd class="mono">{probe.local.file} · {fmtBytes(probe.local.sizeBytes)}</dd>
				<dt>Project</dt>
				<dd>
					<BrandLink source={probe.provider} label={probe.project.title} />
				</dd>
				{#if probe.newest}
					<dt>Newest release</dt>
					<dd>{probe.newest.versionNumber}</dd>
				{/if}
			</dl>

			<div class="controls">
				<Select
					label="Record as version"
					bind:value={choice}
					options={options}
					width="20rem"
					searchable
				/>
				<label class="auto">
					<Toggle checked={autoUpdate} onchange={(value) => (autoUpdate = value)} />
					Check for updates automatically
				</label>
			</div>

			{#if !choice}
				<p class="dim note">
					With no version recorded, the first update check offers the newest compatible release —
					even if this file already is it.
				</p>
			{:else if chosen && !chosen.exact && probe.confidence !== 'exact'}
				<p class="dim note">
					luna will treat this file as {chosen.versionNumber}. Anything published before it is then
					never offered as an update.
				</p>
			{/if}
		</div>
	{/if}

	{#snippet footer()}
		{#if mapped}
			<Btn variant="danger" loading={busy === 'forget'} onclick={forget}>Unmap</Btn>
		{/if}
		<Btn onclick={() => (open = false)}>Cancel</Btn>
		<Btn variant="primary" disabled={!probe} loading={busy === 'map'} onclick={apply}>
			{choice ? 'Map and record version' : 'Map without a version'}
		</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.lead {
		margin: 0 0 1rem;
		font-size: 0.875rem;
	}

	// the search results are the whole dialog until a project is picked; after
	// that the verdict is, so the list gives its space back
	.picker.picked :global(.results) {
		max-height: 11rem;
		overflow: auto;
	}

	.probing {
		margin: 1rem 0 0;
		font-size: 0.875rem;
	}

	.verdict {
		margin-top: 1rem;
		padding-top: 1rem;
		border-top: var(--hairline) solid var(--border-divider);
	}

	.head {
		display: flex;
		align-items: flex-start;
		gap: 0.625rem;
		font-size: 0.875rem;
		line-height: 1.5;
	}

	// label/value pairs rather than an InfoGrid: three facts inside a dialog do
	// not want the panel chrome a grid brings
	.facts {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.375rem 1rem;
		margin: 1rem 0 0;
		font-size: 0.8125rem;

		dt {
			color: var(--text-label);
		}

		dd {
			margin: 0;
		}
	}

	.controls {
		display: flex;
		align-items: center;
		gap: 1.25rem;
		margin-top: 1.25rem;
		flex-wrap: wrap;
	}

	.auto {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.875rem;
		cursor: pointer;
	}

	.note {
		margin: 0.75rem 0 0;
		font-size: 0.8125rem;
	}
</style>
