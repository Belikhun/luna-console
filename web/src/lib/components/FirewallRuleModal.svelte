<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { onMount, untrack } from 'svelte';

	import { cidrContains, countryName, looksLikeRange, parseList } from '$lib/firewall';
	import { t } from '$lib/i18n.svelte';
	import type { FirewallAction, FirewallRule, FirewallRuleInput } from '$shared/firewall';

	import Btn from './Btn.svelte';
	import CountryPicker from './CountryPicker.svelte';
	import Flash from './Flash.svelte';
	import Modal from './Modal.svelte';
	import SegmentedControl from './SegmentedControl.svelte';
	import Toggle from './Toggle.svelte';
	import type { SegmentOption } from './segmented';

	/**
	 * The editor of one firewall rule: allow or deny, the addresses and the
	 * countries it matches (both, when both are given), a note, on or off. A
	 * refusal keeps the dialog open with every field as it was.
	 */
	let {
		open = $bindable(false),
		rule,
		preset,
		you = null,
		youCountry = null,
		countriesHeld,
		onsave
	}: {
		open: boolean;
		/** The rule being changed; null for a new one */
		rule: FirewallRule | null;
		/** What a new rule starts from, when a shortcut opened the editor */
		preset?: Partial<FirewallRuleInput>;
		/** The reader's own address, warned about before a deny rule shuts it out */
		you?: string | null;
		youCountry?: string | null;
		/** Whether the proxy holds any country data yet; a country rule waits for it otherwise */
		countriesHeld: boolean;
		/** Saves the rule; a rejection stays in the dialog */
		onsave: (body: FirewallRuleInput) => Promise<void>;
	} = $props();

	const uid = $props.id();

	const NOTE_MAX = 200;

	let action = $state<FirewallAction>('deny');
	let addressesText = $state('');
	let countries = $state<string[]>([]);
	let note = $state('');
	let enabled = $state(true);

	let saving = $state(false);
	let error = $state('');
	let narrow = $state(false);
	let addressField = $state<HTMLTextAreaElement>();
	let wasOpen = false;

	// each opening starts from the rule it is about, and only the opening: the
	// screen refreshes underneath, and a new rule object must not wipe the form
	$effect(() => {
		const opening = open && !wasOpen;

		wasOpen = open;

		if (!opening) {
			return;
		}

		untrack(() => {
			const from = rule ?? preset ?? {};

			action = from.action ?? 'deny';
			addressesText = (from.addresses ?? []).join('\n');
			countries = [...(from.countries ?? [])];
			note = from.note ?? '';
			enabled = rule?.enabled ?? from.enabled ?? true;
			saving = false;
			error = '';
			queueMicrotask(() => addressField?.focus());
		});
	});

	onMount(() => {
		// the segmented control fills the row once the dialog is too narrow to sit it inline
		const media = window.matchMedia('(max-width: 64rem)');
		const follow = (): void => {
			narrow = media.matches;
		};

		follow();
		media.addEventListener('change', follow);

		return () => media.removeEventListener('change', follow);
	});

	const addresses = $derived(parseList(addressesText));
	const badAddress = $derived(addresses.find((entry) => !looksLikeRange(entry)));
	const deny = $derived(action === 'deny');
	const coversYou = $derived(deny && !!you && addresses.some((entry) => looksLikeRange(entry) && cidrContains(entry, you)));
	const coversCountry = $derived(deny && !!youCountry && countries.includes(youCountry));
	const hasMine = $derived(!!you && addresses.some((entry) => looksLikeRange(entry) && cidrContains(entry, you)));

	const reason = $derived.by((): string | undefined => {
		if (addresses.length + countries.length === 0) {
			return t('web.firewall.editor.needMatcher');
		}

		if (badAddress !== undefined) {
			return t('web.firewall.editor.fixFields');
		}

		return undefined;
	});

	const actionOptions: SegmentOption[] = $derived([
		{ id: 'allow', label: t('web.firewall.action.allow'), icon: 'circleCheck' },
		{ id: 'deny', label: t('web.firewall.action.deny'), icon: 'ban' }
	]);

	const actionHint = $derived(t(`web.firewall.editor.${deny ? 'deny' : 'allow'}Hint`));

	// the rule in words, so the dialog's own summary is the confirmation
	const summary = $derived.by((): string => {
		const parts: string[] = [];

		if (countries.length > 0) {
			parts.push(countries.map((code) => countryName(code)).join(', '));
		}

		if (addresses.length > 0) {
			parts.push(t('web.firewall.editor.summaryAddresses', { count: addresses.length }));
		}

		if (parts.length === 0) {
			return '';
		}

		return t(`web.firewall.editor.summary${deny ? 'Deny' : 'Allow'}`, {
			what: parts.join(t('web.firewall.editor.summaryAnd'))
		});
	});

	function edited(): void {
		error = '';
	}

	function addMine(): void {
		if (!you) {
			return;
		}

		addressesText = addressesText.trim() === ''
			? you
			: `${addressesText.trimEnd()}\n${you}`;
		edited();
	}

	async function submit(): Promise<void> {
		if (reason !== undefined || saving) {
			return;
		}

		saving = true;
		error = '';

		try {
			await onsave({
				...(rule ? { id: rule.id } : {}),
				action,
				enabled,
				addresses,
				countries,
				note: note.trim()
			});
			open = false;
		} catch (err) {
			error = (err as Error).message;
		} finally {
			saving = false;
		}
	}

	/** Enter in a textarea is a new line; Ctrl+Enter saves from there. */
	function areaKey(event: KeyboardEvent): void {
		if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			void submit();
		}
	}
</script>

<Modal title={rule ? t('web.firewall.editor.editTitle') : t('web.firewall.editor.addTitle')} bind:open wide>
	<form
		onsubmit={(event) => {
			event.preventDefault();
			void submit();
		}}
	>
		<!-- first in the form, so Enter in a one-line field saves rather than pressing some other button -->
		<button type="submit" hidden aria-hidden="true" tabindex="-1"></button>

		<div class="field">
			<span class="lbl">{t('web.firewall.editor.action')}</span>
			<SegmentedControl
				options={actionOptions}
				value={action}
				label={t('web.firewall.editor.action')}
				fill={narrow}
				onchange={(id) => {
					action = id as FirewallAction;
					edited();
				}}
			/>
			<span class="hint under">{actionHint}</span>
		</div>

		<p class="match dim">{t('web.firewall.editor.matchHint')}</p>

		<div class="pair">
			<!-- a field, not a label: the hint, the error and the button are not the control's name -->
			<div class="field">
				<label class="lbl" for="{uid}-addresses">{t('web.firewall.editor.addresses')}</label>
				<span class="hint" id="{uid}-addresses-hint">{t('web.firewall.editor.addressesHint')}</span>
				<textarea
					id="{uid}-addresses"
					aria-describedby="{uid}-addresses-hint{badAddress !== undefined ? ` ${uid}-addresses-error` : ''}"
					aria-invalid={badAddress !== undefined}
					class="input mono"
					class:bad={badAddress !== undefined}
					rows="4"
					spellcheck="false"
					bind:value={addressesText}
					bind:this={addressField}
					oninput={edited}
					onkeydown={areaKey}
				></textarea>
				{#if badAddress !== undefined}
					<span class="err" id="{uid}-addresses-error">{t('web.firewall.editor.badAddress', { value: badAddress })}</span>
				{/if}
				{#if you && !hasMine}
					<span class="more">
						<Btn variant="link" onclick={addMine}>{t('web.firewall.editor.addMine', { address: you })}</Btn>
					</span>
				{/if}
			</div>

			<div class="field">
				<span class="lbl">{t('web.firewall.editor.countries')}</span>
				<span class="hint">{t('web.firewall.editor.countriesHint')}</span>
				{#if !countriesHeld && countries.length > 0}
					<Flash kind="info">{t('web.firewall.editor.countriesPending')}</Flash>
				{/if}
				<CountryPicker
					bind:value={countries}
					label={t('web.firewall.editor.countries')}
					invalid={coversCountry}
					onchange={edited}
				/>
			</div>
		</div>

		{#if coversYou}
			<Flash kind="warning">{t('web.firewall.editor.coversYou', { address: you ?? '' })}</Flash>
		{:else if coversCountry}
			<Flash kind="warning">{t('web.firewall.editor.coversYourCountry', { country: countryName(youCountry ?? '') })}</Flash>
		{:else if !deny && countries.length > 0}
			<Flash kind="info">{t('web.firewall.editor.allowCountries')}</Flash>
		{/if}

		<label class="field">
			<span class="lbl">
				{t('web.firewall.editor.note')}
				<span class="counter">{note.length}/{NOTE_MAX}</span>
			</span>
			<input
				class="input"
				type="text"
				maxlength={NOTE_MAX}
				placeholder={t('web.firewall.editor.notePlaceholder')}
				bind:value={note}
				oninput={edited}
			/>
		</label>

		<div class="switch">
			<Toggle checked={enabled} label={t('web.firewall.editor.enabled')} onchange={(value) => {
				enabled = value;
				edited();
			}} />
			<span>
				<b>{t('web.firewall.editor.enabled')}</b>
				<span class="dim">{enabled ? t('web.firewall.editor.enabledOn') : t('web.firewall.editor.enabledOff')}</span>
			</span>
		</div>

		{#if summary}
			<p class="summary">{summary}</p>
		{/if}
	</form>

	{#if error}
		<Flash kind="error">{error}</Flash>
	{/if}

	{#snippet footer()}
		<Btn onclick={() => (open = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="primary" loading={saving} disabled={reason !== undefined} title={reason} onclick={submit}>
			{rule ? t('web.firewall.editor.save') : t('web.firewall.rules.add')}
		</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.match {
		margin: 0 0 0.875rem;
		font-size: 0.875rem;
	}

	.pair {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0 2rem;

		@include below($bp-medium) {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	textarea.input {
		display: block;
		padding: 0.375rem 0.75rem;
		resize: vertical;
	}

	// the error ring, on the box a problem is about
	.input.bad {
		border-color: var(--error);
		box-shadow: 0 0 0 0.1rem var(--error);
	}

	.field {
		// a hint under its control rather than over it
		.under {
			margin: 0.375rem 0 0;
		}

		:global(.flash) {
			margin-bottom: 0.5rem;
		}
	}

	.more {
		display: block;
		margin-top: 0.375rem;
		font-size: 0.875rem;
	}

	.switch {
		display: flex;
		align-items: center;
		gap: 0.75rem;

		> span {
			display: flex;
			flex-direction: column;
			gap: 0.125rem;
		}

		.dim {
			font-size: 0.875rem;
		}
	}

	.summary {
		margin: 1rem 0 0;
		font-size: 0.875rem;
		color: var(--text-secondary);
	}
</style>
