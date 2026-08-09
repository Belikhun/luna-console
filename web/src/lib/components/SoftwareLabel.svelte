<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { SOFTWARE_TRAITS } from '$core/software';
	import type { Software } from '$core/types';

	import Icon from './Icon.svelte';
	import {
		CHANNEL_COLORS,
		CHANNEL_LABELS,
		SOFTWARE_MARKS,
		softwareColor,
		softwareIcon,
		type ReleaseChannel
	} from './software';

	/**
	 * What a server runs: the project's own mark, its name, and optionally the
	 * version and how finished that build claims to be.
	 *
	 * This is the one rendering of a software across the console (the instances
	 * table, an instance's header and info grid, a plugin's usage list), so a
	 * software reads the same everywhere - and the traits table stays the single
	 * source of its name, rather than each screen printing the raw registry id.
	 *
	 * A software with no published icon artwork falls back to a glyph describing
	 * what it is; see `software.ts` for why that is preferred to tracing a logo.
	 */
	let {
		software,
		version = null,
		channel = null,
		short = false,
		size = '0.875rem'
	}: {
		software: Software | string;
		/** Shown after the name; the MC version, or a loader build */
		version?: string | null;
		/** Omit for an ordinary release, which deliberately carries no badge */
		channel?: ReleaseChannel | null;
		/** Name only: what a narrow table column has room for */
		short?: boolean;
		size?: string;
	} = $props();

	const mark = $derived(SOFTWARE_MARKS[software as Software]);

	/**
	 * The version, unless the badge beside it already says the same word.
	 *
	 * Pumpkin's only version *is* `nightly`, so printing both left the row
	 * reading "Pumpkin nightly NIGHTLY". The badge wins: it is the one that
	 * carries the colour and says what the string means.
	 */
	const versionText = $derived.by(() => {
		const text = version?.trim();

		if (!text || !channel) {
			return text;
		}

		return text.toLowerCase() === channel.toLowerCase() ? undefined : text;
	});

	// Indexed rather than looked up through `traitsOf`, which throws: an id luna
	// does not know is still worth printing, because the registry is data and an
	// adopted instance can name a software the traits table has never heard of.
	const label = $derived.by(() => {
		const traits = SOFTWARE_TRAITS[software as Software];

		return traits ? t(traits.label) : software;
	});
</script>

<!-- the tint rides on the wrapper so the mark and the name share it -->
<span class="software" style:color={softwareColor(software)}>
	{#if mark}
		<!--
			The source's own drawing settings are spread onto the root rather than
			re-expressed, because several of these marks set their stroke there and
			nowhere else. `{@html}` carries the shapes verbatim; see `software.ts`
			for why that is safe and why the markup is not taken apart first.
		-->
		<svg
			class="mark"
			viewBox={mark.viewBox}
			width={size}
			height={size}
			{...mark.attrs}
			aria-hidden="true"
			focusable="false"
		>
			{@html mark.markup}
		</svg>
	{:else}
		<Icon name={softwareIcon(software)} {size} />
	{/if}

	<span class="name">{label}</span>

	{#if versionText && !short}
		<span class="version">{versionText}</span>
	{/if}

	{#if channel && !short}
		<span class="channel" style:color={CHANNEL_COLORS[channel]}>{t(CHANNEL_LABELS[channel])}</span>
	{/if}
</span>

<style lang="scss">
	.software {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		min-width: 0;
	}

	// the same optical alignment a brand mark and a glyph get, so all three sit
	// on one line whichever a row happens to draw
	.mark {
		display: inline-block;
		vertical-align: -0.125em;
		flex: none;
	}

	.name {
		@include ellipsis;
	}

	// the version is a fact about the build, not part of the software's name, so
	// it drops out of the brand tint and reads as secondary
	.version {
		color: var(--text-secondary);
		font-family: var(--font-mono);
		font-size: 0.75rem;
	}

	// a chip rather than plain text: it is a warning about the build, and it has
	// to survive sitting next to a version that is also small and dim
	.channel {
		flex: none;
		border: 0.1rem solid currentColor;
		border-radius: 0.625rem;
		padding: 0 0.375rem;
		font-size: 0.625rem;
		line-height: 1.125rem;
		text-transform: uppercase;
		letter-spacing: 0.03125rem;
	}
</style>
