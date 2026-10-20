<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '$lib/i18n.svelte';
	import { api } from '$lib/api';
	import Spinner from './Spinner.svelte';

	/**
	 * A policy's YAML, read-only and light: what an unfolded table row shows.
	 * Monaco would be one editor per open row; a document is short enough that
	 * plain monospaced text reads as well. Given only a `name`, it fetches the
	 * policy when it is first shown.
	 */
	let {
		yaml,
		name
	}: {
		/** the text, when the caller has it */
		yaml?: string;
		/** a managed or built-in policy to fetch when `yaml` is absent */
		name?: string;
	} = $props();

	let fetched = $state<string | null>(null);
	let failed = $state('');

	onMount(async () => {
		if (yaml !== undefined || !name) {
			return;
		}

		try {
			const data = await api<{ policy: { yaml: string } }>(`/iam/policies/${encodeURIComponent(name)}`);

			fetched = data.policy.yaml;
		} catch (err) {
			failed = (err as Error).message;
		}
	});

	const text = $derived(yaml ?? fetched);
</script>

{#if text !== null}
	<pre class="mono yaml">{text}</pre>
{:else if failed}
	<p class="failed">{t('web.policyPreview.failed', { detail: failed })}</p>
{:else}
	<p class="dim loading"><Spinner /> {t('web.common.loading')}</p>
{/if}

<style lang="scss">
	.yaml {
		margin: 0;
		max-height: 20rem;
		overflow: auto;
		padding: 0.75rem 1rem;
		border: 0.1rem solid var(--border-divider);
		border-radius: var(--radius-input);
		background: var(--bg-panel);
		font-size: 0.8125rem;
		line-height: 1.25rem;
		white-space: pre;
	}

	.failed {
		margin: 0;
		color: var(--error);
		font-size: 0.8125rem;
	}

	.loading {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0;
		font-size: 0.8125rem;
	}
</style>
