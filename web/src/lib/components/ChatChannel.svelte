<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { CHAT_CHANNEL_ICON, CHAT_CHANNEL_LABEL, chatChannelOf } from '$lib/chatchannel';
	import Icon from './Icon.svelte';
	import InfoPopover from './InfoPopover.svelte';
	import PlayerName from './PlayerName.svelte';

	/**
	 * A chat channel as it reads everywhere: a player's current one, or the one a
	 * logged line was sent in. A direct channel names the other player when the
	 * reader was given it.
	 *
	 * A channel nobody recorded is never drawn as the network one: `missing`
	 * decides between "Unknown" (a chat line from before channels were recorded,
	 * a proxy that cannot say) and the no-value dash (a command, which has none).
	 */
	let {
		type,
		targetName,
		targetUuid,
		isolated = false,
		missing = 'unknown'
	}: {
		/** network, server or direct; anything else is a channel nobody recorded */
		type?: string | null;
		/** The other side of a direct channel */
		targetName?: string | null;
		targetUuid?: string | null;
		/** The player's server keeps chat to itself, which narrows the network channel */
		isolated?: boolean;
		missing?: 'unknown' | 'none';
	} = $props();

	const channel = $derived(chatChannelOf(type));
</script>

{#if channel}
	<span class="channel">
		<Icon name={CHAT_CHANNEL_ICON[channel]} size="1rem" />
		{#if channel === 'network' && isolated}
			<InfoPopover detail={t('web.chatChannel.isolatedHint')}>{t(CHAT_CHANNEL_LABEL[channel])}</InfoPopover>
		{:else}
			{t(CHAT_CHANNEL_LABEL[channel])}
		{/if}
		{#if channel === 'direct' && targetName}
			<Icon name="right" size="0.75rem" />
			<PlayerName player={targetUuid || targetName} name={targetName} />
		{/if}
	</span>
{:else if missing === 'none'}
	<span class="dim">–</span>
{:else}
	<span class="dim">{t('web.chatChannel.unknown')}</span>
{/if}

<style lang="scss">
	.channel {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		white-space: nowrap;
	}
</style>
