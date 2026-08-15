<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import MinecraftItem from '$lib/components/MinecraftItem.svelte';
	import { tilePatternUrl } from '$lib/components/mcassets';
	import MiniMessageText from '$lib/components/MiniMessageText.svelte';
	import UptimeTimeline from '$lib/components/UptimeTimeline.svelte';
	import MapArt from './MapArt.svelte';
	import type { PublicInstanceCard } from '$core/publicsite';

	/**
	 * One server on the public grid.
	 *
	 * The card wears the instance's own accent, which is the colour the selector
	 * already gives it in game, so the palette on this page is the cluster's
	 * rather than one invented for it. No accent rail: the colour arrives through
	 * the name's gradient, the player meter and the hover glow, which is enough
	 * without spending a hard edge on it.
	 */
	let { card, days }: { card: PublicInstanceCard; days: number } = $props();

	const accent = $derived(card.accentColor ?? 'var(--link)');
	const fill = $derived(
		card.online && card.maxPlayers ? ((card.players ?? 0) / card.maxPlayers) * 100 : 0
	);

	/**
	 * The server's own block, tiled faintly behind its icon.
	 *
	 * A card with no rendered world is otherwise a flat wash, and the grid reads as
	 * having holes in it. The material the selector already gives the server is
	 * what fills them, so the card still says which server it is at a glance.
	 */
	let tile: string | null = $state(null);

	$effect(() => {
		const material = card.hasMap ? undefined : card.icon;
		let alive = true;

		tile = null;

		if (!material) {
			return;
		}

		void tilePatternUrl(material).then((url) => {
			if (alive) {
				tile = url;
			}
		});

		return () => {
			alive = false;
		};
	});
</script>

<a class="card" class:off={!card.online} href="/public/{card.name}" style:--accent={accent}>
	<div class="art">
		{#if card.hasMap}
			<MapArt instance={card.name} />
		{:else}
			<!-- no rendered map, so the server's own selector material carries the
			     card instead; the grid keeps its rhythm rather than leaving a hole -->
			<div class="blank" class:tiled={!!tile} style:--tile={tile ? `url("${tile}")` : 'none'}>
				{#if card.icon}
					<MinecraftItem item={card.icon} size="4.5rem" />
				{/if}
			</div>
		{/if}

		<div class="name">
			<MiniMessageText source={card.display} inline />
		</div>
	</div>

	<div class="bd">
		<div class="row">
			<span class="state" class:up={card.online}>
				<Icon name={card.online ? 'circleCheck' : 'ban'} style="solid" size="0.8125rem" />
				{card.online ? t('web.public.online') : t('web.public.offline')}
			</span>
			{#if card.mcVersion}<span class="ver">{card.mcVersion}</span>{/if}
		</div>

		{#if card.description.length}
			<div class="blurb">
				<MiniMessageText source={card.description[0]!} inline />
			</div>
		{/if}

		<div class="meter">
			<div class="bar"><i style:width="{fill}%"></i></div>
			<span class="n">
				{#if card.online}
					{card.players ?? 0}<span>/{card.maxPlayers ?? 0}</span>
				{:else}
					–
				{/if}
			</span>
		</div>

		<UptimeTimeline
			days={card.uptime.days}
			pct={card.uptime.pct}
			count={days}
			height="1.375rem"
		/>
	</div>
</a>

<style lang="scss">
	.card {
		background: var(--bg-panel);
		border: var(--hairline) solid var(--border-divider);
		border-radius: var(--radius-container);
		overflow: hidden;
		box-shadow: var(--shadow-panel);
		display: flex;
		flex-direction: column;
		color: inherit;
		text-decoration: none;
		transition:
			transform 0.14s ease,
			box-shadow 0.14s ease,
			border-color 0.14s ease;

		&:hover {
			transform: translateY(-0.1875rem);
			border-color: color-mix(in srgb, var(--accent) 55%, var(--border-divider));
			box-shadow:
				var(--shadow-panel),
				0 0 1.5rem -0.25rem color-mix(in srgb, var(--accent) 45%, transparent);
		}

		&:focus-visible {
			@include focus-ring;
		}

		&.off {
			opacity: 0.66;
		}
	}

	.art {
		position: relative;
		height: 11rem;
		background: #0b1017;
		overflow: hidden;

		// the scrim under the name, so a bright map never swallows it
		&::after {
			content: '';
			position: absolute;
			inset: 0;
			background: linear-gradient(
				to bottom,
				rgba(15, 20, 26, 0.1) 0%,
				rgba(15, 20, 26, 0.5) 52%,
				var(--bg-panel) 100%
			);
		}
	}

	.blank {
		@include fill;

		display: grid;
		place-items: center;
		padding-bottom: 1.5rem;
		background:
			radial-gradient(
				110% 130% at 50% 10%,
				color-mix(in srgb, var(--accent) 26%, transparent),
				transparent 68%
			),
			var(--bg-panel-raised);
	}

	// nearest-neighbour, because a 16 pixel texture smoothed by the browser stops
	// looking like Minecraft and starts looking like a smudge; faded to the edges
	// so the pattern never competes with the icon or the name over it
	.tiled::before {
		content: '';

		@include fill;

		opacity: 0.16;
		background-image: var(--tile);
		background-size: 3rem 3rem;
		background-repeat: repeat;
		image-rendering: pixelated;
		mask-image: radial-gradient(85% 85% at 50% 35%, #000, transparent);
	}

	.name {
		position: absolute;
		left: 1.25rem;
		right: 1.25rem;
		bottom: 0.75rem;
		z-index: 2;
		font-size: 1.5rem;
		font-weight: 700;
		line-height: 1.15;
		text-shadow: 0 0.125rem 0.625rem rgba(0, 7, 22, 0.95);
		@include ellipsis;
	}

	.bd {
		padding: 0.875rem 1.25rem 1.125rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		flex: 1;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 0.875rem;
	}

	.state {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.8125rem;
		color: var(--text-secondary);

		&.up {
			color: var(--text-heading);
		}
	}

	// the tick is the only green on the card that is not the uptime strip
	.state.up :global(icon) {
		color: var(--success);
	}

	.ver {
		color: var(--text-secondary);
		font-size: 0.8125rem;
		margin-left: auto;
	}

	.blurb {
		color: var(--text-secondary);
		font-size: 0.8125rem;
		@include ellipsis;
	}

	.meter {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.bar {
		height: 0.375rem;
		border-radius: 0.1875rem;
		background: var(--bg-track);
		overflow: hidden;
		flex: 1;

		i {
			display: block;
			height: 100%;
			border-radius: 0.1875rem;
			background: var(--accent);
		}
	}

	.n {
		font-size: 0.8125rem;
		font-variant-numeric: tabular-nums;
		color: var(--text-heading);
		flex: none;

		span {
			color: var(--text-secondary);
		}
	}
</style>
