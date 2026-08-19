// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * What the page may ask of an embedded map, whichever map it is.
 *
 * The two providers are not the same kind of program. BlueMap is a WebGL scene
 * with a camera, render distances and three view modes; Dynmap is a Leaflet page
 * with tiles and a zoom level. So the contract is not a lowest common
 * denominator - that would throw away most of BlueMap - but a superset with a
 * declared capability set: a link says what it can do, the controls draw that and
 * nothing else, and a control that would be dead is absent rather than disabled.
 *
 * Everything a link does is best-effort and returns whether it landed. The map is
 * somebody else's build running in an iframe and its internals are not a
 * contract; a missing field leaves its control out instead of throwing.
 */

/** Camera modes a map may offer; only BlueMap has more than one. */
export type MapView = 'perspective' | 'flat' | 'free';

/** A group of controls a link can back. */
export type MapCapability =
	/** camera modes */
	| 'view'
	/** render resolution */
	| 'quality'
	/** near/far tile distances */
	| 'detail'
	/** sunlight and ambient strength */
	| 'light'
	/** free-flight mouse settings */
	| 'flight'
	/** the chunk grid overlay */
	| 'chunkBorders'
	/** save the canvas as an image */
	| 'screenshot'
	/** throw the tile cache away */
	| 'reloadTiles'
	/** put the map's own settings back */
	| 'resetSettings'
	/** step the camera in and out */
	| 'zoom'
	/** put the camera back where the map opens */
	| 'recenter'
	/** lock the camera to a player */
	| 'follow'
	/** several renders of the same world, e.g. Dynmap's flat/surface/cave */
	| 'styles';

/** Everything the controls render from. A detached link reports `ready: false`. */
export interface MapState {
	ready: boolean;
	/** the map is still streaming tiles in */
	loading: boolean;
	/** id of the world currently shown */
	map: string;
	view: MapView;
	/** the modes this map declares; a flat-only map offers one */
	views: MapView[];
	quality: number;
	hires: number;
	hiresMin: number;
	hiresMax: number;
	lowres: number;
	lowresMin: number;
	lowresMax: number;
	sunlight: number;
	ambient: number;
	/** hires tiles keep loading while the camera moves */
	loadWhileMoving: boolean;
	chunkBorders: boolean;
	mouseSensitivity: number;
	invertMouse: boolean;
	/** uuid of the player the camera is locked to, empty when free */
	following: string;
	/** uuids with a live marker, so a row can say whether it is followable */
	markedPlayers: string[];
	/**
	 * Renders of the current world the visitor can switch between, and which is on.
	 *
	 * Dynmap's own idea of a "map": one world carries a flat render, an isometric
	 * surface render and a cave render, and they are the same place drawn three
	 * ways. BlueMap has no equivalent and reports none.
	 */
	styles: Array<{ id: string; label: string }>;
	style: string;
}

/** The state a link reports before it has attached to anything. */
export function emptyMapState(): MapState {
	return {
		ready: false,
		loading: false,
		map: '',
		view: 'perspective',
		views: [],
		quality: 1,
		hires: 0,
		hiresMin: 50,
		hiresMax: 500,
		lowres: 0,
		lowresMin: 500,
		lowresMax: 10_000,
		sunlight: 0,
		ambient: 0,
		loadWhileMoving: true,
		chunkBorders: false,
		mouseSensitivity: 1,
		invertMouse: false,
		following: '',
		markedPlayers: [],
		styles: [],
		style: ''
	};
}

/**
 * The page's handle on an embedded map.
 *
 * Every verb is optional to *support* but not to declare: a link implements the
 * whole interface and answers false from what it cannot do, so the controls need
 * no null checks and the capability set is the single place that decides what is
 * drawn.
 */
export interface MapLink {
	readonly state: MapState;
	/** What this link can actually do; the controls render by this */
	readonly caps: ReadonlySet<MapCapability>;

	/** Watch an iframe until its map has booted; returns a detach function */
	attach(frame: HTMLIFrameElement): () => void;
	detach(): void;
	/** Re-read the map's own values into `state` */
	read(): void;

	/** Show a different world without reloading the application */
	switchMap(map: string): boolean;
	/** Show a different render of the world currently on screen */
	switchStyle(style: string): boolean;
	/** Step the view; -1 moves closer and 1 moves away, as BlueMap counts it */
	zoom(direction: 1 | -1): boolean;
	resetCamera(): boolean;
	setView(view: MapView): boolean;
	setQuality(quality: number): boolean;
	setHires(distance: number): boolean;
	setLowres(distance: number): boolean;
	setSunlight(value: number): boolean;
	setAmbient(value: number): boolean;
	setLoadWhileMoving(on: boolean): boolean;
	setChunkBorders(on: boolean): boolean;
	setMouseSensitivity(value: number): boolean;
	setInvertMouse(on: boolean): boolean;
	screenshot(): boolean;
	reloadTiles(): boolean;
	resetSettings(): boolean;
	followPlayer(uuid: string): Promise<boolean>;
	stopFollowing(): boolean;
}

/** How often a link probes for its application while the page boots. */
export const PROBE_MS = 250;

/** Give up after this long; a map that has not booted by now is not going to. */
export const PROBE_TIMEOUT_MS = 30_000;

/**
 * How often a link re-reads the map's own values.
 *
 * Pulled rather than pushed: neither provider exposes anything Svelte can
 * subscribe to. Always, not only while the settings panel is open, because the
 * world switcher and the online list both read state the map changes on its own -
 * a followed player walking into the nether moves the map out from under us - and
 * a pull of a dozen values once a second is not worth making conditional.
 */
export const REFRESH_MS = 1000;
