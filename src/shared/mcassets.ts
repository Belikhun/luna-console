/**
 * How Minecraft's own assets describe an item, in the shape both sides use.
 *
 * The daemon builds this out of the client jar and the browser draws from it,
 * so the two must agree on every field — hence one definition rather than a
 * copy on each side.
 */

/** The six faces a model element can carry. */
export type ModelDirection = "down" | "up" | "north" | "south" | "west" | "east";

export interface ModelFace {
	/** A `#key` into the item's texture map, or an already-resolved path */
	texture: string;
	/** [u1, v1, u2, v2] in the texture's own 0–16 space; derived from the box when absent */
	uv?: [number, number, number, number];
	/** 0/90/180/270, rotating the texture within the face */
	rotation?: number;
	/** The face takes the item's tint — the grass on a grass block, not its dirt */
	tinted?: boolean;
}

export interface ModelElementRotation {
	origin: [number, number, number];
	axis: "x" | "y" | "z";
	angle: number;
	rescale?: boolean;
}

/** One box of a model, in Minecraft's 0–16 model space. */
export interface ModelElement {
	from: [number, number, number];
	to: [number, number, number];
	rotation?: ModelElementRotation;
	faces: Partial<Record<ModelDirection, ModelFace>>;
}

export interface GuiTransform {
	/** Degrees, composed X then Y then Z the way the client composes them */
	rotation: [number, number, number];
	/** In blocks, already divided down from the pixels the model file states */
	translation: [number, number, number];
	scale: [number, number, number];
}

/**
 * The geometry an item is drawn from, together with the transform the inventory
 * views it through.
 *
 * Shared between items: thousands of blocks are `block/cube_all` with different
 * textures, so the registry stores each distinct geometry once and every item
 * that uses it points at the same entry.
 */
export interface ModelGeometry {
	elements: ModelElement[];
	/** `display.gui` — a stair's is not a cube's, which is why it is carried */
	gui: GuiTransform;
	/** `front` means the client lights the model flat instead of as a solid */
	guiLight: "front" | "side";
}

/** How an item is drawn: a flat sprite, or a model composed of boxes. */
export interface ItemRender {
	kind: "flat" | "model" | "unknown";
	/** flat: the sprite layers, bottom one first */
	layers?: string[];
	/** model: a key into the registry's shared geometry table */
	geometry?: string;
	/** model: `#key` → texture path, for the faces to resolve against */
	textures?: Record<string, string>;
	/**
	 * Multiply colour for the tinted faces — the grass on a grass block, the green
	 * of leaves. Minecraft computes these from the biome at render time; a preview
	 * only needs the plains value, and without one the texture reads as grey.
	 */
	tint?: string;
}

/**
 * One of the sheets the game's own font is drawn from.
 *
 * A page is a grid of cells, one row of `rows` per grid row and one character
 * per cell. The cell is scaled to `height` game pixels and hung so its top edge
 * sits `ascent` pixels above the baseline — `accented` is a taller sheet than
 * `ascii` and lines up with it only because of those two numbers.
 *
 * How wide each glyph actually is is not stated anywhere: the client measures it
 * off the pixels, and so does the browser, which already has the sheet decoded.
 */
export interface FontBitmapProvider {
	kind: "bitmap";
	/** texture path without its extension, e.g. `font/ascii` */
	file: string;
	/** one string per grid row, a character per cell */
	rows: string[];
	ascent: number;
	height: number;
}

/** Characters the font gives a width to and draws nothing for. */
export interface FontSpaceProvider {
	kind: "space";
	advances: Record<string, number>;
}

/** A range whose glyph bounds are dictated rather than measured off the pixels. */
export interface FontUnihexOverride {
	from: number;
	to: number;
	left: number;
	right: number;
}

/**
 * The fallback the game reaches for when no sheet covers a codepoint.
 *
 * Unifont is not a sheet but a hex dump: one line per codepoint, sixteen rows of
 * bits, eight or sixteen columns wide. There are a hundred and fourteen thousand
 * of them and the file is nearly eight megabytes, so the browser is never handed
 * the bundle — it asks for the handful of codepoints a preview actually needs.
 *
 * The glyphs are drawn at half size: a sixteen-row bitmap becomes eight game
 * pixels tall, which is what puts unifont's own baseline (its fourteenth row) on
 * the same line as `ascii`'s.
 */
export interface FontUnihexProvider {
	kind: "unihex";
	/** The extracted bundle's name, e.g. `unifont` for `font/unifont.hex` */
	file: string;
	/** CJK and friends are drawn full-width whatever their pixels say */
	sizeOverrides?: FontUnihexOverride[];
}

export type FontProvider = FontBitmapProvider | FontSpaceProvider | FontUnihexProvider;

export interface FontAtlas {
	/**
	 * In the client's own priority order: the first provider that has a glyph for
	 * a codepoint is the one that draws it.
	 */
	providers: FontProvider[];
}

/**
 * Bumped whenever the registry's shape changes, so a daemon carrying newer code
 * rebuilds an index an older one wrote instead of handing the browser fields it
 * no longer understands.
 */
export const MC_REGISTRY_FORMAT = 4;

export interface McAssetRegistry {
	/** Compared against `MC_REGISTRY_FORMAT` before the index is trusted */
	format: number;
	version: string;
	builtAt: string;
	items: Record<string, ItemRender>;
	/** Every distinct geometry, keyed by content — items reference these */
	geometries: Record<string, ModelGeometry>;
	/** The game's own font, so previewed text is set in it rather than near it */
	font?: FontAtlas;
}

export interface McAssetState {
	/** The version the editor wants, from the cluster */
	wanted?: string;
	/** The version actually extracted, when one is */
	version?: string;
	present: boolean;
	itemCount?: number;
	builtAt?: string;
	sizeBytes?: number;
}

/** Normalise whatever an admin typed into a registry key. */
export function materialKey(material: string | undefined): string {
	return (material ?? "").trim().toUpperCase().replace(/^MINECRAFT:/, "");
}

/** How to draw a material, falling back to a barrier the way the plugin does. */
export function renderFor(registry: McAssetRegistry | null, material: string | undefined): ItemRender | null {
	if (!registry) {
		return null;
	}

	return registry.items[materialKey(material)] ?? registry.items.BARRIER ?? null;
}
