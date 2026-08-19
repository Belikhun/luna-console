<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	/**
	 * A server card's artwork: four of the map's own coarse tiles in a 2x2 around
	 * spawn.
	 *
	 * Which four is the server's business, not this component's: `/art` answers
	 * with tile URLs already, because the two map plugins address their tiles
	 * nothing like each other and a card that knew the difference would grow a
	 * branch per provider.
	 *
	 * BlueMap's coarse tiles are colour on the top half and a heightmap on the
	 * bottom, so `crop` cuts away the half that is not a picture. That crop is the
	 * whole trick; there is no image processing on the server, and the browser
	 * caches the tiles like any other image.
	 */
	import { onMount } from 'svelte';

	let { instance }: { instance: string } = $props();

	interface Art {
		tiles: string[];
		crop: boolean;
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

	const src = (tile: string): string =>
		`/api/public/map/${encodeURIComponent(instance)}/${tile}`;
</script>

{#if art}
	<div class="tiles">
		{#each art.tiles as tile (tile)}
			<img class:crop={art.crop} src={src(tile)} alt="" loading="lazy" />
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
		aspect-ratio: 1 / 1;

		// top half only: the bottom half of every BlueMap lowres tile is a heightmap
		&.crop {
			object-position: top;
		}
	}
</style>
