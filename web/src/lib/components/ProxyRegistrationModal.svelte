<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { api, put } from '$lib/api';
	import Modal from './Modal.svelte';
	import Btn from './Btn.svelte';
	import Select from './Select.svelte';
	import Toggle from './Toggle.svelte';
	import Checkbox from './Checkbox.svelte';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * Edit one instance's velocity registration: whether it is in [servers],
	 * where it sits in the try list, and its forced hosts. Shared by the proxy
	 * routing screen (any server, picker included) and an instance's network
	 * tab (that instance only). Saving writes the registry; velocity.toml
	 * follows through the sync the dialog offers alongside.
	 */
	let {
		open = $bindable(false),
		instance = '',
		choices = [],
		oncommitted
	}: {
		open?: boolean;
		/** the instance whose registration is edited; empty = offer a picker */
		instance?: string;
		/** picker candidates when no instance is given */
		choices?: Array<{ name: string; register: boolean; external: boolean }>;
		oncommitted?: () => void;
	} = $props();

	interface Peer {
		name: string;
		register: boolean;
		priority: number | null;
		forcedHosts: string[];
	}

	let target = $state('');
	let loading = $state(false);
	let busy = $state(false);

	let register = $state(false);
	let inTry = $state(false);
	let priority: number | null = $state(null);
	let hostsText = $state('');
	let syncNow = $state(true);
	let reloadNow = $state(true);
	let peers: Peer[] = $state([]);

	// (re)prime the form whenever the dialog opens; picker mode starts on the
	// first unregistered backend, since that is what "register a server" is for
	$effect(() => {
		if (open) {
			target =
				instance ||
				(choices.find((choice) => !choice.register) ?? choices[0])?.name ||
				'';

			if (target) {
				void load(target);
			}
		}
	});

	async function load(name: string): Promise<void> {
		loading = true;

		try {
			const data = await api(`/instances/${encodeURIComponent(name)}/proxy`);
			const reg = data.registration;

			register = reg?.register ?? false;
			inTry = reg?.priority !== undefined && reg?.priority !== null;
			priority = inTry ? reg.priority : null;
			hostsText = (reg?.forcedHosts ?? []).join(', ');
			peers = data.peers ?? [];
		} catch (err) {
			Notify.error(t('web.proxyReg.loadFailed'), { detail: (err as Error).message });
			open = false;
		} finally {
			loading = false;
		}
	}

	function pick(name: string): void {
		target = name;

		void load(name);
	}

	/** The try list as it would read with this form's values in it. */
	const tryOrder = $derived.by(() => {
		const entries = peers
			.filter((peer) => peer.register && peer.priority !== null)
			.map((peer) => ({ name: peer.name, priority: peer.priority as number }));

		if (register && inTry && priority !== null) {
			entries.push({ name: target, priority });
		}

		entries.sort((a, b) => a.priority - b.priority);

		return entries.map((entry) => `${entry.name} (${entry.priority})`).join(' → ');
	});

	function toggleTry(on: boolean): void {
		inTry = on;

		if (on && priority === null) {
			// slot in after the current tail of the try list
			const taken = peers
				.filter((peer) => peer.register && peer.priority !== null)
				.map((peer) => peer.priority as number);

			priority = taken.length ? Math.max(...taken) + 1 : 0;
		}
	}

	async function save(): Promise<void> {
		busy = true;

		const note = Notify.loading(t('web.proxyReg.saving', { name: target }));

		try {
			const res = await put(`/instances/${encodeURIComponent(target)}/proxy`, {
				register,
				priority: inTry ? priority : null,
				forcedHosts: hostsText.split(/[\s,]+/).filter(Boolean),
				sync: syncNow,
				reload: syncNow && reloadNow
			});

			const outcome = res.changed.length
				? t('web.proxyReg.saved', { name: target, fields: res.changed.join(', ') })
				: t('web.proxyReg.noChanges', { name: target });
			const followUp = res.reloaded
				? t('web.proxyReg.savedReloaded')
				: res.synced
					? t('web.proxyReg.savedSynced')
					: syncNow
						? ''
						: t('web.proxyReg.syncPending');

			note.set({
				level: 'success',
				message: outcome,
				detail: followUp,
				closeable: true
			});

			open = false;
			oncommitted?.();
		} catch (err) {
			note.set({
				level: 'error',
				message: t('web.proxyReg.saveFailed', { name: target }),
				detail: (err as Error).message,
				closeable: true
			});
		}

		busy = false;
	}
</script>

<Modal
	title={target ? t('web.proxyReg.titleFor', { name: target }) : t('web.proxyReg.title')}
	bind:open
	dismissable={!busy}
>
	{#if !instance}
		<div class="field picker">
			<span class="lbl">{t('web.proxyReg.pickInstance')}</span>
			<span class="hint">{t('web.proxyReg.pickHint')}</span>
			<Select
				value={target}
				width="100%"
				searchable
				options={choices.map((choice) => ({
					value: choice.name,
					label:
						choice.name +
						(choice.register ? ` · ${t('web.proxyReg.registeredMark')}` : '') +
						(choice.external ? ` · ${t('web.proxyReg.externalMark')}` : '')
				}))}
				onchange={pick}
			/>
		</div>
	{/if}

	{#if target}
		<div class="fields" class:busy={loading}>
			<div class="field">
				<span class="lbl">{t('web.proxyReg.register')}</span>
				<span class="hint">{t('web.proxyReg.registerHint')}</span>
				<span class="toggleRow">
					<Toggle
						checked={register}
						disabled={loading}
						label={t('web.proxyReg.register')}
						onchange={(on) => (register = on)}
					/>
					<span class="dim">
						{register ? t('web.proxyReg.registeredWord') : t('web.proxyReg.notRegisteredWord')}
					</span>
				</span>
			</div>

			<div class="field">
				<span class="lbl">{t('web.proxyReg.inTry')}</span>
				<span class="hint">{t('web.proxyReg.inTryHint')}</span>
				<span class="toggleRow">
					<Toggle
						checked={inTry}
						disabled={loading || !register}
						label={t('web.proxyReg.inTry')}
						onchange={toggleTry}
					/>
					{#if inTry && register}
						<input
							class="input prio"
							type="number"
							min="0"
							max="9999"
							step="1"
							bind:value={priority}
							disabled={loading}
							aria-label={t('web.proxyReg.priority')}
						/>
						<span class="dim">{t('web.proxyReg.priorityHint')}</span>
					{/if}
				</span>
				{#if register && tryOrder}
					<span class="order dim">{t('web.proxyReg.currentOrder', { order: tryOrder })}</span>
				{/if}
			</div>

			<label class="field">
				<span class="lbl">{t('web.proxyReg.forcedHosts')}</span>
				<span class="hint">{t('web.proxyReg.forcedHostsHint')}</span>
				<input
					class="input mono"
					bind:value={hostsText}
					disabled={loading || !register}
					placeholder="play.example.com, event.example.com"
				/>
			</label>

			<div class="apply">
				<label class="applyOpt">
					<Checkbox
						checked={syncNow}
						label={t('web.proxyReg.syncNow')}
						onchange={(on) => (syncNow = on)}
					/>
					{t('web.proxyReg.syncNow')}
				</label>
				<label class="applyOpt" class:dim={!syncNow}>
					<Checkbox
						checked={reloadNow}
						disabled={!syncNow}
						label={t('web.proxyReg.reloadNow')}
						onchange={(on) => (reloadNow = on)}
					/>
					{t('web.proxyReg.reloadNow')}
				</label>
			</div>
		</div>
	{/if}

	{#snippet footer()}
		<Btn disabled={busy} onclick={() => (open = false)}>{t('web.common.cancel')}</Btn>
		<Btn
			variant="primary"
			loading={busy}
			disabled={!target || loading}
			onclick={() => void save()}
		>
			{t('web.proxyReg.save')}
		</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.fields {
		display: flex;
		flex-direction: column;
		gap: 1rem;

		// keep the previous values visible while a re-read is in flight, just dimmed
		&.busy {
			opacity: 0.6;
			pointer-events: none;
		}
	}

	.picker {
		margin-bottom: 1rem;
	}

	.toggleRow {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.prio {
		width: 6rem;
	}

	.order {
		margin-top: 0.375rem;
		font-size: 0.75rem;
	}

	.apply {
		display: flex;
		align-items: center;
		gap: 1.25rem;
		padding-top: 0.75rem;
		border-top: 0.1rem solid var(--border-divider);
		font-size: 0.875rem;
	}

	.applyOpt {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
	}
</style>
