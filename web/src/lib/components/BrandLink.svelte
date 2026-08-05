<script lang="ts">
	import BrandIcon from './BrandIcon.svelte';
	import Icon from './Icon.svelte';
	import { SOURCE_LABELS, sourceColor } from './brands';
	import { ADDON_PROVIDERS } from './addons';

	/**
	 * Where an addon came from: the provider's own mark, its name, and; when we
	 * know the project's page; an external link to it, all in that provider's
	 * brand colour rather than link blue, because the colour is part of what
	 * names the service.
	 *
	 * This is the one rendering of a source across the console (packs, plugins,
	 * mods, per-instance detail), so a source reads the same everywhere. Without
	 * `href` it degrades to the tinted name, so callers never branch.
	 */
	let {
		source,
		href = null,
		label,
		short = false,
		size = '0.875rem'
	}: {
		/** `PluginSource`/pack source: a provider id, or `luna`/`manual` */
		source: string;
		/** The project's page on that provider; null when it was never identified */
		href?: string | null;
		/** Overrides the provider's display name */
		label?: string;
		/** One word instead of a phrase; what a table column has room for */
		short?: boolean;
		size?: string;
	} = $props();

	const text = $derived.by(() => {
		if (label) {
			return label;
		}

		const provider = ADDON_PROVIDERS.find((entry) => entry.id === source);

		if (provider) {
			return provider.label;
		}

		const house = SOURCE_LABELS[source];

		if (house) {
			return short ? house.short : house.long;
		}

		return source;
	});
</script>

<!-- the tint rides on the wrapper so the mark, the name and the arrow share it -->
{#if href}
	<a class="brandlink" style:color={sourceColor(source)} {href} target="_blank" rel="noreferrer">
		<BrandIcon name={source} {size} />
		<span class="lt">{text}</span>
		<Icon name="externalLink" size="0.625rem" />
	</a>
{:else}
	<span class="brandlink plain" style:color={sourceColor(source)}>
		<BrandIcon name={source} {size} />
		{text}
	</span>
{/if}

<style lang="scss">
	.brandlink {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;

		// app.scss hands the underline to `.lt` for any link containing an icon, so
		// the rule never cuts through the mark or the arrow. The colour is inline
		// (above) because it has to beat both `a` and `a:hover` from the sheet -
		// which leaves hover feedback to brightness, on the whole mark+name+arrow.
		&:hover {
			filter: brightness(1.15);
		}
	}

	// a source with no page to open is a plain fact, so it carries no underline
	.plain {
		cursor: default;
	}
</style>
