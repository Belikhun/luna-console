<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import PlayerSkin from './PlayerSkin.svelte';

	/**
	 * A player name as it renders everywhere in the console: the skin's face
	 * beside the linked name, so a player is recognisable at a glance in any
	 * table or list. Use this wherever a player name appears rather than
	 * composing PlayerSkin and a link by hand.
	 */
	let {
		player,
		name,
		href,
		px = 3
	}: {
		/** UUID when the caller has one, else the username; keys the skin and the default link */
		player: string;
		/** display name; falls back to `player` */
		name?: string;
		/** defaults to the player's detail page */
		href?: string;
		/** avatar scale, canvas pixels per skin texel */
		px?: number;
	} = $props();
</script>

<span class="who">
	<PlayerSkin {player} view="face" {px} />
	<a href={href ?? `/players/${player}`}><b>{name || player}</b></a>
</span>

<style lang="scss">
	.who {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}
</style>
