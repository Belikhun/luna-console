<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import Modal from './Modal.svelte';
	import Btn from './Btn.svelte';
	import MultiSelect from './MultiSelect.svelte';

	/**
	 * The "Add …" popup used wherever things are added to a set (plugins to a
	 * group, plugins to an instance, a plugin to instances): one button opens a
	 * modal with a multi-value select, confirm hands back the whole selection.
	 */
	let {
		open = $bindable(false),
		title,
		description,
		selectLabel,
		options,
		confirmLabel = t('web.common.add'),
		busy = false,
		onconfirm
	}: {
		open?: boolean;
		title: string;
		description?: string;
		/** caption notched into the select's border */
		selectLabel: string;
		options: string[];
		confirmLabel?: string;
		busy?: boolean;
		onconfirm: (selected: string[]) => void;
	} = $props();

	let selected: string[] = $state([]);

	// a fresh popup starts with an empty selection
	$effect(() => {
		if (open) {
			selected = [];
		}
	});

	function confirm(): void {
		onconfirm(selected);
		open = false;
	}
</script>

<Modal {title} bind:open>
	{#if description}
		<p class="dim intro">{description}</p>
	{/if}
	<MultiSelect
		label={selectLabel}
		bind:value={selected}
		width="100%"
		options={options.map((option) => ({ value: option, label: option }))}
	/>
	{#snippet footer()}
		<Btn onclick={() => (open = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="primary" loading={busy} disabled={!selected.length} onclick={confirm}>
			{confirmLabel}{selected.length ? ` (${selected.length})` : ''}
		</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.intro {
		margin: 0 0 0.75rem;
		font-size: 0.8125rem;
	}
</style>
