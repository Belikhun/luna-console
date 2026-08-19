// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Driving the embedded Dynmap from the page around it.
 *
 * The same arrangement as `BlueMapLink` and for the same reason: Dynmap ships a
 * full HUD of its own - a sidebar of worlds, players and layers, a zoom rail, a
 * clock - which lands under this page's panels in a completely different visual
 * language. The map is proxied through this origin, so the iframe is same-origin
 * and its `window.dynmap` is simply readable; this wraps the parts worth
 * exposing and the page draws the controls itself.
 *
 * Dynmap can do far less than BlueMap and that is the whole point of the
 * capability set: it is Leaflet over a tile pyramid, so there is no camera, no
 * render distance and no lighting to offer. What it does have and BlueMap does
 * not is several renders of the same world - flat, isometric surface, cave - and
 * that is the one capability going the other way.
 *
 * Everything here is defensive on purpose: Dynmap is somebody else's build and
 * its internals are not a contract. A field that is not there leaves its control
 * out rather than throwing, and failing to attach at all leaves Dynmap's own
 * chrome visible, which is a working map with the wrong buttons rather than a map
 * with no buttons.
 */

import {
	emptyMapState,
	PROBE_MS,
	PROBE_TIMEOUT_MS,
	REFRESH_MS,
	type MapCapability,
	type MapLink,
	type MapState
} from '$lib/maplink';

/**
 * What Dynmap can back.
 *
 * `reloadTiles` is in: Leaflet can be told to re-request every tile, which is
 * what a visitor wants after a render finishes on the server. `screenshot` is
 * not: the tiles are `<img>` elements from this origin, so a canvas could be
 * assembled, but Dynmap has no such call of its own and inventing one here would
 * be a screenshot feature disguised as a link.
 */
const CAPS: ReadonlySet<MapCapability> = new Set<MapCapability>([
	'zoom',
	'recenter',
	'follow',
	'reloadTiles',
	'styles'
]);

/**
 * Hides Dynmap's own chrome once we have taken over.
 *
 * Everything listed is UI: the sidebar of worlds and players, the zoom rail
 * Leaflet draws, the clock and the coordinate readout. `#mcmap` itself and the
 * Leaflet panes inside it are what draw the world, and they stay.
 */
const TAKEOVER_CSS = `
	.largeclock, .timeofday, .coord-control, .dynmap .leaflet-control-container,
	.dynmap .sidebar, .dynmap .hitbar, #toggle-sidebar { display: none !important; }
	.dynmap, #mcmap { background: transparent !important; }
`;

/** Levels Dynmap's own zoom buttons move by. */
const ZOOM_STEP = 1;

/**
 * Every camera move is made without Leaflet's animation.
 *
 * Not a preference: inside the embed, an animated `setZoom` silently does
 * nothing. Leaflet's zoom animation asks the browser for a CSS transition on the
 * tile pane and waits to be told it finished, and in this frame it never is - the
 * call returns, `_animatingZoom` goes back to false and the zoom is simply where
 * it was, which reads as a dead button. The unanimated path sets the view
 * outright and always lands.
 */
const NO_ANIMATION = { animate: false } as const;

export class DynmapLink implements MapLink {
	/** What the controls render from; replaced wholesale so Svelte sees it. */
	state: MapState = $state(emptyMapState());

	readonly caps = CAPS;

	#app: any = null;
	#frame: HTMLIFrameElement | null = null;
	#probe: ReturnType<typeof setInterval> | undefined;
	#refresh: ReturnType<typeof setInterval> | undefined;
	#since = 0;

	/**
	 * Watch an iframe until its Dynmap has booted, then take its chrome over.
	 *
	 * Returns a detach function, so a page can hand it straight back from an effect
	 * and get the timers cleaned up when the instance changes.
	 */
	attach(frame: HTMLIFrameElement): () => void {
		this.detach();

		this.#frame = frame;
		this.#since = 0;

		this.#probe = setInterval(() => this.#tryAttach(), PROBE_MS);
		this.#refresh = setInterval(() => this.read(), REFRESH_MS);
		this.#tryAttach();

		return () => this.detach();
	}

	/** Drop the link and every timer it owns. */
	detach(): void {
		clearInterval(this.#probe);
		clearInterval(this.#refresh);

		this.#probe = undefined;
		this.#refresh = undefined;
		this.#app = null;
		this.#frame = null;
		this.state = emptyMapState();
	}

	/**
	 * Show a different world.
	 *
	 * `selectWorld` takes Dynmap into that world's own default render, which is the
	 * right behaviour: a world's flat map and its cave map are not interchangeable
	 * and the one it opens with is the one its operator configured.
	 */
	switchMap(map: string): boolean {
		return this.#call(() => this.#app.selectWorld(map));
	}

	/** Show a different render of the world already on screen. */
	switchStyle(style: string): boolean {
		return this.#call(() => {
			const target = this.#app.world?.maps?.[style];

			if (target) {
				this.#app.selectMap(target);
			}
		});
	}

	/** Step Leaflet's zoom, which is what Dynmap's own buttons do. */
	zoom(direction: 1 | -1): boolean {
		return this.#call(() => {
			// the interface counts -1 as closer and Leaflet counts a higher zoom as
			// closer, so the sign flips; Dynmap's own `zoomReverse` is about tile file
			// names and does not reach the map object
			const target = this.#app.map.getZoom() - direction * ZOOM_STEP;

			this.#app.map.setZoom(target, NO_ANIMATION);
		});
	}

	/**
	 * Put the camera back on the world's spawn.
	 *
	 * Dynmap has no "reset camera": it opens where its configuration says and
	 * forgets. Panning to the world's own centre is the same gesture, and the
	 * centre is what the configuration is naming.
	 */
	resetCamera(): boolean {
		return this.#call(() => {
			const centre = this.#app.world?.center;
			const projection = this.#app.getProjection?.();

			if (centre && projection) {
				const target = projection.fromLocationToLatLng(centre);

				this.#app.map.setView(target, this.#app.map.getZoom(), NO_ANIMATION);
			}
		});
	}

	/** Re-request every tile Leaflet is holding. */
	reloadTiles(): boolean {
		return this.#call(() => {
			this.#app.maptype?.redraw?.();
		});
	}

	/**
	 * Lock the view onto a player.
	 *
	 * Dynmap follows by panning and then keeping the pan up as the player's marker
	 * moves, so this is a single call and the map does the rest. Returns false for
	 * a player with no marker, which is the answer for somebody the map has not
	 * seen: `players` is keyed by account name rather than uuid, so the lookup goes
	 * through the marker list the state already carries.
	 */
	async followPlayer(uuid: string): Promise<boolean> {
		if (!this.#app) {
			return false;
		}

		const player = this.#player(uuid);

		if (!player) {
			return false;
		}

		return this.#call(() => this.#app.followPlayer(player));
	}

	/** Release the view. */
	stopFollowing(): boolean {
		return this.#call(() => this.#app.followPlayer(null));
	}

	// -- everything Dynmap has no equivalent for ---------------------------------

	setView(): boolean {
		return false;
	}

	setQuality(): boolean {
		return false;
	}

	setHires(): boolean {
		return false;
	}

	setLowres(): boolean {
		return false;
	}

	setSunlight(): boolean {
		return false;
	}

	setAmbient(): boolean {
		return false;
	}

	setLoadWhileMoving(): boolean {
		return false;
	}

	setChunkBorders(): boolean {
		return false;
	}

	setMouseSensitivity(): boolean {
		return false;
	}

	setInvertMouse(): boolean {
		return false;
	}

	screenshot(): boolean {
		return false;
	}

	resetSettings(): boolean {
		return false;
	}

	/** Pull Dynmap's current values into the snapshot the controls render. */
	read(): void {
		if (!this.#app) {
			return;
		}

		try {
			const world = this.#app.world;
			const maps: Record<string, any> = world?.maps ?? {};
			const following = this.#app.followingPlayer;

			this.state = {
				...emptyMapState(),
				ready: true,
				map: String(world?.name ?? ''),
				styles: Object.values(maps)
					.filter((entry) => entry?.options?.name)
					.map((entry) => ({
						id: String(entry.options.name),
						// its own `title` is what the sidebar shows; the internal name is
						// the fallback, because a map may be configured without one
						label: String(entry.options.title || entry.options.name)
					})),
				style: String(this.#app.maptype?.options?.name ?? ''),
				following: String(this.#playerUuid(following) ?? ''),
				markedPlayers: this.#players()
					.map((player) => String(this.#playerUuid(player) ?? ''))
					.filter(Boolean)
			};
		} catch {
			// the iframe navigated out from under us; the next probe re-attaches
			this.#app = null;
			this.state = emptyMapState();
		}
	}

	/** Dynmap's own player objects, whatever shape it is holding them in. */
	#players(): any[] {
		const players = this.#app?.players;

		if (Array.isArray(players)) {
			return players;
		}

		return players ? Object.values(players) : [];
	}

	/**
	 * A player's uuid as Dynmap reports it.
	 *
	 * Dynmap keys its players by account name and only carries the uuid when the
	 * server sent one, which is why this is a lookup rather than a field read: the
	 * console's own online list is keyed by uuid, and matching on names would
	 * follow the wrong person on a cracked server.
	 */
	#playerUuid(player: any): string | undefined {
		const uuid = player?.uuid ?? player?.account;

		return typeof uuid === 'string' && uuid.includes('-') ? uuid : undefined;
	}

	#player(uuid: string): any {
		return this.#players().find((player) => this.#playerUuid(player) === uuid);
	}

	/** Run something against Dynmap, then re-read. */
	#call(action: () => void): boolean {
		if (!this.#app) {
			return false;
		}

		try {
			action();
			this.read();

			return true;
		} catch {
			return false;
		}
	}

	#tryAttach(): void {
		this.#since += PROBE_MS;

		if (this.#since > PROBE_TIMEOUT_MS) {
			clearInterval(this.#probe);
			this.#probe = undefined;

			return;
		}

		let doc: Document | null | undefined;
		let app: any;

		try {
			doc = this.#frame?.contentDocument;
			app = (this.#frame?.contentWindow as any)?.dynmap;
		} catch {
			// same-origin is what makes any of this possible, and the proxy is what
			// makes it same-origin; if that ever stops being true, Dynmap keeps its own
			// chrome and the map still works
			return;
		}

		// `world` is the last thing to arrive: the object exists as soon as the page
		// runs, but it has no world until its configuration has been fetched, and
		// reading the render list off nothing would report a map with no renders
		if (!doc || !app?.world || !app?.map) {
			return;
		}

		clearInterval(this.#probe);
		this.#probe = undefined;
		this.#app = app;

		const style = doc.createElement('style');
		style.textContent = TAKEOVER_CSS;
		doc.head.appendChild(style);

		this.read();
	}
}
