<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { tick } from 'svelte';

	import { COUNTRY_CODES } from '$lib/countries';
	import { countryName } from '$lib/firewall';
	import { currentLanguage, t } from '$lib/i18n.svelte';
	import { score } from '$lib/search/match';

	import Checkbox from './Checkbox.svelte';
	import GeoAttribution from './GeoAttribution.svelte';
	import Icon from './Icon.svelte';
	import SearchInput from './SearchInput.svelte';

	/**
	 * Pick any number of countries: a search over their names (in the console's
	 * language and in English) and codes, the picked ones as chips, and the
	 * whole list to tick from. The list is one tab stop; arrows move through it
	 * and Space or Enter ticks a row.
	 */
	let {
		value = $bindable([]),
		label,
		disabled = false,
		invalid = false,
		onchange
	}: {
		/** Upper-case ISO 3166-1 alpha-2 codes */
		value: string[];
		/** What is being picked, for screen readers */
		label: string;
		disabled?: boolean;
		/** Draw the error ring: a picked country is what a refusal is about */
		invalid?: boolean;
		onchange?: (value: string[]) => void;
	} = $props();

	interface Country {
		code: string;
		name: string;
		/** The name, the English name and the code, for the search */
		text: string;
	}

	const listId = $props.id();

	let query = $state('');
	let active = $state(0);
	let root = $state<HTMLDivElement>();
	let list = $state<HTMLDivElement>();

	const countries = $derived.by((): Country[] => {
		const language = currentLanguage();
		const collator = new Intl.Collator(language);

		return COUNTRY_CODES
			.map((code) => {
				const name = countryName(code, language);

				return { code, name, text: `${code} ${name} ${countryName(code, 'en')}` };
			})
			.sort((left, right) => collator.compare(left.name, right.name));
	});

	const shown = $derived.by((): Country[] => {
		const wanted = query.trim();

		if (wanted === '') {
			return countries;
		}

		return countries
			.map((country) => ({ country, rank: score(country.text, wanted) }))
			.filter((entry) => entry.rank > 0)
			.sort((left, right) => right.rank - left.rank)
			.map((entry) => entry.country);
	});

	const picked = $derived(value.map((code) => ({ code, name: countryName(code) })));

	// a new search starts at its best match
	$effect(() => {
		void query;
		active = 0;
	});

	function commit(next: string[]): void {
		value = next;
		onchange?.(next);
	}

	function toggle(code: string): void {
		if (disabled) {
			return;
		}

		commit(value.includes(code)
			? value.filter((entry) => entry !== code)
			: [...value, code]);
	}

	function searchField(): HTMLInputElement | null {
		return root?.querySelector<HTMLInputElement>('.find input') ?? null;
	}

	async function move(to: number): Promise<void> {
		active = Math.max(0, Math.min(shown.length - 1, to));
		await tick();
		list?.querySelector('.row.active')?.scrollIntoView({ block: 'nearest' });
	}

	function onSearchKey(event: KeyboardEvent): void {
		if (event.key === 'ArrowDown' && shown.length > 0) {
			event.preventDefault();
			list?.focus();
			void move(0);

			return;
		}

		if (event.key === 'Backspace' && query === '' && value.length > 0 && !disabled) {
			event.preventDefault();
			commit(value.slice(0, -1));

			return;
		}

		// Enter ticks the best match; it never saves the form the picker sits in
		if (event.key === 'Enter') {
			const best = shown[0];

			event.preventDefault();

			if (query.trim() !== '' && best) {
				toggle(best.code);
			}

			return;
		}

		// the first Escape empties the search; the dialog only takes one over an empty box
		if (event.key === 'Escape' && query !== '') {
			event.preventDefault();
			query = '';
		}
	}

	function onListKey(event: KeyboardEvent): void {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			void move(active + 1);

			return;
		}

		if (event.key === 'ArrowUp') {
			event.preventDefault();

			if (active === 0) {
				searchField()?.focus();

				return;
			}

			void move(active - 1);

			return;
		}

		if (event.key === 'Home' || event.key === 'End') {
			event.preventDefault();
			void move(event.key === 'Home' ? 0 : shown.length - 1);

			return;
		}

		if (event.key === ' ' || event.key === 'Enter') {
			const country = shown[active];

			event.preventDefault();
			// Enter here ticks a row; it must not also submit the form around the picker
			event.stopPropagation();

			if (country) {
				toggle(country.code);
			}
		}
	}
</script>

<div class="picker" class:invalid class:disabled bind:this={root}>
	<!-- the box's own clear button has no type, so inside a form its click would save the form -->
	<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
	<div class="find" onkeydown={onSearchKey} onclick={(event) => event.preventDefault()}>
		<SearchInput bind:value={query} width="100%" placeholder={t('web.firewall.countries.search')} />
	</div>

	{#if picked.length > 0}
		<ul class="chips" aria-label={t('web.firewall.countries.picked')}>
			{#each picked as country (country.code)}
				<li class="chip">
					<span class="mono">{country.code}</span>
					<span class="name">{country.name}</span>
					<button
						type="button"
						class="drop"
						{disabled}
						aria-label={t('web.firewall.countries.remove', { name: country.name })}
						onclick={() => toggle(country.code)}
					>
						<Icon name="close" size="0.625rem" />
					</button>
				</li>
			{/each}
		</ul>
	{/if}

	<div
		class="list"
		role="listbox"
		aria-multiselectable="true"
		aria-label={label}
		aria-disabled={disabled}
		aria-activedescendant={shown[active] ? `${listId}-${shown[active].code}` : undefined}
		tabindex={disabled ? -1 : 0}
		bind:this={list}
		onkeydown={onListKey}
	>
		{#each shown as country, index (country.code)}
			{@const on = value.includes(country.code)}
			<!-- the listbox owns the keys; a row only takes the pointer -->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<div
				id="{listId}-{country.code}"
				class="row"
				class:on
				class:active={index === active}
				role="option"
				aria-selected={on}
				tabindex="-1"
				onclick={() => {
					active = index;
					toggle(country.code);
				}}
			>
				<!-- drawn by the kit, never a tab stop of its own: the row is the control -->
				<span class="tick" inert><Checkbox checked={on} {disabled} /></span>
				<span class="mono code">{country.code}</span>
				<span class="name">{country.name}</span>
			</div>
		{:else}
			<p class="none">{t('web.firewall.countries.noMatch')}</p>
		{/each}
	</div>

	<GeoAttribution />
</div>

<style lang="scss">
	.picker {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;

		&.disabled {
			opacity: 0.6;
		}
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		max-width: 100%;
		padding: 0 0.25rem 0 0.5rem;
		border-radius: 0.25rem;
		background: var(--bg-hover);
		font-size: 0.875rem;
		line-height: 1.5rem;

		.name {
			@include ellipsis;
		}
	}

	.drop {
		@include bare-button;

		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.25rem;
		height: 1.25rem;
		border-radius: 0.25rem;
		color: var(--text-secondary);
		cursor: pointer;

		&:hover {
			color: var(--text-heading);
			background: var(--bg-panel);
		}

		&:focus-visible {
			@include focus-ring;
		}
	}

	// a fixed height, so the dialog around it does not jump as the search narrows the list
	.list {
		height: 12rem;
		overflow-y: auto;
		border: var(--border-control) solid var(--border-input);
		border-radius: var(--radius-input);
		background: var(--bg-input);

		&:focus-visible {
			outline: none;
			border-color: var(--link);
			box-shadow: 0 0 0 0.1rem var(--link);
		}

		.invalid & {
			border-color: var(--error);
			box-shadow: 0 0 0 0.1rem var(--error);
		}
	}

	.row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.25rem 0.75rem;
		font-size: 0.875rem;
		cursor: pointer;

		&:hover {
			background: var(--bg-hover);
		}

		// a tint over the whole row, never a stripe down one side
		&.on {
			background: var(--bg-selected);
		}

		.name {
			@include ellipsis;
		}
	}

	// the keyboard's place in the list, only while the list has the focus
	.list:focus-visible .row.active {
		box-shadow: inset 0 0 0 0.125rem var(--link);
	}

	.tick {
		display: inline-flex;
	}

	.code {
		flex: none;
		width: 1.75rem;
		color: var(--text-secondary);
	}

	.none {
		margin: 0;
		padding: 0.75rem;
		color: var(--text-secondary);
		font-size: 0.875rem;
	}
</style>
