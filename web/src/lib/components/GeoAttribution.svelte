<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { tSplit } from '$lib/i18n.svelte';
	import { DBIP_ATTRIBUTION_URL } from '$shared/firewall';

	/**
	 * "IP geolocation by DB-IP", the credit DB-IP's licence (CC BY 4.0) asks for
	 * wherever its country data is shown or picked. The name and the address are
	 * literal; the words around them are the translation's.
	 */
	const parts = $derived(tSplit('web.firewall.countries.attribution', 'link'));
</script>

<span class="attribution">{parts.before}<a href={DBIP_ATTRIBUTION_URL} target="_blank" rel="noreferrer">DB-IP</a>{parts.after}</span>

<style lang="scss">
	.attribution {
		color: var(--text-secondary);
		font-size: 0.75rem;

		// it leaves the console, so it reads as navigation
		a {
			color: var(--link);
			text-decoration: underline;
		}
	}
</style>
