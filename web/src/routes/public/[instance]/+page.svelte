<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { onMount } from 'svelte';

	import { t } from '$lib/i18n.svelte';
	import { fmtDuration } from '$lib/format';
	import { followPublic } from '$lib/public.svelte';
	import { BlueMapLink } from '$lib/bluemap.svelte';
	import { tilePatternUrl } from '$lib/components/mcassets';
	import CopyValue from '$lib/components/CopyValue.svelte';
	import Gauge from '$lib/components/Gauge.svelte';
	import ProgressBar from '$lib/components/ProgressBar.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import MiniMessageText from '$lib/components/MiniMessageText.svelte';
	import PlayerSkin from '$lib/components/PlayerSkin.svelte';
	import UptimeTimeline from '$lib/components/UptimeTimeline.svelte';
	import MapControls from '../MapControls.svelte';
	import type { PublicInstanceCard, PublicSnapshot } from '$core/publicsite';

	let { data } = $props();

	/**
	 * One server, presented as its own map with the readouts floating over it.
	 *
	 * The map is the page rather than a panel on it: this is the thing a visitor
	 * came to look at, and a world render boxed into a card is a screenshot. The
	 * panels are pulled to the corners so the middle stays the world.
	 */
	let live: PublicSnapshot | null = $state(null);

	/**
	 * This server's row, from the stream when it has one and from the load
	 * otherwise.
	 *
	 * Derived rather than assigned, so moving between two servers re-resolves
	 * against the name the loader just handed over; a `$state` seeded from `data`
	 * would keep showing the server the visitor came from.
	 */
	const snapshot = $derived(live ?? data.snapshot);

	const card: PublicInstanceCard = $derived(
		snapshot.instances.find((instance) => instance.name === data.card.name) ?? data.card
	);

	// the whole snapshot streams, so the dials move without a second endpoint
	onMount(() => followPublic((frame) => (live = frame)));

	interface OnlinePlayer {
		uuid: string;
		username: string;
		sessionMillis: number;
	}

	let players: OnlinePlayer[] = $state([]);
	let worlds: string[] = $state([]);
	let world = $state('');

	/**
	 * The document the iframe loads, assigned once per instance.
	 *
	 * Deliberately not derived from `world`: re-assigning `src` reloads the whole
	 * application, and a world switch goes through `BlueMapLink` instead, which
	 * moves the camera without throwing the loaded tiles away.
	 */
	let mapSrc = $state('');
	let frame: HTMLIFrameElement | undefined = $state();
	let hud: HTMLElement | undefined = $state();

	const link = new BlueMapLink();

	/**
	 * Which world is on screen.
	 *
	 * BlueMap's own answer wins over the one this page last asked for: following a
	 * player through a portal switches the map without going through the switcher,
	 * and a pressed state that still names the overworld would be lying.
	 */
	const shown = $derived(link.state.ready && link.state.map ? link.state.map : world);

	/** The server's own block, tiled behind a server that has no rendered world. */
	let tile: string | null = $state(null);

	$effect(() => {
		const material = data.card.hasMap ? undefined : data.card.icon;
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

	// re-attached when the document changes, not only when the element does: the
	// element survives an instance change, the application inside it does not
	$effect(() => {
		const element = frame;
		const src = mapSrc;

		if (!element || !src) {
			return;
		}

		return link.attach(element);
	});

	/**
	 * Show a different world.
	 *
	 * Through the link when it has one, which keeps the page and the camera alive;
	 * by reloading the frame at that world's hash when it does not, which is what
	 * happens if BlueMap has not finished booting yet.
	 */
	/**
	 * Lock the map onto a player, or let go of the one it is holding.
	 *
	 * The whole row is the control rather than a button inside it: following is
	 * the only thing there is to do with a name on this list, so the name may as
	 * well be the thing you click.
	 */
	async function follow(uuid: string): Promise<void> {
		if (link.state.following === uuid) {
			link.stopFollowing();

			return;
		}

		await link.followPlayer(uuid);
	}

	function selectWorld(name: string): void {
		if (name === world) {
			return;
		}

		world = name;

		if (!link.switchMap(name)) {
			mapSrc = `${mapBase}/index.html#${name}`;
		}
	}

	const accent = $derived(card.accentColor ?? 'var(--link)');
	const mapBase = $derived(`/api/public/map/${encodeURIComponent(card.name)}`);

	/** 20 is the ceiling, so the dial's tone falls as the reading falls. */
	const tpsTone = $derived(
		card.tps === null ? 'accent' : card.tps >= 19.5 ? 'success' : card.tps >= 18 ? 'warning' : 'danger'
	);

	const HUD_UPTIME_DAYS = 90;

	/**
	 * Entities across every world, or null when nothing counted them.
	 *
	 * Summed only when at least one half was measured: a backend reporting neither
	 * should leave the readout out rather than show a server holding nothing.
	 */
	const entityTotal = $derived(
		card.tickingEntities === null && card.nonTickingEntities === null
			? null
			: (card.tickingEntities ?? 0) + (card.nonTickingEntities ?? 0)
	);

	const tickingPct = $derived(entityTotal ? ((card.tickingEntities ?? 0) / entityTotal) * 100 : 0);

	const hasLoad = $derived(
		card.chunks !== null || entityTotal !== null || card.apdex !== null || card.misery !== null
	);

	/** The proxy reports sessions live; a slower poll than the snapshot is fine. */
	const PLAYER_POLL_MS = 15_000;

	// keyed on the instance rather than mounted once: moving between two servers
	// reuses this component, and a list left over from the previous one would be
	// worse than an empty panel
	$effect(() => {
		const name = data.card.name;
		let alive = true;

		const load = async (): Promise<void> => {
			try {
				const response = await fetch(`/api/public/online/${encodeURIComponent(name)}`);

				if (response.ok && alive) {
					players = ((await response.json()) as { players: OnlinePlayer[] }).players;
				}
			} catch {
				// the list is a nicety; the page stands without it
			}
		};

		players = [];
		void load();

		const timer = setInterval(() => void load(), PLAYER_POLL_MS);

		return () => {
			alive = false;
			clearInterval(timer);
		};
	});

	// the worlds come from /art rather than from BlueMap's own settings.json,
	// because that file lists them in no useful order; /art has already sorted
	// them the way BlueMap's menu does, so the switcher opens on the overworld
	// instead of whichever map happens to be first
	$effect(() => {
		const name = data.card.name;
		const hasMap = data.card.hasMap;
		let alive = true;

		worlds = [];
		world = '';
		mapSrc = '';

		if (!hasMap) {
			return;
		}

		void (async () => {
			let resolved = '';

			try {
				const response = await fetch(`/api/public/map/${encodeURIComponent(name)}/art`);

				if (response.ok) {
					const art = (await response.json()) as { worlds?: string[]; map?: string };

					worlds = art.worlds ?? [];
					resolved = art.map ?? worlds[0] ?? '';
				}
			} catch {
				// no world switcher, but the map itself still loads at its default
			}

			if (!alive) {
				return;
			}

			world = resolved;

			// `index.html` rather than the bare directory: the webapp's own paths are
			// relative to the document, and SvelteKit strips a trailing slash, which
			// would send every asset request one level too high. The world goes in
			// the hash, which is where BlueMap reads it from.
			mapSrc = resolved
				? `${mapBase}/index.html#${resolved}`
				: `${mapBase}/index.html`;
		})();

		return () => {
			alive = false;
		};
	});
</script>

<svelte:head>
	<title>{card.name}</title>
</svelte:head>

<div class="hud" bind:this={hud} style:--accent={accent}>
	{#if card.hasMap && mapSrc}
		<iframe
			bind:this={frame}
			class="map"
			src={mapSrc}
			title={t('web.public.liveMap')}
		></iframe>
	{:else}
		<div class="nomap" class:tiled={!!tile} style:--tile={tile ? `url("${tile}")` : 'none'}></div>
	{/if}

	<div class="scrim"></div>

	<div class="tl">
		<a class="back" href="/public" aria-label={t('web.public.allServers')}>
			<Icon name="left" style="solid" size="1rem" />
		</a>
		<div>
			<div class="title"><MiniMessageText source={card.display} inline /></div>
			<div class="sub">
				<span class="state" class:up={card.online}>
					<Icon name={card.online ? 'circleCheck' : 'ban'} style="solid" size="0.8125rem" />
					{card.online ? t('web.public.online') : t('web.public.offline')}
				</span>
				{#if card.uptimeMs}<span>{fmtDuration(card.uptimeMs)}</span>{/if}
				<!-- BlueMap's own "loading" message is part of the chrome the link
				     hides, so the state it was reporting is said here instead -->
				{#if link.state.loading}<span>{t('web.public.map.loading')}</span>{/if}
			</div>
		</div>
	</div>

	<div class="tr">
		{#if worlds.length > 1}
			<div class="worlds glass" role="group" aria-label={t('web.public.worlds')}>
				{#each worlds as name (name)}
					<button aria-pressed={shown === name} onclick={() => selectWorld(name)}>{name}</button>
				{/each}
			</div>
		{/if}
		{#if snapshot.site.address}
			<CopyValue value={snapshot.site.address} label={t('web.public.address')} chip />
		{/if}
	</div>

	<div class="bl glass">
		<div class="dials">
			<Gauge
				value={card.players}
				max={Math.max(1, card.maxPlayers ?? 1)}
				display={String(card.players ?? 0)}
				label={t('web.public.players')}
				footnote={t('web.public.ofCapacity', { max: String(card.maxPlayers ?? 0) })}
				color="accent"
				size="7.5rem"
			/>
			<Gauge
				value={card.tps}
				max={20}
				display={card.tps === null ? undefined : card.tps.toFixed(1)}
				label={t('web.public.tps')}
				footnote={t('web.public.ofTwenty')}
				color={tpsTone}
				size="7.5rem"
			/>
			<!-- the uptime dial used to sit here; the 90-day timeline right below says
			     what it said, in more detail, so this is CPU and heap instead -->
			<Gauge
				value={card.cpu}
				label={t('web.public.cpu')}
				footnote={t('web.public.ofOneCore')}
				size="7.5rem"
			/>
			<Gauge
				value={card.memUsedMb}
				max={Math.max(1, card.memMaxMb ?? 1)}
				display={card.memUsedMb === null ? undefined : `${(card.memUsedMb / 1024).toFixed(1)} GB`}
				label={t('web.public.memory')}
				footnote={card.memMaxMb === null
					? undefined
					: t('web.public.ofMemory', { max: (card.memMaxMb / 1024).toFixed(0) })}
				size="7.5rem"
			/>
		</div>

		{#if hasLoad}
			<div class="load">
				{#if card.chunks !== null}
					<div class="stat">
						<div class="k">{t('web.public.chunks')}</div>
						<div class="v">{card.chunks.toLocaleString()}</div>
					</div>
				{/if}
				{#if entityTotal !== null}
					<div class="stat wide">
						<div class="k">{t('web.public.entities')}</div>
						<div class="v">{entityTotal.toLocaleString()}</div>
						<!-- the split is the point: a world is fine holding ten thousand of
						     them if nine thousand are frozen -->
						<div class="bar"><i style:width="{tickingPct}%"></i></div>
						<div class="legend">
							<span class="on">{t('web.public.ticking', { n: String(card.tickingEntities ?? 0) })}</span>
							<span>{t('web.public.idle', { n: String(card.nonTickingEntities ?? 0) })}</span>
						</div>
					</div>
				{/if}
			</div>

			{#if card.apdex !== null || card.misery !== null}
				<div class="indices">
					{#if card.apdex !== null}
						<ProgressBar
							value={card.apdex * 100}
							left={t('web.public.apdex')}
							right={card.apdex.toFixed(3)}
							segmented
							height="2rem"
							color={card.apdex >= 0.95 ? 'success' : card.apdex >= 0.85 ? 'warning' : 'danger'}
						/>
					{/if}
					{#if card.misery !== null}
						<!-- the one bar here where full is bad, so the tone runs the other way -->
						<ProgressBar
							value={card.misery * 100}
							left={t('web.public.misery')}
							right={`${(card.misery * 100).toFixed(1)}%`}
							segmented
							height="2rem"
							color={card.misery <= 0.02 ? 'success' : card.misery <= 0.1 ? 'warning' : 'danger'}
						/>
					{/if}
				</div>
			{/if}
		{/if}

		<div class="uprow">
			<div class="k">{t('web.public.uptime')}</div>
			<UptimeTimeline
				days={card.uptime.days}
				pct={card.uptime.pct}
				count={HUD_UPTIME_DAYS}
				height="2rem"
			/>
		</div>

		<div class="facts">
			<div class="fact">
				<div class="k">{t('web.public.version')}</div>
				<div class="v">{card.software}{card.mcVersion ? ` ${card.mcVersion}` : ''}</div>
			</div>
			{#if worlds.length}
				<div class="fact">
					<div class="k">{t('web.public.worlds')}</div>
					<div class="v">{worlds.length}</div>
				</div>
			{/if}
			{#if snapshot.site.address}
				<div class="fact">
					<div class="k">{t('web.public.address')}</div>
					<div class="v">
						<CopyValue value={snapshot.site.address} label={t('web.public.address')} />
					</div>
				</div>
			{/if}
		</div>
	</div>

	<!-- one bottom-aligned column rather than two corner panels: the map controls
	     and the player list are both on this side, and either can grow -->
	<div class="right">
		<MapControls {link} fullscreenTarget={hud} />

		<div class="br glass">
			<div class="hdr">
				<Icon name="users" style="solid" size="0.875rem" />
				<span>{t('web.public.onlineNow')}</span>
				<span class="c">{card.players ?? 0}/{card.maxPlayers ?? 0}</span>
			</div>

			<div class="players">
				{#each players as player (player.uuid)}
					{@const followable = link.state.markedPlayers.includes(player.uuid)}
					{@const following = link.state.following === player.uuid}
					<button
						class="player"
						class:following
						disabled={!followable}
						aria-pressed={following}
						title={followable
							? t(following ? 'web.public.map.stopFollowing' : 'web.public.map.follow')
							: t('web.public.map.notOnMap')}
						onclick={() => void follow(player.uuid)}
					>
						<PlayerSkin player={player.uuid} px={4} endpoint="/api/public/players" />
						<span class="n">{player.username}</span>
						{#if following}
							<Icon name="circleDot" style="solid" size="0.75rem" />
						{/if}
						<span class="s">{fmtDuration(player.sessionMillis)}</span>
					</button>
				{:else}
					<p class="empty">{t('web.public.nobodyOnline')}</p>
				{/each}
			</div>
		</div>
	</div>
</div>

<style lang="scss">
	.hud {
		position: fixed;
		inset: 0;
		overflow: hidden;
		background: #0b1017;
	}

	.map,
	.nomap {
		@include fill;

		width: 100%;
		height: 100%;
		border: 0;
		z-index: 0;
	}

	.nomap {
		background:
			radial-gradient(
				90% 90% at 50% 40%,
				color-mix(in srgb, var(--accent) 20%, transparent),
				transparent 70%
			),
			var(--bg-body);
	}

	// the same block the card wears, at the same scale; a server with no rendered
	// world still gets a backdrop that says which server it is
	.nomap.tiled::after {
		content: '';

		@include fill;

		opacity: 0.12;
		background-image: var(--tile);
		background-size: 4rem 4rem;
		background-repeat: repeat;
		image-rendering: pixelated;
		mask-image: radial-gradient(70% 70% at 50% 45%, #000, transparent);
	}

	// keeps the panels readable over bright terrain without hiding the map, and
	// lets every click through to the map underneath
	.scrim {
		@include fill;

		z-index: 1;
		pointer-events: none;
		background:
			linear-gradient(
				to bottom,
				rgba(11, 16, 23, 0.72) 0%,
				transparent 22%,
				transparent 62%,
				rgba(11, 16, 23, 0.82) 100%
			),
			radial-gradient(120% 90% at 50% 50%, transparent 40%, rgba(11, 16, 23, 0.55) 100%);
	}

	.tl,
	.tr,
	.bl,
	.right {
		position: absolute;
		z-index: 2;
	}

	.glass {
		@include glass;
	}

	.tl {
		left: 1.5rem;
		top: 1.5rem;
		display: flex;
		align-items: center;
		gap: 1rem;
	}

	.back {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 50%;
		border: var(--hairline) solid var(--border-nav);
		background: rgba(17, 23, 31, 0.76);
		backdrop-filter: blur(0.75rem);
		color: var(--text-heading);
		flex: none;
		z-index: 2;

		&:hover {
			background: var(--bg-hover);
		}
	}

	.title {
		font-size: 2rem;
		font-weight: 700;
		line-height: 1.1;
		text-shadow: 0 0.125rem 0.75rem rgba(0, 7, 22, 0.95);
	}

	.sub {
		color: var(--text-secondary);
		font-size: 0.8125rem;
		display: flex;
		align-items: center;
		gap: 0.625rem;
	}

	.state {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;

		&.up {
			color: var(--text-heading);
		}

		&.up :global(icon) {
			color: var(--success);
		}
	}

	.tr {
		right: 1.5rem;
		top: 1.5rem;
		display: flex;
		gap: 0.625rem;
		align-items: center;
	}

	.worlds {
		display: flex;
		gap: 0.25rem;
		padding: 0.25rem;

		button {
			@include bare-button;

			color: var(--text-secondary);
			font-size: 0.8125rem;
			height: 2rem;
			padding: 0 0.875rem;
			border-radius: var(--radius-button);

			&[aria-pressed='true'] {
				background: var(--bg-hover);
				color: var(--text-heading);
				font-weight: 600;
			}
		}
	}

	.bl {
		left: 1.5rem;
		bottom: 1.5rem;
		padding: 1rem 1.25rem 0.875rem;
		width: 38rem;
		max-width: calc(100vw - 3rem);
	}

	.dials {
		display: flex;
		gap: 1.5rem;
		justify-content: center;
		flex-wrap: wrap;
	}

	.load {
		display: flex;
		gap: 1.5rem;
		margin-top: 1rem;

		.stat {
			flex: none;

			&.wide {
				flex: 1;
				min-width: 0;
			}
		}

		.k {
			font-size: 0.75rem;
			text-transform: uppercase;
			letter-spacing: 0.06em;
			font-weight: 600;
			color: var(--text-label);
		}

		.v {
			font-size: 1.25rem;
			font-weight: 700;
			color: var(--text-heading);
			font-variant-numeric: tabular-nums;
			line-height: 1.2;
		}

		.bar {
			height: 0.375rem;
			border-radius: 0.1875rem;
			background: var(--bg-track);
			overflow: hidden;
			margin-top: 0.375rem;

			i {
				display: block;
				height: 100%;
				border-radius: 0.1875rem;
				background: var(--accent);
			}
		}

		.legend {
			display: flex;
			gap: 0.75rem;
			margin-top: 0.25rem;
			font-size: 0.75rem;
			color: var(--text-secondary);

			.on {
				color: var(--accent);
			}
		}
	}

	// flex rather than two grid columns: with only one index reported - which is
	// every server nobody is playing on, since misery needs players to exist - a
	// fixed second column would leave the bar stranded across half the panel
	.indices {
		display: flex;
		gap: 1.5rem;
		margin-top: 1rem;

		> :global(*) {
			flex: 1;
			min-width: 0;
		}
	}

	.uprow {
		margin-top: 1rem;

		.k {
			font-size: 0.8125rem;
			font-weight: 700;
			color: var(--text-heading);
			margin-bottom: 0.375rem;
		}
	}

	.facts {
		display: flex;
		margin-top: 0.875rem;
		border-top: var(--hairline) solid var(--border-divider);
		padding-top: 0.75rem;
	}

	.fact {
		padding: 0 1rem;
		border-right: var(--hairline) solid var(--border-divider);
		min-width: 0;

		&:first-child {
			padding-left: 0;
		}

		&:last-child {
			border-right: 0;
			padding-right: 0;
		}

		.k {
			font-size: 0.8125rem;
			font-weight: 700;
			color: var(--text-heading);
		}

		.v {
			margin-top: 0.125rem;
			color: var(--text);
			font-size: 0.8125rem;
			font-family: var(--font-mono);
		}
	}

	// bottom-aligned, so the rail and the player list sit above the fold and the
	// settings panel takes whatever height is left rather than covering them
	.right {
		right: 1.5rem;
		top: 5.5rem;
		bottom: 1.5rem;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		justify-content: flex-end;
		gap: 0.75rem;
		pointer-events: none;

		// the column spans the viewport to do its layout, so only the panels in it
		// take clicks; the rest of that strip is still map
		> :global(*) {
			pointer-events: auto;
		}
	}

	.br {
		width: 19rem;
		max-height: 60vh;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		flex: none;
	}

	.hdr {
		padding: 0.75rem 1rem;
		border-bottom: var(--hairline) solid var(--border-divider);
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-weight: 700;
		color: var(--text-heading);
		font-size: 0.875rem;

		.c {
			margin-left: auto;
			color: var(--text-secondary);
			font-weight: 400;
			font-variant-numeric: tabular-nums;
		}
	}

	.players {
		overflow-y: auto;
		padding: 0.375rem;
	}

	.player {
		@include bare-button;

		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.3125rem 0.625rem;
		border-radius: var(--radius-input);
		width: 100%;
		text-align: left;

		&:hover:not(:disabled) {
			background: var(--bg-hover);
		}

		&:focus-visible {
			@include focus-ring;
		}

		// nothing to follow: the map has not seen them, which happens for a player
		// on a server whose world is not rendered
		&:disabled {
			cursor: default;
		}

		&.following {
			background: color-mix(in srgb, var(--accent) 20%, transparent);

			.n {
				color: var(--accent);
			}
		}

		:global(icon) {
			color: var(--accent);
			flex: none;
		}

		.n {
			color: var(--text-heading);
			font-size: 0.875rem;
			@include ellipsis;
		}

		.s {
			margin-left: auto;
			color: var(--text-secondary);
			font-size: 0.75rem;
			font-variant-numeric: tabular-nums;
			flex: none;
		}
	}

	.empty {
		margin: 0;
		padding: 0.75rem 0.625rem;
		color: var(--text-secondary);
		font-size: 0.8125rem;
	}

	// the panels stack over each other long before this, so the narrow layout
	// drops the player list and lets the readouts span the width
	@include below($bp-medium) {
		.br {
			display: none;
		}

		// the readouts span the width down here, so the controls move to the top
		// right rather than sitting on top of them
		.right {
			bottom: auto;
			justify-content: flex-start;
		}

		.bl {
			right: 1.5rem;
			width: auto;
		}
	}
</style>
