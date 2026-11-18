<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { untrack } from 'svelte';

	import { api, post } from '$lib/api';
	import { cidrContains, countryName, looksLikeBanTarget } from '$lib/firewall';
	import { fmtDateTime } from '$lib/format';
	import { t } from '$lib/i18n.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import type { FirewallVerdict } from '$shared/firewall';

	import Btn from './Btn.svelte';
	import Flash from './Flash.svelte';
	import Modal from './Modal.svelte';
	import Select from './Select.svelte';
	import Spinner from './Spinner.svelte';

	/**
	 * Ban an address or a prefix from the whole network, for a while or until it
	 * is lifted. Once the text reads as an address, the dialog looks it up and
	 * says what is already true of it: its country, a ban it holds, the bans it
	 * had before, a rule that lets it in anyway. Opened for several addresses
	 * (a bulk promote), the field becomes the list it bans.
	 */
	let {
		open = $bindable(false),
		addresses: initial = [],
		reason: initialReason = '',
		you = null,
		onbanned
	}: {
		open: boolean;
		/** Prefilled when a shortcut opened the dialog; more than one makes the field a list */
		addresses?: string[];
		reason?: string;
		/** The reader's own address, warned about before banning it */
		you?: string | null;
		onbanned?: () => void;
	} = $props();

	const uid = $props.id();

	const NOTE_MAX = 200;
	const LOOKUP_DELAY_MS = 300;

	let address = $state('');
	let many = $state<string[]>([]);
	let length = $state('forever');
	let amount = $state('');
	let unit = $state('60');
	let note = $state('');
	let saving = $state(false);
	let error = $state('');
	let field = $state<HTMLInputElement>();

	let facts = $state<(FirewallVerdict & { geoCountry: string | null; history: unknown[] }) | null>(null);
	let looking = $state(false);
	let wasOpen = false;

	$effect(() => {
		const opening = open && !wasOpen;

		wasOpen = open;

		if (!opening) {
			return;
		}

		untrack(() => {
			many = initial.length > 1
				? [...initial]
				: [];
			address = initial.length === 1
				? initial[0]!
				: '';
			length = 'forever';
			amount = '';
			unit = '60';
			note = initialReason;
			saving = false;
			error = '';
			facts = null;
			queueMicrotask(() => field?.focus());
		});
	});

	const typed = $derived(address.trim());
	const targets = $derived(many.length > 0
		? many
		: [typed]);
	const valid = $derived(many.length > 0 || looksLikeBanTarget(typed));
	const custom = $derived(length === 'custom');
	const customAmount = $derived(Number(amount.trim()));
	const badAmount = $derived(custom && !(Number.isInteger(customAmount) && customAmount >= 1 && customAmount * Number(unit) <= 525_600));
	const isMine = $derived(!!you && targets.some((target) => looksLikeBanTarget(target) && cidrContains(target, you)));

	// what is already true of the address, read a moment after typing stops
	$effect(() => {
		const wanted = typed;

		facts = null;

		if (!open || many.length > 0 || !looksLikeBanTarget(wanted)) {
			looking = false;

			return;
		}

		// a prefix is looked up by its first address
		const probe = wanted.split('/')[0] ?? wanted;

		looking = true;

		const timer = setTimeout(() => {
			api(`/firewall/check?ip=${encodeURIComponent(probe)}`)
				.then((answer) => {
					if (untrack(() => typed) === wanted) {
						facts = answer;
					}
				})
				// a failed lookup says nothing and blocks nothing
				.catch(() => null)
				.finally(() => {
					if (untrack(() => typed) === wanted) {
						looking = false;
					}
				});
		}, LOOKUP_DELAY_MS);

		return () => clearTimeout(timer);
	});

	const fact = $derived.by((): { tone: 'warning' | 'info' | 'plain'; text: string } | null => {
		if (!facts) {
			return null;
		}

		if (facts.ban) {
			return {
				tone: 'warning',
				text: facts.ban.expiresAtEpochMillis === 0
					? t('web.firewall.ban.factBannedForever')
					: t('web.firewall.ban.factBanned', { until: fmtDateTime(facts.ban.expiresAtEpochMillis) })
			};
		}

		if (facts.allowedBy) {
			return { tone: 'info', text: t('web.firewall.ban.factAllowed', { rule: facts.allowedBy.note || facts.allowedBy.id }) };
		}

		if (facts.protected) {
			return { tone: 'info', text: t('web.firewall.ban.factProtected') };
		}

		return {
			tone: 'plain',
			text: facts.strikes > 0
				? t('web.firewall.ban.factStrikes', { count: facts.strikes })
				: t('web.firewall.ban.factClear')
		};
	});

	const lengthOptions = $derived([
		{ value: '60', label: t('web.firewall.ban.hour') },
		{ value: '1440', label: t('web.firewall.ban.day') },
		{ value: '10080', label: t('web.firewall.ban.week') },
		{ value: '43200', label: t('web.firewall.ban.month') },
		{ value: 'forever', label: t('web.firewall.ban.forever') },
		{ value: 'custom', label: t('web.firewall.ban.custom') }
	]);

	const unitOptions = $derived([
		{ value: '1', label: t('web.firewall.ban.unitMinutes') },
		{ value: '60', label: t('web.firewall.ban.unitHours') },
		{ value: '1440', label: t('web.firewall.ban.unitDays') }
	]);

	const minutes = $derived(length === 'forever'
		? 0
		: custom
			? customAmount * Number(unit)
			: Number(length));

	const ends = $derived(minutes > 0 && !badAmount
		? t('web.firewall.ban.ends', { time: fmtDateTime(Date.now() + minutes * 60_000) })
		: length === 'forever'
			? t('web.firewall.ban.never')
			: '');

	const reason = $derived.by((): string | undefined => {
		if (many.length === 0 && typed === '') {
			return t('web.firewall.ban.needAddress');
		}

		if (!valid) {
			return t('web.firewall.ban.badAddress');
		}

		if (badAmount) {
			return t('web.firewall.ban.badMinutes');
		}

		return undefined;
	});

	function edited(): void {
		error = '';
	}

	async function submit(): Promise<void> {
		if (reason !== undefined || saving) {
			return;
		}

		saving = true;
		error = '';

		try {
			const result = await post<{ outcomes: Array<{ ip: string; ok: boolean; error?: string; kicked?: string[] }> }>('/firewall/bans', {
				action: 'add',
				ips: targets,
				reason: note.trim(),
				expiresAt: minutes > 0
					? Date.now() + minutes * 60_000
					: 0
			});
			const failed = result.outcomes.filter((outcome) => !outcome.ok);
			const kicked = result.outcomes.flatMap((outcome) => outcome.kicked ?? []);
			const detail = kicked.length > 0
				? t('web.firewall.ban.kicked', { players: kicked.join(', ') })
				: undefined;

			if (failed.length === 0) {
				Notify.success(targets.length === 1
					? t('web.firewall.ban.done', { address: targets[0]! })
					: t('web.firewall.ban.doneMany', { count: targets.length }), { detail });
				open = false;
				onbanned?.();

				return;
			}

			if (targets.length === 1) {
				error = failed[0]!.error ?? t('web.firewall.ban.failed');

				return;
			}

			Notify.warning(t('web.firewall.bulkDone', { done: targets.length - failed.length, total: targets.length }), {
				detail: failed.map((outcome) => `${outcome.ip}: ${outcome.error}`).join('\n')
			});
			open = false;
			onbanned?.();
		} catch (err) {
			error = (err as Error).message;
		} finally {
			saving = false;
		}
	}
</script>

<Modal title={t('web.firewall.ban.title')} bind:open>
	<form
		onsubmit={(event) => {
			event.preventDefault();
			void submit();
		}}
	>
		<!-- first in the form, so Enter in a field bans rather than pressing some other button -->
		<button type="submit" hidden aria-hidden="true" tabindex="-1"></button>

		{#if many.length > 0}
			<div class="field">
				<span class="lbl">{t('web.firewall.ban.addressesCount', { count: many.length })}</span>
				<div class="chips">
					{#each many as entry (entry)}
						<span class="chip mono">{entry}</span>
					{/each}
				</div>
			</div>
		{:else}
			<!-- a field, not a label: the hint and what is known of the address are not the control's name -->
			<div class="field">
				<label class="lbl" for="{uid}-address">{t('web.firewall.ban.address')}</label>
				<span class="hint" id="{uid}-address-hint">{t('web.firewall.ban.addressHint')}</span>
				<input
					id="{uid}-address"
					aria-describedby="{uid}-address-hint {uid}-address-note"
					aria-invalid={typed !== '' && !valid}
					class="input mono"
					class:bad={typed !== '' && !valid}
					type="text"
					spellcheck="false"
					autocomplete="off"
					bind:value={address}
					bind:this={field}
					oninput={edited}
				/>
				<span class="note" id="{uid}-address-note">
					{#if typed !== '' && !valid}
						<span class="err">{t('web.firewall.ban.badAddress')}</span>
					{:else if looking}
						<span class="facts dim"><Spinner size="0.75rem" /> {t('web.common.loading')}</span>
					{:else if facts && fact}
						<span class="facts {fact.tone}">
							{#if facts.geoCountry}
								<span class="country"><span class="mono">{facts.geoCountry}</span> {countryName(facts.geoCountry)}</span>
								<span class="sep" aria-hidden="true">·</span>
							{/if}
							<span>{fact.text}</span>
						</span>
					{/if}
				</span>
			</div>
		{/if}

		{#if isMine}
			<Flash kind="warning">{t('web.firewall.ban.yours', { address: you ?? '' })}</Flash>
		{/if}

		<div class="field">
			<span class="lbl">{t('web.firewall.ban.for')}</span>
			<div class="length">
				<Select
					ariaLabel={t('web.firewall.ban.for')}
					options={lengthOptions}
					width="100%"
					searchable={false}
					bind:value={length}
					onchange={edited}
				/>
				{#if custom}
					<input
						class="input amount"
						class:bad={badAmount && amount.trim() !== ''}
						type="text"
						inputmode="numeric"
						aria-label={t('web.firewall.ban.amount')}
						bind:value={amount}
						oninput={edited}
					/>
					<span class="unit">
						<Select ariaLabel={t('web.firewall.ban.unit')} options={unitOptions} width="100%" searchable={false} bind:value={unit} />
					</span>
				{/if}
			</div>
			{#if badAmount && amount.trim() !== ''}
				<span class="err">{t('web.firewall.ban.badMinutes')}</span>
			{:else if ends}
				<span class="hint">{ends}</span>
			{/if}
		</div>

		<label class="field">
			<span class="lbl">
				{t('web.firewall.ban.note')}
				<span class="counter">{note.length}/{NOTE_MAX}</span>
			</span>
			<input
				class="input"
				type="text"
				maxlength={NOTE_MAX}
				placeholder={t('web.firewall.ban.notePlaceholder')}
				bind:value={note}
				oninput={edited}
			/>
		</label>

		<p class="consequence">{t('web.firewall.ban.consequence')}</p>
	</form>

	{#if error}
		<Flash kind="error">{error}</Flash>
	{/if}

	{#snippet footer()}
		<Btn onclick={() => (open = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="danger" icon="ban" loading={saving} disabled={reason !== undefined} title={reason} onclick={submit}>
			{many.length > 1
				? t('web.firewall.ban.submitMany', { count: many.length })
				: t('web.firewall.ban.submit')}
		</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	// the error ring, on the box a problem is about
	.input.bad {
		border-color: var(--error);
		box-shadow: 0 0 0 0.1rem var(--error);
	}

	.note {
		display: block;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		margin-top: 0.25rem;
	}

	.chip {
		padding: 0 0.375rem;
		border-radius: 0.25rem;
		background: var(--bg-hover);
		line-height: 1.5rem;
	}

	// what is already true of the address, under the box
	.facts {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.5rem;
		margin-top: 0.375rem;
		font-size: 0.875rem;
		color: var(--text-secondary);

		&.warning {
			color: var(--warning);
		}

		&.info {
			color: var(--info);
		}

		.country {
			color: var(--text);
		}
	}

	.length {
		display: flex;
		gap: 0.75rem;
		margin-top: 0.25rem;

		// the select takes the row; the custom length sits beside it when asked for
		> :global(:first-child) {
			flex: 1;
			min-width: 0;
		}

		.amount {
			flex: none;
			width: 5rem;
		}

		.unit {
			flex: none;
			width: 8rem;
		}
	}

	.consequence {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.875rem;
	}
</style>
