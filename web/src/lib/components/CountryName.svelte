<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { regionName } from '$lib/countries';
	import { currentLanguage, t } from '$lib/i18n.svelte';

	/**
	 * A country as every table writes it: its code in the mono face, then its
	 * name in the console's language. No flag: Windows draws flag emoji as
	 * letters. A null code is the bucket no country was found for, said as
	 * such; `empty` shows a dash there, for a cell that simply has none.
	 */
	let {
		code,
		empty = false
	}: {
		/** ISO 3166-1 alpha-2, or null when no country was found */
		code: string | null | undefined;
		/** Show `–` for a missing country, where "Unknown" would read as a finding */
		empty?: boolean;
	} = $props();
</script>

{#if code}
	<span class="country"><span class="mono">{code}</span> {regionName(code, currentLanguage())}</span>
{:else if empty}
	<span class="dim">–</span>
{:else}
	<span class="country dim">{t('web.countries.unknown')}</span>
{/if}

<style lang="scss">
	.country {
		@include ellipsis;

		display: inline-block;
		max-width: 100%;
		vertical-align: bottom;
	}
</style>
