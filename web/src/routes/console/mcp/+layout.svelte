<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { t } from '$lib/i18n.svelte';
	import { clearCrumbLabel, setCrumbLabel } from '$lib/crumbs.svelte';

	// the slug title-cases to "Mcp", which is not the screen's name in any locale
	let { children }: { children: Snippet } = $props();

	$effect(() => {
		setCrumbLabel('/console/mcp', t('web.nav.mcp'));

		return () => clearCrumbLabel('/console/mcp');
	});
</script>

{@render children()}
