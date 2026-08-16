<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { api, post } from '$lib/api';
	import { formatBytes, formatRate, uploadFile } from '$lib/upload';
	import Btn from './Btn.svelte';
	import FileDrop from './FileDrop.svelte';
	import Flash from './Flash.svelte';
	import Spinner from './Spinner.svelte';
	import WorldWizardModal from './WorldWizardModal.svelte';
	import type { StagedWorld, StagedWorldScan } from './worldupload';

	/**
	 * The world-zip input, wherever a world is asked for.
	 *
	 * One component so the flow is identical at every site: pick or drop a file,
	 * watch it upload in the zone itself, then a popup walks through what was
	 * found in it and what will happen to it, and only after that is the value
	 * something a parent may submit.
	 *
	 * Its bound value is a staged world rather than a `File` - a handle to bytes
	 * the daemon already holds and has already read. A parent therefore cannot
	 * submit something the server has not accepted, which is the point of
	 * staging rather than posting the file with the form.
	 *
	 * `popup={false}` keeps the upload half and drops the wizard: the caller is
	 * itself a wizard and renders this as its own first step, so a second dialog
	 * on top of it would be one modal too many. The phases the operator goes
	 * through are the same either way, which is what "one flow" has to mean.
	 */
	let {
		value = $bindable(null),
		instance = '',
		software = '',
		mcVersion = '',
		level = '',
		accept = '.zip',
		hint = t('web.worldUpload.hint'),
		disabled = false,
		disabledReason = '',
		popup = true,
		confirmLabel = t('web.worldUpload.useThisWorld'),
		onconfirm,
		onscanned,
		ondiscard
	}: {
		value?: StagedWorld | null;
		/** The instance the archive is validated against; layouts differ per software */
		instance?: string;
		/**
		 * The target as a specification, when there is no instance to name yet.
		 *
		 * The launch wizard validates a world against the software and version
		 * the operator has just chosen, before anything has been provisioned.
		 */
		software?: string;
		mcVersion?: string;
		level?: string;
		accept?: string;
		hint?: string;
		/** The whole input is unavailable, e.g. the instance is running */
		disabled?: boolean;
		/** Why. A disabled control says what would make it available. */
		disabledReason?: string;
		/** Own the validation wizard, or leave it to a caller that is already one */
		popup?: boolean;
		/** The wizard's final button; "Use this world" or "Replace world" */
		confirmLabel?: string;
		/** Fired once the operator has confirmed; the parent may now submit */
		onconfirm?: (staged: StagedWorld) => void;
		/** Fired when the scan lands, whoever is showing it */
		onscanned?: (staged: StagedWorld) => void;
		ondiscard?: () => void;
	} = $props();

	let picked: File | null = $state(null);
	let wizardOpen = $state(false);
	let aborter: AbortController | undefined;

	/**
	 * The file the upload effect has already acted on.
	 *
	 * Without it, a parent clearing `value` after a successful submit looks
	 * exactly like a fresh pick - the zone still holds the `File` - and the whole
	 * upload starts again behind the operator's back.
	 */
	let handled: File | null = null;

	/** True between a pick and the value landing, when `value` is legitimately null. */
	let starting = $state(false);

	const busy = $derived(value?.phase === 'uploading' || value?.phase === 'scanning');

	/** The line under the file name while something is happening to it. */
	const statusLine = $derived.by(() => {
		if (!value) {
			return '';
		}

		if (value.phase === 'uploading') {
			const rate = formatRate(value.rate);

			return t('web.worldUpload.uploading', {
				done: formatBytes(value.uploadedBytes),
				total: formatBytes(value.fileSizeBytes),
				rate: rate ? ` · ${rate}` : ''
			});
		}

		if (value.phase === 'scanning') {
			return t('web.worldUpload.scanning');
		}

		if (value.phase === 'confirmed' && value.scan) {
			return t('web.worldUpload.ready', {
				level: value.level,
				version: value.scan.level_dat?.mcVersion ?? t('web.worldWizard.unknown')
			});
		}

		return '';
	});

	/** Start over: throw away whatever is staged and forget the pick. */
	async function discard(): Promise<void> {
		aborter?.abort();
		aborter = undefined;

		const token = value?.token;

		value = null;
		picked = null;
		handled = null;
		wizardOpen = false;

		if (token) {
			await api(`/worlds/stage/${token}`, { method: 'DELETE' }).catch(() => undefined);
		}

		ondiscard?.();
	}

	/** Upload the picked file, then read it, then hand over to the wizard. */
	async function begin(file: File): Promise<void> {
		starting = true;

		const started = await post('/worlds/stage', {
			fileName: file.name,
			sizeBytes: file.size
		}).catch((err: Error) => {
			value = errorState(file, err.message);

			return undefined;
		});

		if (!started?.stage) {
			return;
		}

		const token = String(started.stage.token);

		aborter = new AbortController();
		starting = false;

		value = {
			token,
			phase: 'uploading',
			fileName: file.name,
			fileSizeBytes: file.size,
			uploadedBytes: 0,
			progress: 0,
			rate: 0,
			scan: null,
			level: '',
			error: null
		};

		try {
			await uploadFile(`/worlds/stage/${token}`, file, {
				signal: aborter.signal,
				onprogress: (progress) => {
					if (!value || value.token !== token) {
						return;
					}

					value.uploadedBytes = progress.loaded;
					value.progress = progress.fraction;
					value.rate = progress.rate;
				}
			});
		} catch (err) {
			value = errorState(file, (err as Error).message, token);

			return;
		}

		if (!value || value.token !== token) {
			return;
		}

		value.phase = 'scanning';
		value.progress = null;

		try {
			const query = software
				? `software=${encodeURIComponent(software)}&mcVersion=${encodeURIComponent(mcVersion)}&level=${encodeURIComponent(level)}`
				: `instance=${encodeURIComponent(instance)}`;

			const answer = await api(`/worlds/stage/${token}?${query}`);
			const scan = answer.scan as StagedWorldScan;

			if (!value || value.token !== token) {
				return;
			}

			value.scan = scan;
			value.level = scan.plan.targetLevel;
			value.phase = 'reviewing';
			wizardOpen = popup;

			onscanned?.(value);
		} catch (err) {
			value = errorState(file, (err as Error).message, token);
		}
	}

	function errorState(file: File, message: string, token = ''): StagedWorld {
		return {
			token,
			phase: 'error',
			fileName: file.name,
			fileSizeBytes: file.size,
			uploadedBytes: 0,
			progress: null,
			rate: 0,
			scan: null,
			level: '',
			error: message
		};
	}

	/** The operator has read the wizard and accepted what it said. */
	function confirm(): void {
		if (!value) {
			return;
		}

		value.phase = 'confirmed';
		wizardOpen = false;

		onconfirm?.(value);
	}

	// a pick is the trigger; binding to FileDrop keeps the zone's own affordances
	// (click, drop, the accept filter) without this component reimplementing them
	$effect(() => {
		const file = picked;

		if (!file || file === handled) {
			return;
		}

		handled = file;

		void begin(file);
	});

	// The parent clears the value once it has submitted; the zone has to follow,
	// or it keeps showing a file name for an upload that has already been used
	// and consumed. Guarded on `starting` because `value` is also null for the
	// moment between a pick and the staging call answering.
	$effect(() => {
		if (value === null && handled !== null && !starting) {
			picked = null;
			handled = null;
		}
	});
</script>

<FileDrop
	bind:file={picked}
	{accept}
	{hint}
	disabled={disabled || busy}
	progress={value?.phase === 'uploading' ? value.progress : null}
>
	{#snippet status()}
		{#if statusLine}
			<span class="dim">{statusLine}</span>
		{:else if value?.phase === 'error'}
			<span class="dim">{t('web.worldUpload.failed')}</span>
		{:else}
			<span class="dim">{hint}</span>
		{/if}
	{/snippet}
</FileDrop>

{#if disabled && disabledReason}
	<p class="dim reason">{disabledReason}</p>
{/if}

{#if value?.phase === 'error' && value.error}
	<div class="row">
		<Flash kind="error">{value.error}</Flash>
	</div>
{/if}

{#if value}
	<div class="row actions">
		{#if value.phase === 'scanning'}
			<Spinner size="1rem" />
		{/if}

		{#if popup && (value.phase === 'reviewing' || value.phase === 'confirmed')}
			<Btn icon="magnifyingGlass" onclick={() => (wizardOpen = true)}>
				{t('web.worldUpload.review')}
			</Btn>
		{/if}

		<Btn
			icon={busy ? 'close' : 'trash'}
			variant={busy ? 'normal' : 'danger'}
			onclick={() => void discard()}
		>
			{busy ? t('web.common.cancel') : t('web.worldUpload.remove')}
		</Btn>
	</div>
{/if}

{#if popup && value && (value.phase === 'reviewing' || value.phase === 'confirmed')}
	<WorldWizardModal
		bind:open={wizardOpen}
		bind:world={value}
		{confirmLabel}
		onconfirm={confirm}
		oncancel={() => (wizardOpen = false)}
	/>
{/if}

<style lang="scss">
	.row {
		margin-top: 0.75rem;
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.reason {
		margin: 0.5rem 0 0;
		font-size: 0.8125rem;
	}
</style>
