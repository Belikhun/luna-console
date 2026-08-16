<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { t } from '$lib/i18n.svelte';
	import Icon from './Icon.svelte';

	/**
	 * File picker with drag & drop: click to browse, or drop a file onto the
	 * zone. Holds exactly one file; a second pick replaces the first.
	 */
	let {
		file = $bindable(null),
		accept = '',
		hint = t('web.common.dropFile'),
		disabled = false,
		progress = null,
		status
	}: {
		file?: File | null;
		/** input `accept` filter, e.g. ".zip"; also applied to dropped files */
		accept?: string;
		hint?: string;
		/** blocks the click and the drop; an upload in flight must not be replaced */
		disabled?: boolean;
		/** 0..1 draws a determinate bar along the bottom edge; null draws none */
		progress?: number | null;
		/** replaces the dim hint line, for a caller with more to say than a name */
		status?: Snippet;
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

		if (disabled) {
			return;
		}

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
	class:busy={progress !== null}
	{disabled}
	onclick={() => input?.click()}
	ondragover={(event) => {
		event.preventDefault();

		if (!disabled) {
			over = true;
		}
	}}
	ondragleave={() => (over = false)}
	ondrop={onDrop}
>
	{#if file}
		<Icon name="fileCheck" />
		<span class="name">{file.name}</span>
		{#if status}
			{@render status()}
		{:else}
			<span class="dim">{fmtSize(file.size)}</span>
			<span class="dim swap">{t('web.common.clickToSwap')}</span>
		{/if}
	{:else}
		<Icon name="fileArrowUp" style="light" />
		{#if status}
			{@render status()}
		{:else}
			<span class="dim">{hint}</span>
		{/if}
	{/if}

	{#if progress !== null}
		<span class="progress" style:--pct="{Math.round(Math.min(1, Math.max(0, progress)) * 100)}%"></span>
	{/if}
</button>

<input class="hidden" type="file" {accept} bind:this={input} onchange={onChange} />

<style lang="scss">
	.drop {
		@include bare-button;

		position: relative;

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

		// an upload in flight: the zone stops being a control and becomes a
		// readout, so it loses the pointer without losing its legibility
		&:disabled {
			cursor: default;
			opacity: 1;

			&:hover {
				border-color: var(--border-input);
			}
		}

		&.busy {
			border-style: solid;
			overflow: hidden;
		}

		:global(icon) {
			font-size: 1.5rem;
		}
	}

	// a hairline along the bottom edge rather than a bar in the flow: the zone's
	// height must not change as an upload starts, or the whole form shifts
	.progress {
		position: absolute;
		left: 0;
		bottom: 0;
		width: var(--pct);
		height: 0.25rem;
		background: var(--primary);
		transition: width 0.2s;
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
