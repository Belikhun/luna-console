<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import Select from './Select.svelte';
	import { RELEASE_CHANNELS, type ReleaseChannel } from '$core/channels';

	/**
	 * How unstable a release an addon will accept from its provider.
	 *
	 * One component for all four kinds. Plugins, mods, resource packs and data
	 * packs each carry the same three-value field and each had its own idea of
	 * how to render it; the resource pack screen was the only one that rendered
	 * it at all, with the three strings written out by hand.
	 *
	 * The wording matters more than the control: a channel is a **ceiling**, not
	 * a selector. Picking "alpha" does not ask for an alpha build, it says alphas
	 * are acceptable and the newest of anything wins. The hint says so, because
	 * every operator's first guess is the other reading.
	 */
	let {
		value = $bindable('release'),
		disabled = false,
		width = '10rem',
		/** shown instead of the standard hint, for a screen with more to say */
		hint,
		/**
		 * Render the control on its own, for a host that already names it. An info
		 * grid cell carries the label in its header and the hint behind its help
		 * icon, so the field's own two lines would say both a second time.
		 */
		bare = false,
		onchange
	}: {
		value?: ReleaseChannel;
		disabled?: boolean;
		width?: string;
		hint?: string;
		bare?: boolean;
		onchange?: (value: ReleaseChannel) => void;
	} = $props();

	const CHANNEL_LABEL: Record<ReleaseChannel, string> = {
		release: 'web.channel.release',
		beta: 'web.channel.beta',
		alpha: 'web.channel.alpha'
	};

	const options = $derived(
		RELEASE_CHANNELS.map((channel) => ({ value: channel, label: t(CHANNEL_LABEL[channel]) }))
	);
</script>

{#snippet control()}
	<Select
		{value}
		{width}
		{disabled}
		{options}
		onchange={(picked) => {
			value = picked as ReleaseChannel;
			onchange?.(value);
		}}
	/>
{/snippet}

{#if bare}
	{@render control()}
{:else}
	<div class="field">
		<span class="lbl">{t('web.channel.label')}</span>
		<span class="hint">{hint ?? t('web.channel.hint')}</span>
		{@render control()}
	</div>
{/if}
