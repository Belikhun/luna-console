<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, patch, post } from '$lib/api';
	import { fmtBytes } from '$lib/format';
	import Wizard from '$lib/components/Wizard.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
	import Select from '$lib/components/Select.svelte';
	import RuleMatrix from '$lib/components/RuleMatrix.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * Configure one resource pack: the registration the proxy reads, in the
	 * order an operator decides it; what it is, whether it is on, who gets it,
	 * how it updates. The server rules are edited as a matrix of backends with
	 * the raw rule list beside it, because the rules are what the plugin reads
	 * and hiding them would make an unexpected result unexplainable.
	 */

	const key = $derived(page.params.key);

	let loading = $state(true);
	let saving = $state(false);

	let name = $state('');
	let priority = $state(0);
	let required = $state(false);
	let enabled = $state(false);
	let servers: string[] = $state([]);
	let autoUpdate = $state(false);
	let channel = $state('release');

	/** Facts about the pack the form does not edit but does explain itself with. */
	let sizeBytes = $state(0);
	let present = $state(true);
	let registered = $state(true);
	let granted: string[] = $state([]);
	let groups: string[] = $state([]);
	let hasProvider = $state(false);
	let instances: string[] = $state([]);
	let running: string[] = $state([]);

	/** The rules as text, kept in step with the matrix in both directions. */
	let rulesText = $state('');

	async function load(): Promise<void> {
		loading = true;

		try {
			const { detail } = await api(`/respacks/${encodeURIComponent(key ?? '')}/detail?probe=0`);
			const pack = detail.pack;

			name = pack.name;
			priority = pack.priority;
			required = pack.required;
			enabled = pack.enabled;
			servers = pack.servers.length ? [...pack.servers] : ['*'];
			rulesText = servers.join(', ');
			autoUpdate = pack.autoUpdate;
			channel = pack.channel ?? 'release';
			sizeBytes = pack.sizeBytes;
			present = pack.present;
			registered = !!pack.defFile;
			granted = pack.granted;
			groups = pack.groups;
			hasProvider = !!pack.remote;
			instances = detail.instances.map((row: any) => row.name);
			running = detail.instances.filter((row: any) => row.running).map((row: any) => row.name);
		} catch (err) {
			Notify.error(`Could not load ${key}`, { detail: (err as Error).message });
		}

		loading = false;
	}

	onMount(() => {
		void load();
	});

	// matrix → text, one direction only: this effect never reads `rulesText`, so
	// rewriting it cannot wake the effect again. Text → matrix goes through
	// applyText on change/blur, which normalises the text on the way back here.
	$effect(() => {
		rulesText = servers.join(', ');
	});

	function parseRules(text: string): string[] {
		return text
			.split(',')
			.map((rule) => rule.trim())
			.filter(Boolean);
	}

	function applyText(): void {
		servers = parseRules(rulesText);
	}

	const invalid = $derived.by(() => {
		if (!name.trim()) {
			return 'a display name is required';
		}

		// an emptied number input reads back as null, and a definition needs a number
		if (!Number.isFinite(priority)) {
			return 'priority must be a whole number';
		}

		return '';
	});

	async function save(): Promise<void> {
		saving = true;

		const note = Notify.loading(`Saving ${key}…`);

		try {
			await patch(`/respacks/${encodeURIComponent(key ?? '')}`, {
				name,
				priority,
				required,
				enabled,
				servers,
				autoUpdate,
				channel
			});

			const reload = await post('/respacks/reload');

			note.set({
				level: 'success',
				message: `${key} saved`,
				detail: reload.sent
					? 'Reload sent to the proxy; the change is live.'
					: 'The proxy is not running; the change applies on its next boot.',
				closeable: true
			});

			await goto(`/packs/${encodeURIComponent(key ?? '')}`);
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not save ${key}`,
				detail: (err as Error).message,
				closeable: true
			});
		}

		saving = false;
	}
</script>

<Wizard
	title="Configure {key}"
	windowTitle="Configure {key}"
	description={t('web.packConfigure.theRegistrationTheLunaPack')}
	submitLabel={t('web.packConfigure.saveAndReload')}
	disabled={loading || !!invalid}
	loading={saving}
	onsubmit={save}
>
	{#snippet summary()}
		{#if loading}
			loading…
		{:else}
			{enabled ? 'enabled' : 'disabled'} · priority {priority} · {required
				? 'required'
				: 'optional'} · {servers.join(', ') || 'no rules'}
		{/if}
	{/snippet}

	<Panel title={t('web.packConfigure.identity')} description={t('web.packConfigure.whatThePackIsCalled')}>
		<label class="field">
			<span class="lbl">{t('web.packConfigure.displayName')}</span>
			<span class="hint">
				{t('web.packConfigure.lunaPackKeysIts')}
			</span>
			<input class="input" bind:value={name} disabled={loading} />
			{#if invalid}<span class="err">{invalid}</span>{/if}
		</label>

		<label class="field">
			<span class="lbl">{t('web.packConfigure.priority')}</span>
			<span class="hint">{t('web.packConfigure.higherPriorityPacksApply')}</span>
			<input
				class="input num"
				type="number"
				min="0"
				step="1"
				bind:value={priority}
				disabled={loading}
			/>
		</label>

		<div class="facts dim">
			<span>{t('web.packConfigure.file')} <code class="mono">{key}.zip</code></span>
			<span>{present ? fmtBytes(sizeBytes) : 'missing on disk'}</span>
			{#if !registered}
				<StatusBadge
					state="warning"
					label={t('web.packConfigure.unregistered')}
					detail="the zip exists but no definition registers it; saving here writes one"
				/>
			{/if}
		</div>
	</Panel>

	<Panel title={t('web.packConfigure.availability')} description={t('web.packConfigure.whetherTheProxyOffersThe')}>
		<label class="checkrow">
			<Checkbox checked={enabled} label={t('web.packConfigure.enabled')} disabled={loading} onchange={(value) => (enabled = value)} />
			<span>
				<b>{t('web.packConfigure.enabled')}</b>
				<span class="dim">{t('web.packConfigure.theProxyOffersThis')}</span>
			</span>
		</label>
		<label class="checkrow">
			<Checkbox checked={required} label={t('web.packConfigure.required')} disabled={loading} onchange={(value) => (required = value)} />
			<span>
				<b>{t('web.packConfigure.required')}</b>
				<span class="dim">{t('web.packConfigure.playersCannotDeclineIt')}</span>
			</span>
		</label>
	</Panel>

	<Panel
		title={t('web.packConfigure.whereItApplies')}
		count={servers.length}
		description={t('web.packConfigure.tickTheBackendsThatShould')}
	>
		{#if instances.length}
			<RuleMatrix {instances} bind:servers {granted} {running} />
		{:else}
			<p class="dim none">{t('web.packConfigure.noBackendsInThe')}</p>
		{/if}

		<label class="field rules">
			<span class="lbl">{t('web.packConfigure.ruleList')}</span>
			<span class="hint">
				Comma-separated: instance names, <code>*</code> {t('web.packConfigure.forAll')} <code>{t('web.packConfigure.name')}</code> {t('web.packConfigure.toExclude')}
				{t('web.packConfigure.exclusionsWin')}
			</span>
			<input
				class="input mono"
				bind:value={rulesText}
				onchange={applyText}
				onblur={applyText}
				disabled={loading}
				placeholder={t('web.packConfigure.create')}
			/>
		</label>

		{#if granted.length}
			<p class="dim note">
				Addon group{groups.length > 1 ? 's' : ''}
				{groups.join(', ')} grant{groups.length > 1 ? '' : 's'}
				<b>{granted.join(', ')}</b>; those come back whatever this list says, so they are locked
				above.
			</p>
		{/if}
	</Panel>

	{#if hasProvider}
		<Panel title={t('web.packConfigure.updates')} description={t('web.packConfigure.howThisPackFollowsIts')}>
			<label class="checkrow">
				<Checkbox
					checked={autoUpdate}
					label={t('web.packConfigure.autoUpdate')}
					disabled={loading}
					onchange={(value) => (autoUpdate = value)}
				/>
				<span>
					<b>{t('web.packConfigure.autoUpdate')}</b>
					<span class="dim">{t('web.packConfigure.updateChecksDownloadNewer')}</span>
				</span>
			</label>
			<label class="field">
				<span class="lbl">{t('web.packConfigure.updateChannel')}</span>
				<span class="hint">{t('web.packConfigure.theMostUnstableRelease')}</span>
				<Select
					value={channel}
					width="10rem"
					options={[
						{ value: 'release', label: t('web.packConfigure.release') },
						{ value: 'beta', label: t('web.packConfigure.beta') },
						{ value: 'alpha', label: t('web.packConfigure.alpha') }
					]}
					onchange={(value) => (channel = value)}
				/>
			</label>
		</Panel>
	{/if}
</Wizard>

<style lang="scss">
	.field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin-bottom: 0.875rem;

		&:last-child {
			margin-bottom: 0;
		}
	}

	.lbl {
		font-weight: 700;
		color: var(--text-heading);
	}

	.hint {
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.err {
		font-size: 0.75rem;
		color: var(--error);
	}

	.checkrow {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		margin-bottom: 0.75rem;

		&:last-child {
			margin-bottom: 0;
		}
	}

	// the read-only facts under the identity fields: file name, size, warnings
	.facts {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 1rem;
		font-size: 0.8125rem;
	}

	// wide enough for a priority anyone would type, narrow enough not to read as
	// a text field
	.num {
		width: 8rem;
	}

	.rules {
		margin-top: 1rem;
	}

	.note {
		margin: 0.75rem 0 0;
		font-size: 0.8125rem;
	}

	.none {
		margin: 0;
		font-size: 0.8125rem;
	}
</style>
