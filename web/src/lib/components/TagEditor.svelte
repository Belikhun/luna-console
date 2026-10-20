<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { MAX_TAGS } from '$shared/iam/resources';
	import Btn from './Btn.svelte';
	import Icon from './Icon.svelte';
	import { tagAddFault, tagEntries, type TagMap } from './tageditor';

	/**
	 * A resource's tags as `key=value` chips, with a row to add one and a cross
	 * on each to take it away.
	 *
	 * The caller owns the data: `onadd`/`onremove` are called per change (the
	 * route takes one write at a time, and a failure then leaves the other tags
	 * as they were), or `onchange` receives the whole next map. Adding a key that
	 * already exists replaces its value, which is what "set a tag" means.
	 */

	let {
		tags,
		onchange,
		onadd,
		onremove,
		readonly = false,
		max = MAX_TAGS,
		busy = false
	}: {
		tags: TagMap;
		onchange?: (tags: TagMap) => void | Promise<void>;
		onadd?: (key: string, value: string) => void | Promise<void>;
		onremove?: (key: string) => void | Promise<void>;
		readonly?: boolean;
		max?: number;
		busy?: boolean;
	} = $props();

	let key = $state('');
	let value = $state('');
	let working = $state(false);
	let touched = $state(false);

	const entries = $derived(tagEntries(tags));
	const fault = $derived(tagAddFault(key.trim(), value.trim(), tags, max));
	const full = $derived(entries.length >= max);
	const disabled = $derived(readonly || busy || working);

	async function add(): Promise<void> {
		touched = true;

		if (fault || disabled) {
			return;
		}

		const nextKey = key.trim();
		const nextValue = value.trim();

		working = true;

		try {
			if (onadd) {
				await onadd(nextKey, nextValue);
			} else {
				await onchange?.({ ...tags, [nextKey]: nextValue });
			}

			key = '';
			value = '';
			touched = false;
		} finally {
			working = false;
		}
	}

	async function remove(target: string): Promise<void> {
		if (disabled) {
			return;
		}

		working = true;

		try {
			if (onremove) {
				await onremove(target);
			} else {
				const next = { ...tags };

				delete next[target];
				await onchange?.(next);
			}
		} finally {
			working = false;
		}
	}

	function onKeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter') {
			event.preventDefault();
			void add();
		}
	}
</script>

<div class="tageditor" class:readonly>
	<div class="chips">
		{#each entries as entry (entry.key)}
			<span class="chip mono" title="{entry.key}={entry.value}">
				<span class="k">{entry.key}</span>
				{#if entry.value !== ''}
					<span class="eq">=</span>
					<span class="v">{entry.value}</span>
				{/if}
				{#if !readonly}
					<button
						type="button"
						class="x"
						{disabled}
						title={t('web.tagEditor.remove', { key: entry.key })}
						aria-label={t('web.tagEditor.remove', { key: entry.key })}
						onclick={() => void remove(entry.key)}
					>
						<Icon name="close" size="0.625rem" style="solid" />
					</button>
				{/if}
			</span>
		{:else}
			<span class="dim empty">{t('web.tagEditor.none')}</span>
		{/each}
	</div>

	{#if !readonly}
		<div class="add">
			<input
				class="input mono"
				type="text"
				placeholder={t('web.tagEditor.keyPlaceholder')}
				bind:value={key}
				disabled={disabled || full}
				onkeydown={onKeydown}
				oninput={() => (touched = true)}
			/>
			<span class="eq dim">=</span>
			<input
				class="input mono"
				type="text"
				placeholder={t('web.tagEditor.valuePlaceholder')}
				bind:value
				disabled={disabled || full}
				onkeydown={onKeydown}
				oninput={() => (touched = true)}
			/>
			<Btn icon="plus" disabled={disabled || !!fault} loading={working} onclick={() => void add()}>
				{t('web.tagEditor.add')}
			</Btn>
		</div>

		{#if touched && fault && key !== ''}
			<span class="err">{t(fault, { max })}</span>
		{:else if full}
			<span class="hint dim">{t('web.tagEditor.full', { max })}</span>
		{/if}
	{/if}
</div>

<style lang="scss">
	.tageditor {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
		align-items: center;
	}

	// the same pill the token's tool list draws, with a key/value split inside
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.125rem;
		max-width: 100%;
		font-size: 0.75rem;
		border: 0.1rem solid var(--border-divider);
		border-radius: 0.75rem;
		padding: 0.125rem 0.5rem;
		line-height: 1.25rem;

		.k {
			@include ellipsis;

			color: var(--text-heading);
		}

		.v {
			@include ellipsis;

			color: var(--text-secondary);
		}

		.eq {
			color: var(--text-secondary);
		}
	}

	.x {
		@include bare-button;

		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1rem;
		height: 1rem;
		margin-left: 0.125rem;
		margin-right: -0.25rem;
		border-radius: 50%;
		color: var(--text-secondary);
		cursor: pointer;

		&:hover {
			color: var(--text-heading);
			background: var(--bg-hover);
		}

		&:disabled {
			cursor: default;
			opacity: 0.5;
		}
	}

	.empty {
		font-size: 0.8125rem;
	}

	.add {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;

		.input {
			flex: 1 1 8rem;
			min-width: 6rem;
			font-size: 0.8125rem;
		}

		.eq {
			flex: 0 0 auto;
		}
	}

	.err {
		font-size: 0.75rem;
		color: var(--error);
	}

	.hint {
		font-size: 0.75rem;
	}
</style>
