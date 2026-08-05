<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import Icon from './Icon.svelte';

	/**
	 * File picker with drag & drop: click to browse, or drop a file onto the
	 * zone. Holds exactly one file; a second pick replaces the first.
	 */
	let {
		file = $bindable(null),
		accept = '',
		hint = t('web.common.dropFile')
	}: {
		file?: File | null;
		/** input `accept` filter, e.g. ".zip"; also applied to dropped files */
		accept?: string;
		hint?: string;
	} = $props();

	let input: HTMLInputElement | undefined = $state();
	let over = $state(false);

	/** Whether a dropped file passes the accept filter (extension terms only). */
	function accepts(candidate: File): boolean {
		if (!accept) {
			return true;
		}

		const name = candidate.name.toLowerCase();

		return accept
			.split(',')
			.map((term) => term.trim().toLowerCase())
			.some((term) => term.startsWith('.') && name.endsWith(term));
	}

	function onDrop(event: DragEvent): void {
		event.preventDefault();
		over = false;

		const dropped = event.dataTransfer?.files?.[0];

		if (dropped && accepts(dropped)) {
			file = dropped;
		}
	}

	function onChange(event: Event): void {
		file = (event.currentTarget as HTMLInputElement).files?.[0] ?? null;
	}

	function fmtSize(bytes: number): string {
		if (bytes >= 1024 * 1024) {
			return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
		}

		return `${Math.max(1, Math.round(bytes / 1024))} KB`;
	}
</script>

<button
	type="button"
	class="drop"
	class:over
	class:filled={!!file}
	onclick={() => input?.click()}
	ondragover={(event) => {
		event.preventDefault();
		over = true;
	}}
	ondragleave={() => (over = false)}
	ondrop={onDrop}
>
	{#if file}
		<Icon name="fileCheck" />
		<span class="name">{file.name}</span>
		<span class="dim">{fmtSize(file.size)}</span>
		<span class="dim swap">click to swap</span>
	{:else}
		<Icon name="fileArrowUp" style="light" />
		<span class="dim">{hint}</span>
	{/if}
</button>

<input class="hidden" type="file" {accept} bind:this={input} onchange={onChange} />

<style lang="scss">
	.drop {
		@include bare-button;

		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		width: 100%;
		min-height: 7.5rem;
		padding: 1.25rem;
		border: 0.1rem dashed var(--border-input);
		border-radius: var(--radius-input);
		background: var(--bg-input);
		color: var(--text);
		cursor: pointer;
		transition:
			border-color 0.15s,
			background 0.15s;

		&:hover {
			border-color: var(--primary);
		}

		&:focus-visible {
			@include focus-ring;
		}

		// the drop target announces itself the moment a file is dragged over it
		&.over {
			border-color: var(--primary);
			border-style: solid;
			background: var(--bg-hover);
		}

		&.filled {
			border-style: solid;
		}

		:global(icon) {
			font-size: 1.5rem;
		}
	}

	.name {
		font-weight: 700;
		word-break: break-all;
	}

	.swap {
		font-size: 0.75rem;
	}

	.hidden {
		display: none;
	}
</style>
