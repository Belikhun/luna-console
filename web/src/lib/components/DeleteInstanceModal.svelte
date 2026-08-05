<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { deleteInstanceJob } from '$lib/instancejobs';
	import Modal from './Modal.svelte';
	import Btn from './Btn.svelte';
	import Checkbox from './Checkbox.svelte';

	/**
	 * Delete confirmation for one instance, modelled on the AWS confirm pattern:
	 * lead question, consequence notes, then a divided type-to-confirm section.
	 *
	 * It lives in the component library because both places that can delete an
	 * instance (the instances table and the instance detail page) must offer
	 * the same dialog without either one navigating to the other.
	 */
	let {
		open = $bindable(false),
		name,
		ondeleted
	}: {
		open?: boolean;
		/** the instance to delete; the dialog does nothing without one */
		name: string;
		/** fired once the job is handed to its flash card, for a redirect or a refresh */
		ondeleted?: (name: string) => void;
	} = $props();

	let confirmText = $state('');
	let purge = $state(false);

	const confirmed = $derived(confirmText.trim().toLowerCase() === 'delete');

	// a reopened dialog never inherits the previous attempt's confirmation
	$effect(() => {
		if (open) {
			confirmText = '';
			purge = false;
		}
	});

	function submit(): void {
		if (!name || !confirmed) {
			return;
		}

		open = false;

		// the flash card follows the job from here; the row reads "deleting"
		// until it (and a purge's directory walk) finishes
		void deleteInstanceJob(name, purge);

		ondeleted?.(name);
	}
</script>

<Modal title={t('web.deleteInstance.title', { name })} bind:open>
	<p class="del-lead">
		{t('web.deleteInstance.leadBefore')} <b>{name}</b>{t('web.deleteInstance.leadAfter')}
	</p>
	<p class="del-note">{t('web.deleteInstance.noteDeregister')}</p>
	<p class="del-note">{t('web.deleteInstance.noteDirectory')}</p>
	<label class="purgerow">
		<Checkbox
			checked={purge}
			label={t('web.deleteInstance.purgeLabel')}
			onchange={(value) => (purge = value)}
		/>
		{t('web.deleteInstance.purgeText')}
	</label>
	<div class="del-confirm">
		<span class="del-ask">{t('web.deleteInstance.confirmAsk')}</span>
		<input class="input" bind:value={confirmText} placeholder="delete" />
	</div>
	{#snippet footer()}
		<Btn onclick={() => (open = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="danger" disabled={!confirmed} onclick={submit}>{t('web.common.delete')}</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.purgerow {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		margin: 0.75rem 0 1rem;
	}

	.del-lead {
		margin: 0 0 0.75rem;
	}

	.del-note {
		margin: 0 0 0.75rem;
		color: var(--text-secondary);
		font-size: 0.875rem;
	}

	.del-confirm {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		border-top: 0.1rem solid var(--border-divider);
		// stretch to the modal body's edges so the divider runs full width
		margin: 1rem -1.25rem 0;
		padding: 1rem 1.25rem 0.25rem;
	}

	.del-ask {
		font-weight: 700;
		color: var(--text-heading);
	}
</style>
