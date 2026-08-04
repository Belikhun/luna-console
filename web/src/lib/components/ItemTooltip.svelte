<script lang="ts">
	/**
	 * The hover card Minecraft draws for an item, built the way the client builds
	 * it rather than approximated.
	 *
	 * The client paints three rings: a one-pixel background ring with its corners
	 * notched out, then a one-pixel border inset inside it running a gradient from
	 * `#5000FF` down to `#28007F` at 0x50 alpha, then two pixels of padding before
	 * the text. Lines sit on a ten-pixel pitch with two extra pixels after the
	 * name. All of that is expressed in `--gui-px`, the Minecraft pixel the chest
	 * publishes, so the card is in scale with the GUI it hangs off.
	 *
	 * Lore defaults to upright rather than italic because the plugin deserializes
	 * every line with a leading `<!italic>`.
	 */

	import MinecraftText from './MinecraftText.svelte';

	interface Props {
		name: string;
		lore?: string[];
		/** Placeholder values; without them the tokens are shown as tokens */
		values?: Record<string, string>;
	}

	const { name, lore = [], values }: Props = $props();

	// The card is as wide as its widest line. The game only ever wraps a tooltip
	// that would not fit the *screen*, which at a GUI's scale is several hundred
	// game pixels, so a card capped at anything narrower breaks lines the player
	// will never see broken — and the name line of a selector item, which pads its
	// version out to the right edge, is exactly the line that would break.
	const WRAP = Number.POSITIVE_INFINITY;
	// the client steps a tooltip's lines by ten rather than the font's own nine
	const PITCH = 10;
</script>

<div class="tip">
	<div class="frame">
		<div class="body">
			<div class="name">
				<MinecraftText source={name} {values} baseColor="#ffffff" shadow wrap={WRAP} pitch={PITCH} />
			</div>

			{#if lore.length > 0}
				<div class="lore">
					<MinecraftText
						source={lore.join('\n')}
						{values}
						baseColor="#aaaaaa"
						shadow
						wrap={WRAP}
						pitch={PITCH}
					/>
				</div>
			{/if}
		</div>
	</div>
</div>

<style lang="scss">
	.tip {
		// the outermost ring, with the corner pixels cut away
		padding: var(--gui-px);
		background: rgba(16, 0, 16, 0.941);
		clip-path: polygon(
			var(--gui-px) 0,
			calc(100% - var(--gui-px)) 0,
			100% var(--gui-px),
			100% calc(100% - var(--gui-px)),
			calc(100% - var(--gui-px)) 100%,
			var(--gui-px) 100%,
			0 calc(100% - var(--gui-px)),
			0 var(--gui-px)
		);
		width: max-content;
		font-size: calc(var(--gui-px) * 10);
	}

	.frame {
		// the border gradient is translucent and the client draws it over the same
		// dark fill, so the fill sits under it here too
		padding: var(--gui-px);
		background-color: rgba(16, 0, 16, 0.941);
		background-image: linear-gradient(180deg, rgba(80, 0, 255, 0.314), rgba(40, 0, 127, 0.314));
	}

	.body {
		padding: calc(var(--gui-px) * 2);
		background: rgba(16, 0, 16, 0.941);
	}

	// the lore is one block so its lines keep an even pitch through a wrap; the
	// only gap the client adds by hand is the two pixels after the name
	.name {
		margin-bottom: calc(var(--gui-px) * 2);
	}
</style>
