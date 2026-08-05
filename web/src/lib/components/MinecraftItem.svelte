<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	/**
	 * One inventory item, drawn the way the game draws it.
	 *
	 * A generated item is its sprite layers stacked. Anything else is a real
	 * model: every box the model declares, projected through the transform the
	 * model itself carries under `display.gui`. That distinction matters; a
	 * slab is not a short cube, a stair is viewed from a different angle than a
	 * block, and a torch is two crossed planes. `minecraftitem.ts` does that
	 * geometry; this component loads the textures and paints the result.
	 *
	 * Everything is nearest-neighbour; these are 16×16 textures blown up, and any
	 * smoothing turns them to mush.
	 */

	import {
		loadRegistry,
		loadTexture,
		renderFor,
		textureUrl,
		type ItemRender,
		type McAssetRegistry
	} from './mcassets';
	import { buildQuads, multiplyColor, type ItemQuad } from './minecraftitem';

	interface Props {
		/** Material name, e.g. `GRASS_BLOCK`; unknown ones fall back to a barrier */
		item?: string;
		/** Draw the enchantment shimmer over it */
		glint?: boolean;
		/** Side length; the canvas renders at 4× this for crisp edges */
		size?: string;
		/** Shown while the assets have not been extracted yet */
		fallbackLabel?: string;
		/** Accent used by the fallback tile */
		fallbackColor?: string;
	}

	const { item, glint = false, size = '2rem', fallbackLabel, fallbackColor }: Props = $props();

	let registry: McAssetRegistry | null = $state(null);
	let canvas: HTMLCanvasElement | undefined = $state();
	let painted = $state(false);
	let silhouette: string | null = $state(null);

	// The slot the client gives an item is 16 pixels across; drawing it at 4× that
	// keeps texel edges landing on pixel boundaries at the sizes the editor uses.
	const SLOT_PX = 16;
	const SCALE = 4;
	const CANVAS_PX = SLOT_PX * SCALE;

	$effect(() => {
		void loadRegistry().then((loaded) => (registry = loaded));
	});

	const render: ItemRender | null = $derived(renderFor(registry, item));

	// the overwhelmingly common case is a one-layer untinted sprite, and an <img>
	// is both cheaper and sharper than compositing it onto a canvas
	const flatSrc = $derived(
		render?.kind === 'flat' && render.layers?.length === 1 && render.layers[0] && !render.tint
			? textureUrl(render.layers[0])
			: null
	);

	const needsCanvas = $derived(!!render && !flatSrc && render.kind !== 'unknown');
	const maskSrc = $derived(flatSrc ?? silhouette);

	const shadedCache = new Map<string, HTMLCanvasElement>();

	/** Paint a texture through a colour multiply, keeping its alpha. */
	function shaded(image: HTMLImageElement, color: string): HTMLCanvasElement | HTMLImageElement {
		const key = `${image.src}|${color}`;
		const existing = shadedCache.get(key);

		if (existing) {
			return existing;
		}

		const out = document.createElement('canvas');
		out.width = image.width;
		out.height = image.height;

		const ctx = out.getContext('2d');

		if (!ctx) {
			return image;
		}

		ctx.imageSmoothingEnabled = false;
		ctx.drawImage(image, 0, 0);
		ctx.globalCompositeOperation = 'multiply';
		ctx.fillStyle = color;
		ctx.fillRect(0, 0, out.width, out.height);
		// multiply painted over the transparent parts too; mask them back out
		ctx.globalCompositeOperation = 'destination-in';
		ctx.drawImage(image, 0, 0);

		shadedCache.set(key, out);

		return out;
	}

	/** `#side` against the item's own texture map, or an already-resolved path. */
	function resolveTexture(reference: string, textures: Record<string, string> | undefined): string | undefined {
		if (!reference.startsWith('#')) {
			return reference.replace(/^minecraft:/, '');
		}

		return textures?.[reference.slice(1)];
	}

	async function paintFlat(ctx: CanvasRenderingContext2D, spec: ItemRender): Promise<boolean> {
		let drawn = false;

		for (const [index, layer] of (spec.layers ?? []).entries()) {
			const image = await loadTexture(layer);

			if (!image) {
				continue;
			}

			// the client tints the first layer only: a potion's liquid, a leather
			// boot's dye, a spawn egg's base; the overlay above it stays as drawn
			const source = spec.tint && index === 0 ? shaded(image, multiplyColor(1, spec.tint)) : image;

			// item sprites are square sheets; an animated one stacks its frames
			// vertically, so only the first is drawn
			ctx.drawImage(source, 0, 0, image.width, image.width, 0, 0, CANVAS_PX, CANVAS_PX);
			drawn = true;
		}

		return drawn;
	}

	async function paintQuad(ctx: CanvasRenderingContext2D, quad: ItemQuad, spec: ItemRender): Promise<boolean> {
		const path = resolveTexture(quad.texture, spec.textures);
		const image = path ? await loadTexture(path) : null;

		if (!image) {
			return false;
		}

		const source = shaded(image, multiplyColor(quad.shade, quad.tinted ? spec.tint : undefined));
		// the UV is stated in the texture's own 0-16 space, whatever its resolution
		const texel = image.width / 16;
		const centre = CANVAS_PX / 2;

		ctx.setTransform(
			quad.u[0] * SCALE,
			quad.u[1] * SCALE,
			quad.v[0] * SCALE,
			quad.v[1] * SCALE,
			centre + quad.origin[0] * SCALE,
			centre + quad.origin[1] * SCALE
		);
		ctx.drawImage(
			source,
			quad.uv[0] * texel,
			quad.uv[1] * texel,
			(quad.uv[2] - quad.uv[0]) * texel,
			(quad.uv[3] - quad.uv[1]) * texel,
			0,
			0,
			1,
			1
		);

		return true;
	}

	async function paint(target: HTMLCanvasElement, spec: ItemRender, wantsMask: boolean): Promise<void> {
		const ctx = target.getContext('2d');

		if (!ctx) {
			return;
		}

		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, CANVAS_PX, CANVAS_PX);
		ctx.imageSmoothingEnabled = false;

		let drawn = false;

		if (spec.kind === 'flat') {
			drawn = await paintFlat(ctx, spec);
		} else {
			const geometry = spec.geometry ? registry?.geometries[spec.geometry] : undefined;

			if (geometry) {
				for (const quad of buildQuads(geometry)) {
					drawn = (await paintQuad(ctx, quad, spec)) || drawn;
				}
			}
		}

		ctx.setTransform(1, 0, 0, 1, 0, 0);
		painted = drawn;
		// the shimmer follows the item's own outline, so it needs the shape that
		// was actually painted rather than the square the canvas occupies
		silhouette = drawn && wantsMask ? target.toDataURL() : null;
	}

	$effect(() => {
		const target = canvas;
		const spec = render;
		// read here rather than inside `paint`: the mask is only produced when the
		// glint is on, and `paint` reads it after an await, where the effect can no
		// longer see the dependency; turning the switch on would leave the sweep
		// unmasked until something else happened to force a repaint
		const wantsMask = glint;

		if (!target || !spec || !needsCanvas) {
			return;
		}

		void paint(target, spec, wantsMask);
	});

	const initials = $derived((fallbackLabel ?? item ?? '?').replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase());
	// a model whose textures never arrived draws nothing at all, and an empty
	// square says less than the tile the editor falls back to elsewhere
	const showFallback = $derived(!flatSrc && (!needsCanvas || !painted));
</script>

<span
	class="item"
	class:glint
	class:masked={glint && !!maskSrc}
	style:--item-size={size}
	style:--glint-mask={maskSrc ? `url("${maskSrc}")` : 'none'}
	title={item}
>
	{#if flatSrc}
		<img src={flatSrc} alt={item ?? ''} />
	{:else if needsCanvas}
		<canvas bind:this={canvas} width={CANVAS_PX} height={CANVAS_PX} class:hidden={!painted}></canvas>
	{/if}

	{#if showFallback}
		<!-- assets not extracted, or an item the game draws with an entity model -->
		<span class="fallback" style:--fallback-color={fallbackColor ?? 'var(--border)'}>{initials}</span>
	{/if}
</span>

<style lang="scss">
	.item {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: var(--item-size);
		height: var(--item-size);
		flex: none;
	}

	img,
	canvas {
		width: 100%;
		height: 100%;
		// these are 16px textures scaled up; smoothing them is the one thing that
		// makes an item stop looking like a Minecraft item
		image-rendering: pixelated;
	}

	canvas.hidden {
		display: none;
	}

	.fallback {
		@include fill;

		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 0.25rem;
		border: var(--hairline) solid var(--fallback-color);
		background: color-mix(in srgb, var(--fallback-color) 18%, transparent);
		color: var(--text-secondary);
		font-size: calc(var(--item-size) * 0.38);
		font-weight: 700;
		letter-spacing: -0.03em;
	}

	// The enchantment shimmer. In game it is a subtle sweep over the item's own
	// pixels, so it is kept faint and masked to the silhouette that was painted -
	// a torch is not a square, and an unmasked sweep would say it was.
	//
	// The sweep has to *loop*, which is a property of the numbers rather than of
	// the easing, and two of them decide it.
	//
	// The tile is 1.5 items wide and the animation slides it by exactly one tile,
	// so the last frame is the first frame; no snap. That width is also what
	// makes the shimmer continuous: consecutive bands sit 1.5 items apart and each
	// is a bit over an item wide, so one is always crossing and the item never
	// goes dark waiting for the next pass.
	//
	// The band is kept between 27% and 73% of the gradient. At 115° over a 3:2
	// tile the left edge only reaches 23.7% and the right edge starts at 76.3%, so
	// both vertical edges stay fully transparent and the tiles meet invisibly.
	// Moving those stops outward puts a diagonal seam through the item once a pass.
	.glint::after {
		content: '';

		@include fill;

		background-image: linear-gradient(
			115deg,
			transparent 27%,
			rgba(179, 108, 255, 0.16) 40%,
			rgba(226, 196, 255, 0.3) 50%,
			rgba(179, 108, 255, 0.16) 60%,
			transparent 73%
		);
		background-size: 150% 100%;
		background-repeat: repeat-x;
		animation: glint 3s linear infinite;
		mix-blend-mode: screen;
		pointer-events: none;
	}

	.masked::after {
		mask-image: var(--glint-mask);
		mask-size: 100% 100%;
		-webkit-mask-image: var(--glint-mask);
		-webkit-mask-size: 100% 100%;
	}

	// a percentage background-position is measured against (container − image),
	// which is half an item width negative here; so -300% is exactly +1.5 item
	// widths, one whole tile
	@keyframes glint {
		from {
			background-position: 0% 0;
		}

		to {
			background-position: -300% 0;
		}
	}
</style>
