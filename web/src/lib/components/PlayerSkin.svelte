<script lang="ts">
	import Icon from './Icon.svelte';

	/**
	 * Renders a player's skin from the console's own skin proxy
	 * (`/api/players/<player>/skin`) onto a canvas: the flat front face with
	 * the hat/hair layer applied over it, or the front-facing full body
	 * composite. Both are drawn locally from the raw 64×64 (or legacy 64×32)
	 * skin PNG; nothing is fetched from an external renderer, so avatars work
	 * offline once the skin is cached.
	 *
	 * Legacy skins routinely ship the hat layer on a solid background instead
	 * of transparency; a mostly-opaque overlay has its dominant colour keyed
	 * out before drawing, so old skins don't render with a black box for hair.
	 */

	let {
		player,
		view = 'face',
		px = 6,
		bust = 0
	}: {
		/** UUID or username; whatever the row carries */
		player: string;
		view?: 'face' | 'body';
		/** Scale: canvas pixels per skin texel */
		px?: number;
		/** Bump to bypass the browser's cached copy after a skin change */
		bust?: number;
	} = $props();

	/**
	 * Texels the overlay layer sticks out past the base layer on every side.
	 *
	 * The hat/jacket cubes are larger than the body parts they wrap, so hair
	 * and hoods extend beyond the head's silhouette. Drawing the overlay at the
	 * base layer's own rect cuts that off; the composite is padded by the same
	 * amount so the outset has somewhere to land instead of being clipped by
	 * the canvas edge.
	 */
	const OUTSET = 1;

	let canvas: HTMLCanvasElement | undefined = $state();
	let failed = $state(false);

	const width = $derived(Math.ceil(((view === 'face' ? 8 : 16) + 2 * OUTSET) * px));
	const height = $derived(Math.ceil(((view === 'face' ? 8 : 32) + 2 * OUTSET) * px));

	interface Layer {
		sx: number;
		sy: number;
		sw: number;
		sh: number;
		dx: number;
		dy: number;
		/** Mirror horizontally; legacy skins reuse the right limb for the left */
		flip?: boolean;
		/** Draw through the overlay-cleaning pass */
		overlay?: boolean;
	}

	/** Whether the skin uses 3-px slim arms, judged from the classic-arm pixel. */
	function isSlim(probe: CanvasRenderingContext2D): boolean {
		const alpha = probe.getImageData(54, 20, 1, 1).data[3] ?? 0;

		return alpha === 0;
	}

	/**
	 * Cut one region out of the skin as its own canvas, keying out the
	 * background when the region is an overlay with no real transparency:
	 * if ≥95% of its pixels are opaque, the dominant colour is treated as
	 * the background and made transparent.
	 */
	function tile(
		probe: CanvasRenderingContext2D,
		sx: number,
		sy: number,
		sw: number,
		sh: number,
		overlay: boolean
	): HTMLCanvasElement {
		const out = document.createElement('canvas');
		out.width = sw;
		out.height = sh;

		const ctx = out.getContext('2d')!;
		const image = probe.getImageData(sx, sy, sw, sh);

		if (overlay) {
			const data = image.data;
			const counts = new Map<number, number>();
			let opaque = 0;

			for (let index = 0; index < data.length; index += 4) {
				if ((data[index + 3] ?? 0) >= 128) {
					opaque++;

					const key = ((data[index]! << 16) | (data[index + 1]! << 8) | data[index + 2]!) >>> 0;
					counts.set(key, (counts.get(key) ?? 0) + 1);
				}
			}

			const total = sw * sh;

			if (opaque / total >= 0.95 && counts.size > 0) {
				let dominant = 0;
				let dominantCount = 0;

				for (const [key, count] of counts) {
					if (count > dominantCount) {
						dominant = key;
						dominantCount = count;
					}
				}

				// only key it out when it plausibly IS a background, not just hair
				if (dominantCount / total >= 0.4) {
					for (let index = 0; index < data.length; index += 4) {
						const key = ((data[index]! << 16) | (data[index + 1]! << 8) | data[index + 2]!) >>> 0;

						if (key === dominant) {
							data[index + 3] = 0;
						}
					}
				}
			}
		}

		ctx.putImageData(image, 0, 0);
		return out;
	}

	function faceLayers(): Layer[] {
		return [
			{ sx: 8, sy: 8, sw: 8, sh: 8, dx: 0, dy: 0 },
			{ sx: 40, sy: 8, sw: 8, sh: 8, dx: 0, dy: 0, overlay: true }
		];
	}

	/**
	 * The body composite, back to front. Each overlay follows its own base part
	 * rather than being appended in one trailing group: an overlay is drawn a
	 * texel larger on every side, so a jacket painted after the arms would
	 * spill its outset over the sleeves. Head and hat come last, since the head
	 * sits in front of the torso.
	 */
	function bodyLayers(modern: boolean, slim: boolean): Layer[] {
		const arm = slim ? 3 : 4;

		// both arms hug the torso, which spans texels 4-12
		const rightArmX = 4 - arm;
		const leftArmX = 12;

		const layers: Layer[] = [
			// legs
			{ sx: 4, sy: 20, sw: 4, sh: 12, dx: 4, dy: 20 },
			...(modern ? [{ sx: 4, sy: 36, sw: 4, sh: 12, dx: 4, dy: 20, overlay: true }] : []),
			...(modern
				? [{ sx: 20, sy: 52, sw: 4, sh: 12, dx: 8, dy: 20 }]
				: [{ sx: 4, sy: 20, sw: 4, sh: 12, dx: 8, dy: 20, flip: true }]),
			...(modern ? [{ sx: 4, sy: 52, sw: 4, sh: 12, dx: 8, dy: 20, overlay: true }] : []),

			// torso
			{ sx: 20, sy: 20, sw: 8, sh: 12, dx: 4, dy: 8 },
			...(modern ? [{ sx: 20, sy: 36, sw: 8, sh: 12, dx: 4, dy: 8, overlay: true }] : []),

			// right arm (the viewer's left)
			{ sx: 44, sy: 20, sw: arm, sh: 12, dx: rightArmX, dy: 8 },
			...(modern
				? [{ sx: 44, sy: 36, sw: arm, sh: 12, dx: rightArmX, dy: 8, overlay: true }]
				: []),

			// left arm
			...(modern
				? [{ sx: 36, sy: 52, sw: arm, sh: 12, dx: leftArmX, dy: 8 }]
				: [{ sx: 44, sy: 20, sw: arm, sh: 12, dx: leftArmX, dy: 8, flip: true }]),
			...(modern ? [{ sx: 52, sy: 52, sw: arm, sh: 12, dx: leftArmX, dy: 8, overlay: true }] : []),

			// head + hat, centred over the 8-wide torso and in front of it
			{ sx: 8, sy: 8, sw: 8, sh: 8, dx: 4, dy: 0 },
			{ sx: 40, sy: 8, sw: 8, sh: 8, dx: 4, dy: 0, overlay: true }
		];

		return layers;
	}

	function drawFlat(ctx: CanvasRenderingContext2D, probe: CanvasRenderingContext2D, layers: Layer[]): void {
		ctx.imageSmoothingEnabled = false;

		for (const layer of layers) {
			const overlay = layer.overlay ?? false;
			const source = tile(probe, layer.sx, layer.sy, layer.sw, layer.sh, overlay);

			// base layers sit inside the padding; overlays are grown into it, so
			// the two stay concentric and the outset is what extends past the base
			const outset = overlay ? OUTSET : 0;
			const destX = (layer.dx + OUTSET - outset) * px;
			const destY = (layer.dy + OUTSET - outset) * px;
			const destW = (layer.sw + 2 * outset) * px;
			const destH = (layer.sh + 2 * outset) * px;

			if (layer.flip) {
				ctx.save();
				ctx.translate(destX + destW, destY);
				ctx.scale(-1, 1);
				ctx.drawImage(source, 0, 0, destW, destH);
				ctx.restore();
				continue;
			}

			ctx.drawImage(source, destX, destY, destW, destH);
		}
	}

	async function draw(): Promise<void> {
		if (!canvas) {
			return;
		}

		failed = false;

		const image = new Image();
		image.src = `/api/players/${encodeURIComponent(player)}/skin${bust ? `?v=${bust}` : ''}`;

		try {
			await image.decode();
		} catch {
			failed = true;
			return;
		}

		// read texels through an offscreen copy: keying and the slim-arm probe
		// both need pixel access, which a plain drawImage source does not give
		const probeCanvas = document.createElement('canvas');
		probeCanvas.width = image.width;
		probeCanvas.height = image.height;

		const probe = probeCanvas.getContext('2d', { willReadFrequently: true });
		const ctx = canvas.getContext('2d');

		if (!probe || !ctx) {
			failed = true;
			return;
		}

		probe.drawImage(image, 0, 0);

		const modern = image.height >= 64;

		ctx.clearRect(0, 0, canvas.width, canvas.height);

		if (view === 'face') {
			drawFlat(ctx, probe, faceLayers());
			return;
		}

		drawFlat(ctx, probe, bodyLayers(modern, modern && isSlim(probe)));
	}

	$effect(() => {
		// re-render when the target, geometry or cache-buster changes
		void player;
		void view;
		void px;
		void bust;
		void draw();
	});
</script>

{#if failed}
	<span
		class="fallback"
		style:width="{width}px"
		style:height="{height}px"
		title="No skin recorded for this player"
	>
		<Icon name="user" style="light" />
	</span>
{:else}
	<canvas bind:this={canvas} {width} {height}></canvas>
{/if}

<style lang="scss">
	canvas {
		display: block;
		image-rendering: pixelated;
		border-radius: 0.25rem;
	}

	.fallback {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: var(--bg-panel-raised);
		border-radius: 0.25rem;
		color: var(--text-disabled);
	}
</style>
