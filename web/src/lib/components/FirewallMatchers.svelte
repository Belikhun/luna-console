<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { countryName } from '$lib/firewall';
	import { t } from '$lib/i18n.svelte';
	import type { FirewallRule } from '$shared/firewall';

	import InfoPopover from './InfoPopover.svelte';

	/**
	 * What a firewall rule matches, as chips: one group per matcher the rule
	 * gives, a dim `+` between groups because a connection has to match all of
	 * them. A group shows its first values and folds the rest into a `+N` that
	 * opens the whole list.
	 */
	let {
		rule,
		full = false
	}: {
		rule: Pick<FirewallRule, 'addresses' | 'countries'>;
		/** Every value written out, countries by name: a detail view, where a row would cut them */
		full?: boolean;
	} = $props();

	interface Group {
		kind: 'addresses' | 'countries';
		shown: string[];
		rest: number;
		/** Every value, one line each, behind the `+N` */
		all: string[];
		mono: boolean;
	}

	function group(kind: Group['kind'], values: readonly string[] | undefined, limit: number, mono: boolean, line: (value: string) => string = (value) => value): Group[] {
		if (!values?.length) {
			return [];
		}

		if (full) {
			return [{ kind, shown: values.map(line), rest: 0, all: [], mono }];
		}

		return [{
			kind,
			shown: values.slice(0, limit),
			rest: Math.max(0, values.length - limit),
			all: values.map(line),
			mono
		}];
	}

	const groups = $derived([
		...group('addresses', rule.addresses, 2, true),
		...group('countries', rule.countries, 3, !full, (code) => `${code} ${countryName(code)}`)
	]);
</script>

<span class="matchers">
	{#each groups as entry, index (entry.kind)}
		{#if index > 0}
			<span class="and" aria-hidden="true">+</span>
			<span class="spoken">{t('web.firewall.rules.and')}</span>
		{/if}
		<span class="group">
			{#each entry.shown as value (value)}
				<span class="chip" class:mono={entry.mono}>{value}</span>
			{/each}
			{#if entry.rest > 0}
				<InfoPopover detail={entry.all}>+{entry.rest}</InfoPopover>
			{/if}
		</span>
	{/each}
</span>

<style lang="scss">
	.matchers {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.5rem;
		min-width: 0;
	}

	.group {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem;
		min-width: 0;
	}

	// said, not shown: the `+` reads as nothing to a screen reader
	.spoken {
		position: absolute;
		width: 0.1rem;
		height: 0.1rem;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	.and {
		color: var(--text-secondary);
	}

	// plain text on a raised ground; a chip never wears a state colour
	.chip {
		@include ellipsis;

		max-width: 18rem;
		padding: 0 0.375rem;
		border-radius: 0.25rem;
		background: var(--bg-hover);
		line-height: 1.5rem;

		// the mono face keeps the console's own mono size
		&:not(.mono) {
			font-size: 0.875rem;
		}
	}
</style>
