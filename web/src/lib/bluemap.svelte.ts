// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Driving the embedded BlueMap from the page around it.
 *
 * BlueMap is a whole application in an iframe, with its own chrome: a burger
 * menu top left, zoom buttons and a compass top right, a settings page inside
 * that menu. On the public page those land underneath our own panels and arrive
 * in a different visual language, so the visitor gets two overlapping HUDs and
 * can reach neither properly.
 *
 * The map is proxied through this origin (`/api/public/map/...`), so the iframe
 * is same-origin and its `window.bluemap` is simply readable. This wraps the
 * parts of that object worth exposing, and the page draws the controls itself.
 *
 * Everything here is defensive on purpose: BlueMap is somebody else's build and
 * its internals are not a contract. A field that is not there leaves its control
 * out rather than throwing, and failing to attach at all leaves BlueMap's own
 * chrome visible, which is a working map with the wrong buttons rather than a
 * map with no buttons.
 */

import {
	emptyMapState,
	PROBE_MS,
	PROBE_TIMEOUT_MS,
	REFRESH_MS,
	type MapCapability,
	type MapLink,
	type MapState,
	type MapView
} from '$lib/maplink';

export type { MapView };

/** What `superSampling` means; BlueMap's own three resolution stages. */
export const MAP_QUALITIES = [
	{ value: 0.5, label: 'web.public.map.qualityLow' },
	{ value: 1, label: 'web.public.map.qualityNormal' },
	{ value: 2, label: 'web.public.map.qualityHigh' }
] as const;

/**
 * Everything BlueMap can back, which is every group the controls know about bar
 * one: it has no second render of the same world, so no style switcher.
 */
const CAPS: ReadonlySet<MapCapability> = new Set<MapCapability>([
	'view',
	'quality',
	'detail',
	'light',
	'flight',
	'chunkBorders',
	'screenshot',
	'reloadTiles',
	'resetSettings',
	'zoom',
	'recenter',
	'follow'
]);

/**
 * Hides BlueMap's own chrome once we have taken over.
 *
 * `#app` is only the Vue overlay: the canvas, the marker layer and the stats
 * panel all live in `#map-container`, so this hides the buttons and nothing that
 * draws the world.
 */
const TAKEOVER_CSS = '#app { display: none !important; }';

/** Steps BlueMap's own zoom buttons move by. */
const ZOOM_STEP = 3;

/** Marker set BlueMap puts its live player markers in. */
const PLAYER_SET = 'bm-players';

export class BlueMapLink implements MapLink {
	/** What the controls render from; replaced wholesale so Svelte sees it. */
	state: MapState = $state(emptyMapState());

	readonly caps = CAPS;

	#app: any = null;
	#frame: HTMLIFrameElement | null = null;
	#probe: ReturnType<typeof setInterval> | undefined;
	#refresh: ReturnType<typeof setInterval> | undefined;
	#since = 0;

	/**
	 * Watch an iframe until its BlueMap has booted, then take its chrome over.
	 *
	 * Returns a detach function, so a page can hand it straight back from an
	 * effect and get the timers cleaned up when the instance changes.
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

	/** Show a different world without reloading the whole application. */
	switchMap(map: string): boolean {
		return this.#call(() => {
			void this.#app.switchMap(map);
		});
	}

	/**
	 * Nothing to switch: BlueMap renders one view of a world and the camera modes
	 * are what change how it looks, which is `setView`.
	 */
	switchStyle(): boolean {
		return false;
	}

	/** Move the camera in or out by one of BlueMap's own zoom steps. */
	zoom(direction: 1 | -1): boolean {
		return this.#call(() => {
			const zoomer = this.#app.mapViewer.controlsManager.controls?.mouseZoom;

			if (zoomer) {
				zoomer.deltaZoom += direction * ZOOM_STEP;
			}
		});
	}

	/** Put the camera back where the map opens. */
	resetCamera(): boolean {
		return this.#call(() => this.#app.resetCamera());
	}

	/** Switch camera mode; the map decides which modes it has. */
	setView(view: MapView): boolean {
		return this.#call(() => {
			// the second argument is the angle BlueMap eases to, and it only differs
			// coming out of free flight, where the camera may be pointing anywhere
			const from = this.state.view === 'free' ? 100 : 0;

			if (view === 'perspective') {
				this.#app.setPerspectiveView(500, from);
			} else if (view === 'flat') {
				this.#app.setFlatView(500, from);
			} else {
				this.#app.setFreeFlight(500);
			}
		}, true);
	}

	/** Render resolution, as a `superSampling` multiplier. */
	setQuality(quality: number): boolean {
		return this.#call(() => {
			this.#app.mapViewer.superSampling = quality;
			this.#app.mapViewer.redraw();
		}, true);
	}

	/** How far detailed tiles are loaded around the camera. */
	setHires(distance: number): boolean {
		return this.#call(() => {
			this.#app.mapViewer.loadedHiresViewDistance = distance;
			this.#app.mapViewer.updateLoadedMapArea();
		}, true);
	}

	/** How far the coarse tiles reach; this is what makes the horizon. */
	setLowres(distance: number): boolean {
		return this.#call(() => {
			this.#app.mapViewer.loadedLowresViewDistance = distance;
			this.#app.mapViewer.updateLoadedMapArea();
		}, true);
	}

	/** Strength of the directional light, 0 to 1. */
	setSunlight(value: number): boolean {
		return this.#call(() => {
			this.#app.mapViewer.data.uniforms.sunlightStrength.value = value;
			this.#app.mapViewer.redraw();
		}, true);
	}

	/** Strength of the fill light, 0 to 1; this is what lifts caves out of black. */
	setAmbient(value: number): boolean {
		return this.#call(() => {
			this.#app.mapViewer.data.uniforms.ambientLight.value = value;
			this.#app.mapViewer.redraw();
		}, true);
	}

	/** Keep hires tiles loading while the camera moves. */
	setLoadWhileMoving(on: boolean): boolean {
		return this.#call(() => {
			// BlueMap stores the opposite, and its own label is the double negative;
			// this is the direction a person reads
			this.#app.appState.controls.pauseTileLoading = !on;
		}, true);
	}

	/** Draw the chunk grid over the world. */
	setChunkBorders(on: boolean): boolean {
		return this.#call(() => this.#app.setChunkBorders(on), true);
	}

	/** How fast the mouse turns the camera in free flight. */
	setMouseSensitivity(value: number): boolean {
		return this.#call(() => {
			this.#app.appState.controls.mouseSensitivity = value;
			this.#app.updateControlsSettings();
		}, true);
	}

	/** Invert the vertical axis in free flight. */
	setInvertMouse(on: boolean): boolean {
		return this.#call(() => {
			this.#app.appState.controls.invertMouse = on;
			this.#app.updateControlsSettings();
		}, true);
	}

	/** Save the canvas as a PNG; BlueMap also copies it to the clipboard. */
	screenshot(): boolean {
		return this.#call(() => this.#app.takeScreenshot());
	}

	/**
	 * Throw the tile cache away and load the world again.
	 *
	 * What a visitor wants after a render finishes on the server: the browser is
	 * holding tiles it was told to cache hard, and nothing else expires them.
	 */
	reloadTiles(): boolean {
		return this.#call(() => {
			void this.#app.updateMap();
		});
	}

	/** Put every map setting back to the server's defaults; this reloads BlueMap. */
	resetSettings(): boolean {
		return this.#call(() => this.#app.resetSettings());
	}

	/**
	 * Lock the camera to a player and keep it there.
	 *
	 * The player may be in a world other than the one on screen, which is what
	 * `foreign` means and why this switches maps first; without that the camera
	 * ends up at their coordinates in the wrong dimension, which is a hole in the
	 * ground rather than a person. Returns false when they have no live marker,
	 * which is the answer for a player the map has not seen yet.
	 */
	async followPlayer(uuid: string): Promise<boolean> {
		if (!this.#app) {
			return false;
		}

		try {
			const manager = this.#app.mapViewer.controlsManager;
			let marker = this.#playerMarker(uuid);

			if (!marker) {
				return false;
			}

			manager.controls?.stopFollowingPlayerMarker?.();

			if (marker.foreign) {
				const target = await this.#app.findPlayerMap(uuid);

				if (!target) {
					return false;
				}

				await this.#app.switchMap(target.data.id);

				// switching maps rebuilds the marker layer, so the object taken above
				// belongs to a scene that no longer exists
				marker = this.#playerMarker(uuid) ?? marker;
			}

			if (marker.visible) {
				manager.controls?.followPlayerMarker?.(marker);
			}

			manager.position.copy(marker.position);
			this.read();

			return true;
		} catch {
			return false;
		}
	}

	/** Release the camera. */
	stopFollowing(): boolean {
		return this.#call(() => {
			this.#app.mapViewer.controlsManager.controls?.stopFollowingPlayerMarker?.();
		});
	}

	/** One player's live marker, whatever shape the set holds its markers in. */
	#playerMarker(uuid: string): any {
		return this.#playerMarkers().find((marker) => marker?.playerUuid === uuid);
	}

	#playerMarkers(): any[] {
		const sets = this.#app?.mapViewer?.markers?.data?.markerSets;

		if (!Array.isArray(sets)) {
			return [];
		}

		const players = sets.find((set: any) => set?.id === PLAYER_SET);
		const markers = players?.markers;

		if (Array.isArray(markers)) {
			return markers;
		}

		return markers ? Object.values(markers) : [];
	}

	/** Pull BlueMap's current values into the snapshot the controls render. */
	read(): void {
		if (!this.#app) {
			return;
		}

		try {
			const viewer = this.#app.mapViewer;
			const data = viewer?.data;
			const map = data?.map;
			const limits = this.#app.settings ?? {};
			const controls = this.#app.appState?.controls ?? {};
			// on the *controls*, not on the manager: the manager's own data is the
			// camera, and only the map controls know about a followed marker
			const followed = viewer?.controlsManager?.controls?.data?.followingPlayer;

			const views: MapView[] = [];

			if (map?.perspectiveView) {
				views.push('perspective');
			}

			if (map?.flatView) {
				views.push('flat');
			}

			if (map?.freeFlightView) {
				views.push('free');
			}

			this.state = {
				ready: true,
				loading: data?.mapState === 'loading',
				map: map?.id ?? '',
				view: (this.#app.appState?.controls?.state as MapView) ?? 'perspective',
				views,
				quality: Number(data?.superSampling ?? 1),
				hires: Number(data?.loadedHiresViewDistance ?? 0),
				hiresMin: Number(limits.hiresSliderMin ?? 50),
				hiresMax: Number(limits.hiresSliderMax ?? 500),
				lowres: Number(data?.loadedLowresViewDistance ?? 0),
				lowresMin: Number(limits.lowresSliderMin ?? 500),
				lowresMax: Number(limits.lowresSliderMax ?? 10_000),
				sunlight: Number(data?.uniforms?.sunlightStrength?.value ?? 0),
				ambient: Number(data?.uniforms?.ambientLight?.value ?? 0),
				loadWhileMoving: !controls.pauseTileLoading,
				chunkBorders: Boolean(data?.uniforms?.chunkBorders?.value),
				mouseSensitivity: Number(controls.mouseSensitivity ?? 1),
				invertMouse: Boolean(controls.invertMouse),
				following: String(followed?.playerUuid ?? ''),
				markedPlayers: this.#playerMarkers()
					.map((marker) => String(marker?.playerUuid ?? ''))
					.filter(Boolean),
				styles: [],
				style: ''
			};
		} catch {
			// the iframe navigated out from under us; the next probe re-attaches
			this.#app = null;
			this.state = emptyMapState();
		}
	}

	/**
	 * Run something against BlueMap, then re-read.
	 *
	 * `persist` writes the change to BlueMap's own stored settings, so a visitor
	 * who comes back finds the render distance they chose. A camera move is not
	 * persisted, because it lives in the address instead.
	 */
	#call(action: () => void, persist = false): boolean {
		if (!this.#app) {
			return false;
		}

		try {
			action();

			if (persist) {
				this.#app.saveUserSettings?.();
			}

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
			app = (this.#frame?.contentWindow as any)?.bluemap;
		} catch {
			// same-origin is what makes any of this possible, and the proxy is what
			// makes it same-origin; if that ever stops being true, BlueMap keeps its
			// own chrome and the map still works
			return;
		}

		// `mapViewer.data.map` is the last thing to arrive: the app exists long
		// before it has a world, and reading the view modes off nothing would report
		// a map with no camera modes at all
		if (!doc || !app?.mapViewer?.data?.map) {
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
