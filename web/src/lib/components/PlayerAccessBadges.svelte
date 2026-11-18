<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import type { AccessFlags } from '$lib/players';
	import StatusBadge from './StatusBadge.svelte';

	/**
	 * Where a player stands on one server's access lists, as badges: banned,
	 * operator, and missing from a whitelist that is switched on. Being on the
	 * whitelist is the normal case on a whitelisted server and says nothing on an
	 * open one, so it is the absence that gets a badge.
	 */
	let {
		flags,
		whitelistEnabled = false,
		dash = false
	}: {
		flags: AccessFlags | null;
		whitelistEnabled?: boolean;
		/** Draw the "no value" dash when there is nothing to say, as a table cell wants */
		dash?: boolean;
	} = $props();

	const unlisted = $derived(!!flags && whitelistEnabled && !flags.whitelisted);
	const nothing = $derived(!flags || (!flags.banned && !flags.operator && !unlisted));
</script>

{#if nothing}
	{#if dash}
		<span class="dim">–</span>
	{/if}
{:else if flags}
	<span class="badges">
		{#if flags.banned}
			<StatusBadge state="failed" label={t('web.playerActions.banned')} />
		{/if}
		{#if flags.operator}
			<StatusBadge state="info" label={t('web.playerActions.operator')} />
		{/if}
		{#if unlisted}
			<StatusBadge
				state="warning"
				label={t('web.playerActions.unlisted')}
				detail={t('web.playerActions.unlistedDetail')}
			/>
		{/if}
	</span>
{/if}

<style lang="scss">
	.badges {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.75rem;
	}
</style>
