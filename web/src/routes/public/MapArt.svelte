<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	/**
	 * A server card's artwork: four BlueMap lowres tiles in a 2x2 around spawn.
	 *
	 * Each tile PNG is colour on the top half and a heightmap on the bottom, so
	 * `object-position: top` over a square box crops away the half that is not a
	 * picture. That crop is the whole trick; there is no image processing on the
	 * server, and the browser caches the tiles like any other image.
	 */
	import { onMount } from 'svelte';

	let { instance }: { instance: string } = $props();

	interface Art {
		map: string;
		lod: number;
		tiles: Array<{ x: number; z: number }>;
	}

	let art: Art | null = $state(null);

	onMount(async () => {
		try {
			const response = await fetch(`/api/public/map/${encodeURIComponent(instance)}/art`);

			if (response.ok) {
				art = (await response.json()) as Art;
			}
		} catch {
			// the card falls back to its accent wash; a missing picture is not worth
			// reporting to a visitor
		}
	});

	const src = (tile: { x: number; z: number }): string =>
		`/api/public/map/${encodeURIComponent(instance)}/maps/${art!.map}/tiles/${art!.lod}/x${tile.x}/z${tile.z}.png`;
</script>

{#if art}
	<div class="tiles">
		{#each art.tiles as tile (`${tile.x},${tile.z}`)}
			<img src={src(tile)} alt="" loading="lazy" />
		{/each}
	</div>
{/if}

<style lang="scss">
	.tiles {
		@include fill;

		display: grid;
		grid-template-columns: 1fr 1fr;
		grid-template-rows: 1fr 1fr;
		// drawn larger than the frame and pulled up, so the visible band is the
		// explored middle rather than the empty edges of the rendered area
		transform: scale(1.6) translateY(-5%);
	}

	img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		// top half only: the bottom half of every lowres tile is the heightmap
		object-position: top;
		aspect-ratio: 1 / 1;
	}
</style>
