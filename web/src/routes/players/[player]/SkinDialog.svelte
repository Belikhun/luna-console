<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { fileToBase64, post } from '$lib/api';
	import { Notify } from '$lib/notifications.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import FileDrop from '$lib/components/FileDrop.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import Select from '$lib/components/Select.svelte';

	/**
	 * Change a player's skin: an uploaded file, an image address, another Mojang
	 * account's skin, or back to their own.
	 */
	let {
		player,
		username,
		online,
		onchanged
	}: {
		/** The uuid or name the profile was opened with */
		player: string;
		username: string;
		/** A connected player gets the new skin at once; anyone else on their next login */
		online: boolean;
		/** The skin changed; the screen redraws it and re-reads the moderation log */
		onchanged: () => void | Promise<void>;
	} = $props();

	let open = $state(false);
	let mode = $state('upload');
	let file: File | null = $state(null);
	let url = $state('');
	let name = $state('');
	let variant = $state('');
	let busy = $state(false);

	/** Open the dialog on a clean form; the header's Actions menu calls this. */
	export function show(): void {
		mode = 'upload';
		file = null;
		url = '';
		name = '';
		variant = '';
		open = true;
	}

	const valid = $derived.by(() => {
		if (mode === 'upload') {
			return file !== null;
		}

		if (mode === 'url') {
			return /^https?:\/\/.+/.test(url.trim());
		}

		if (mode === 'name') {
			return /^[A-Za-z0-9_]{1,16}$/.test(name.trim());
		}

		return true;
	});

	async function apply(): Promise<void> {
		busy = true;

		const note = Notify.loading(
			mode === 'reset'
				? t('web.playerDetail.resettingSkin', { name: username })
				: t('web.playerDetail.changingSkin', { name: username })
		);

		try {
			const body: Record<string, unknown> = { mode };

			if (mode === 'upload' && file) {
				body.fileBase64 = await fileToBase64(file);
			} else if (mode === 'url') {
				body.url = url.trim();
			} else if (mode === 'name') {
				body.skin = name.trim();
			}

			if (variant && (mode === 'upload' || mode === 'url')) {
				body.variant = variant;
			}

			const result = await post(`/players/${encodeURIComponent(player)}/skin`, body);

			if (result.ok === false) {
				throw new Error(result.error ?? '');
			}

			open = false;

			const message = mode === 'reset'
				? t('web.playerDetail.skinReset', { name: username })
				: online
					? t('web.playerDetail.skinChangedLive', { name: username })
					: t('web.playerDetail.skinChangedNextLogin', { name: username });

			note.set({ level: 'success', message, closeable: true });

			await onchanged();
		} catch (err) {
			note.set({
				level: 'error',
				message: t('web.playerDetail.skinChangeFailed'),
				detail: (err as Error).message,
				closeable: true
			});
		}

		busy = false;
	}
</script>

<Modal title={t('web.playerDetail.skinTitle', { name: username })} bind:open>
	<div class="field">
		<span class="lbl">{t('web.playerDetail.source')}</span>
		<Select
			bind:value={mode}
			width="100%"
			options={[
				{ value: 'upload', label: t('web.playerDetail.uploadASkinFilePng') },
				{ value: 'url', label: t('web.playerDetail.imageUrl') },
				{ value: 'name', label: t('web.playerDetail.mirrorAMojangAccount') },
				{ value: 'reset', label: t('web.playerDetail.resetBackToTheirOwn') }
			]}
		/>
	</div>

	{#if mode === 'upload'}
		<div class="field">
			<span class="lbl">{t('web.playerDetail.skinFile')}</span>
			<span class="hint">
				{t('web.playerDetail.a6464Or')}
			</span>
			<FileDrop bind:file accept=".png" hint={t('web.playerDetail.dropASkinPngHere')} />
		</div>
	{:else if mode === 'url'}
		<label class="field">
			<span class="lbl">{t('web.playerDetail.imageUrl')}</span>
			<span class="hint">{t('web.playerDetail.mustBePubliclyReachable')}</span>
			<input class="input mono" bind:value={url} placeholder={t('web.playerDetail.httpsSkinPng')} />
		</label>
	{:else if mode === 'name'}
		<label class="field">
			<span class="lbl">{t('web.playerDetail.mojangAccount')}</span>
			<span class="hint">{t('web.playerDetail.thePlayerGetsThis')}</span>
			<input class="input" bind:value={name} placeholder={t('web.playerDetail.eGNotch')} />
		</label>
	{:else}
		<p>
			{t('web.playerDetail.skinsrestorerForgetsTheStored')}
		</p>
	{/if}

	{#if mode === 'upload' || mode === 'url'}
		<div class="field">
			<span class="lbl">{t('web.playerDetail.armModel')}</span>
			<Select
				bind:value={variant}
				width="100%"
				options={[
					{ value: '', label: t('web.playerDetail.detectAutomatically') },
					{ value: 'classic', label: t('web.playerDetail.classic4PxArms') },
					{ value: 'slim', label: t('web.playerDetail.slim3PxArms') }
				]}
			/>
		</div>
	{/if}

	{#snippet footer()}
		<Btn onclick={() => (open = false)}>{t('web.playerDetail.cancel')}</Btn>
		<Btn
			variant={mode === 'reset' ? 'danger' : 'primary'}
			disabled={!valid || busy}
			loading={busy}
			onclick={apply}
		>
			{mode === 'reset' ? t('web.playerDetail.resetSkin') : t('web.playerDetail.applySkin')}
		</Btn>
	{/snippet}
</Modal>
