<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { renderMiniMessage, type MmLine } from '$shared/minimessage';

	/**
	 * A MiniMessage string as HTML, in the console's own face.
	 *
	 * `MinecraftText` draws the game's bitmap font onto a canvas, which is the
	 * right answer whenever the question is "what will the player see": every
	 * glyph advance matches the client's. This is the other case; a heading on a
	 * web page, where the text should scale, wrap, be selectable and be readable
	 * by a screen reader, and where a canvas would be none of those.
	 *
	 * Both take the same parse tree, so a gradient resolves to the same colours
	 * either way.
	 */
	let {
		source,
		values,
		baseColor,
		inline = false
	}: {
		source: string;
		/** Substituted before parsing, exactly as the plugin does it */
		values?: Record<string, string>;
		/** Colour for text that sets none */
		baseColor?: string;
		/** Collapse line breaks onto one line */
		inline?: boolean;
	} = $props();

	const lines: MmLine[] = $derived(
		renderMiniMessage(source ?? '', {
			...(values ? { values } : {}),
			...(baseColor ? { baseColor } : {})
		})
	);

	/** Plain text of the whole run, so the element still reads as its content. */
	const plain = $derived(
		lines.map((line) => line.map((span) => span.text).join('')).join(inline ? ' ' : '\n')
	);
</script>

<span class="mm" class:inline aria-label={plain}>
	{#each lines as line, index (index)}
		{#if index > 0 && !inline}<br />{/if}
		{#each line as span, spanIndex (spanIndex)}
			<span
				style:color={span.color}
				class:b={span.bold}
				class:i={span.italic}
				class:u={span.underlined}
				class:s={span.strikethrough}>{span.text}</span
			>
		{/each}
	{/each}
</span>

<style lang="scss">
	.mm {
		// the gradients that carry a server's identity are per character, so the
		// runs must not be re-spaced by anything inherited
		white-space: pre-wrap;

		&.inline {
			white-space: nowrap;
		}
	}

	.b {
		font-weight: 700;
	}

	.i {
		font-style: italic;
	}

	.u {
		text-decoration: underline;
	}

	.s {
		text-decoration: line-through;
	}

	// both at once, which the decorations above would otherwise clobber
	.u.s {
		text-decoration: underline line-through;
	}
</style>
