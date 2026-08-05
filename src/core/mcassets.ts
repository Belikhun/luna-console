/**
 * Minecraft's own textures, so the selector editor can draw a chest that looks
 * like the chest.
 *
 * Everything here comes from Mojang's published client jar for one pinned
 * version: the container background, every item texture, and the block models
 * themselves; the boxes, faces and UVs the client renders, not an assumption
 * that every block is a cube. The jar is fetched once, the handful of
 * directories that matter are extracted, and a registry maps each item id to
 * what the browser needs to draw it.
 *
 * The pinned version is the newest any managed server runs, which is also the
 * one whose material list is the superset the editor should offer.
 */

import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { root } from "./config";
import { ProgressReporter } from "./progress";
import { download } from "./services/download";
import { readZipEntries, readZipEntry, type ZipEntry } from "./services/zip";
import type {
	GuiTransform,
	ItemRender,
	McAssetRegistry,
	McAssetState,
	ModelDirection,
	ModelElement,
	ModelFace,
	ModelGeometry,
	FontAtlas,
	FontProvider,
	FontUnihexOverride,
} from "../shared/mcassets";
import { MC_REGISTRY_FORMAT } from "../shared/mcassets";
import type { ClusterConfig } from "./types";
import { t } from "../shared/i18n";

export * from "../shared/mcassets";

const VERSION_MANIFEST = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";

/** Where the extracted assets live, one directory per Minecraft version. */
export function assetsDir(version: string): string {
	return join(root(), ".assets", "mc", version);
}

export function registryPath(version: string): string {
	return join(assetsDir(version), "registry.json");
}

/** Compare Minecraft version strings numerically, segment by segment. */
function compareVersions(left: string, right: string): number {
	const parse = (value: string): number[] =>
		value
			.split(/[.\-+]/)
			.map((part) => Number.parseInt(part, 10))
			.map((part) => (Number.isFinite(part) ? part : 0));

	const a = parse(left);
	const b = parse(right);

	for (let index = 0; index < Math.max(a.length, b.length); index++) {
		const diff = (a[index] ?? 0) - (b[index] ?? 0);

		if (diff !== 0) {
			return diff;
		}
	}

	return 0;
}

/**
 * The version whose assets the editor should use: the newest any managed server
 * runs, so every material those servers can name has a texture.
 */
export function pinnedMcVersion(cfg: ClusterConfig): string | undefined {
	const versions = Object.values(cfg.instances)
		.map((inst) => inst.mcVersion)
		.filter((version): version is string => !!version);

	if (versions.length === 0) {
		return undefined;
	}

	return versions.sort(compareVersions)[versions.length - 1];
}

/** Tint types the client resolves from the world, approximated at plains. */
const TINT_APPROXIMATIONS: Record<string, string> = {
	"minecraft:grass": "#91bd59",
	"minecraft:foliage": "#77ab2f",
	"minecraft:dry_foliage": "#a8763a",
	"minecraft:water": "#3f76e4",
};

/** What the console needs to decide between "render sprites" and "offer to build". */
export async function assetState(cfg: ClusterConfig): Promise<McAssetState> {
	const wanted = pinnedMcVersion(cfg);

	if (!wanted) {
		return { present: false };
	}

	const path = registryPath(wanted);

	if (!existsSync(path)) {
		return { wanted, present: false };
	}

	try {
		const registry = (await Bun.file(path).json()) as McAssetRegistry;

		// an index an older build wrote is not one this build can draw from
		if (registry.format !== MC_REGISTRY_FORMAT) {
			return { wanted, present: false };
		}

		const info = await stat(assetsDir(wanted));

		return {
			wanted,
			version: registry.version,
			present: true,
			itemCount: Object.keys(registry.items).length,
			builtAt: registry.builtAt,
			sizeBytes: info.size,
		};
	} catch {
		return { wanted, present: false };
	}
}

interface ManifestEntry {
	id: string;
	url: string;
}

interface VersionDownload {
	version: string;
	url: string;
	sha1?: string;
	/** Where the objects that are not in the jar; unifont; are listed */
	assetIndexUrl?: string;
}

async function resolveClientJarUrl(version: string): Promise<VersionDownload> {
	const manifest = (await (await fetch(VERSION_MANIFEST)).json()) as {
		latest?: { release?: string };
		versions?: ManifestEntry[];
	};

	const versions = manifest.versions ?? [];
	// a cluster can run a version Mojang has withdrawn, or a fork whose number
	// never appeared in the manifest at all; fall back rather than fail
	const entry = versions.find((candidate) => candidate.id === version)
		?? versions.find((candidate) => candidate.id === manifest.latest?.release);

	if (!entry) {
		throw new Error(t("core.mcassets.manifestMissing", { version }));
	}

	const detail = (await (await fetch(entry.url)).json()) as {
		downloads?: { client?: { url?: string; sha1?: string } };
		assetIndex?: { url?: string };
	};

	const url = detail.downloads?.client?.url;

	if (!url) {
		throw new Error(t("core.mcassets.noClientDownload", { version: entry.id }));
	}

	return {
		version: entry.id,
		url,
		sha1: detail.downloads?.client?.sha1,
		assetIndexUrl: detail.assetIndex?.url,
	};
}

/** Where Mojang serves an asset object, addressed by its own hash. */
const RESOURCE_BASE = "https://resources.download.minecraft.net";

interface AssetObject {
	hash: string;
	size: number;
}

/**
 * Fetch the parts of the font that are not in the client jar.
 *
 * Unifont; the fallback that covers every codepoint the bitmap sheets do not,
 * box drawing characters included; is published as an asset object rather than
 * packed into the jar, and the jar is left carrying a stub `include/unifont.json`
 * that declares no providers at all. Extracting only the jar therefore yields a
 * font that silently cannot draw a `▍`, which is exactly the character a selector
 * config uses to rule its description lines. So the real definition and the hex
 * bundle behind it are pulled from the index and the stub is overwritten.
 *
 * The bundles are zipped hex dumps; they are flattened into one `.hex` file each,
 * because the browser asks for single codepoints out of them and a zip is the
 * wrong shape to answer that from.
 */
async function ensureFontObjects(version: string, indexUrl: string | undefined, reporter: ProgressReporter): Promise<void> {
	// the index alone is half a megabyte, and this runs on every registry rebuild
	//; one already-extracted bundle is proof enough that the fetch happened
	if (existsSync(join(assetsDir(version), "font", "unifont.hex"))) {
		return;
	}

	const url = indexUrl ?? (await resolveClientJarUrl(version)).assetIndexUrl;

	if (!url) {
		reporter.say("warn", t("core.mcassets.noAssetIndex"));

		return;
	}

	const index = (await (await fetch(url)).json()) as { objects?: Record<string, AssetObject> };
	const objects = Object.entries(index.objects ?? {}).filter(([name]) => name.startsWith("minecraft/font/"));

	for (const [name, object] of objects) {
		const relative = name.replace("minecraft/", "");
		const source = `${RESOURCE_BASE}/${object.hash.slice(0, 2)}/${object.hash}`;

		if (relative.endsWith(".json")) {
			const target = join(assetsDir(version), relative);
			await mkdir(dirname(target), { recursive: true });
			await download(source, target, { sha1: object.hash });

			continue;
		}

		if (!relative.endsWith(".zip")) {
			continue;
		}

		const target = join(assetsDir(version), relative.replace(/\.zip$/, ".hex"));

		if (existsSync(target)) {
			continue;
		}

		const archive = `${target}.zip`;
		await mkdir(dirname(target), { recursive: true });
		await download(source, archive, { sha1: object.hash });

		const entries = (await readZipEntries(archive)).filter((entry) => entry.name.endsWith(".hex"));
		const parts: string[] = [];

		for (const entry of entries) {
			// the bundle is a few megabytes of text and the whole point of it is
			// that it covers everything, so the limit has to clear the largest one
			const body = await readZipEntry(archive, entry, 32 * 1024 * 1024);

			if (body) {
				parts.push(new TextDecoder().decode(body));
			}
		}

		const bundle = parts.join("\n");
		await writeFile(target, bundle);
		await rm(archive, { force: true });
		reporter.say("info", `${relative} → ${bundle.split("\n").length} glyph(s)`);
	}
}

const EXTRACT_PREFIXES = [
	"assets/minecraft/font/",
	"assets/minecraft/textures/font/",
	"assets/minecraft/models/item/",
	"assets/minecraft/models/block/",
	"assets/minecraft/items/",
	"assets/minecraft/textures/item/",
	"assets/minecraft/textures/block/",
];

const EXTRACT_FILES = ["assets/minecraft/textures/gui/container/generic_54.png"];

function wanted(entry: ZipEntry): boolean {
	if (entry.name.endsWith("/")) {
		return false;
	}

	if (EXTRACT_FILES.includes(entry.name)) {
		return true;
	}

	return EXTRACT_PREFIXES.some((prefix) => entry.name.startsWith(prefix))
		&& (entry.name.endsWith(".json") || entry.name.endsWith(".png"));
}

/** Strip the `assets/minecraft/` prefix so paths read as `textures/item/x.png`. */
function targetPath(version: string, name: string): string {
	return join(assetsDir(version), name.replace("assets/minecraft/", ""));
}

type Json = Record<string, unknown>;

/** Read one of the extracted model files. */
async function readModel(version: string, reference: string): Promise<Json | undefined> {
	const clean = reference.replace(/^minecraft:/, "");
	const path = join(assetsDir(version), "models", `${clean}.json`);

	if (!existsSync(path)) {
		return undefined;
	}

	try {
		return (await Bun.file(path).json()) as Json;
	} catch {
		return undefined;
	}
}

/** The default a block model inherits from `block/block`, if the chain breaks. */
const DEFAULT_GUI_TRANSFORM: GuiTransform = {
	rotation: [30, 225, 0],
	translation: [0, 0, 0],
	scale: [0.625, 0.625, 0.625],
};

const DIRECTIONS: ModelDirection[] = ["down", "up", "north", "south", "west", "east"];

function triple(value: unknown, fallback: [number, number, number]): [number, number, number] {
	if (!Array.isArray(value) || value.length < 3) {
		return fallback;
	}

	const numbers = value.slice(0, 3).map((part) => (typeof part === "number" && Number.isFinite(part) ? part : 0));

	return [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0];
}

/** Read a model's `elements`, dropping anything malformed rather than guessing. */
function parseElements(value: unknown): ModelElement[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}

	const elements: ModelElement[] = [];

	for (const raw of value) {
		if (!raw || typeof raw !== "object") {
			continue;
		}

		const source = raw as Json;
		const faces: Partial<Record<ModelDirection, ModelFace>> = {};
		const rawFaces = (source.faces ?? {}) as Record<string, Json>;

		for (const direction of DIRECTIONS) {
			const face = rawFaces[direction];

			if (!face || typeof face !== "object" || typeof face.texture !== "string") {
				continue;
			}

			const uv = Array.isArray(face.uv) && face.uv.length >= 4
				? (face.uv.slice(0, 4).map(Number) as [number, number, number, number])
				: undefined;

			faces[direction] = {
				texture: face.texture,
				...(uv ? { uv } : {}),
				...(typeof face.rotation === "number" && face.rotation ? { rotation: face.rotation } : {}),
				...(typeof face.tintindex === "number" && face.tintindex >= 0 ? { tinted: true } : {}),
			};
		}

		if (Object.keys(faces).length === 0) {
			continue;
		}

		const element: ModelElement = {
			from: triple(source.from, [0, 0, 0]),
			to: triple(source.to, [16, 16, 16]),
			faces,
		};

		const rotation = source.rotation as Json | undefined;

		if (rotation && typeof rotation.axis === "string" && typeof rotation.angle === "number") {
			element.rotation = {
				origin: triple(rotation.origin, [8, 8, 8]),
				axis: rotation.axis as "x" | "y" | "z",
				angle: rotation.angle,
				...(rotation.rescale === true ? { rescale: true } : {}),
			};
		}

		elements.push(element);
	}

	return elements.length > 0 ? elements : undefined;
}

function parseGuiTransform(value: unknown): GuiTransform | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}

	const source = value as Json;

	return {
		rotation: triple(source.rotation, [0, 0, 0]),
		// the file states translation in pixels; the client divides by 16 and
		// clamps it, so the stored value is already in block units
		translation: triple(source.translation, [0, 0, 0]).map((part) =>
			Math.max(-5, Math.min(5, part / 16))) as [number, number, number],
		scale: triple(source.scale, [1, 1, 1]),
	};
}

interface ResolvedModel {
	parents: string[];
	textures: Record<string, string>;
	elements?: ModelElement[];
	gui?: GuiTransform;
	guiLight?: "front" | "side";
}

/**
 * Walk a model's parent chain, collecting what it takes to draw the thing.
 *
 * A child's textures win over its parent's, and a value like `#all` is a
 * reference to another key in the same map, which is how `cube_all` gives one
 * texture to all six faces. `elements` are not merged; the nearest model that
 * declares any replaces its parent's outright, which is how a stair stops being
 * the cube it descends from.
 */
async function resolveModel(version: string, reference: string, depth = 0): Promise<ResolvedModel> {
	if (depth > 8) {
		return { parents: [], textures: {} };
	}

	const model = await readModel(version, reference);

	if (!model) {
		return { parents: [], textures: {} };
	}

	const parentRef = typeof model.parent === "string" ? (model.parent as string).replace(/^minecraft:/, "") : undefined;
	const inherited: ResolvedModel = parentRef
		? await resolveModel(version, parentRef, depth + 1)
		: { parents: [], textures: {} };

	const own = (model.textures ?? {}) as Record<string, string>;
	const gui = parseGuiTransform((model.display as Json | undefined)?.gui);
	const guiLight = model.gui_light === "front" || model.gui_light === "side"
		? (model.gui_light as "front" | "side")
		: undefined;

	return {
		parents: parentRef ? [parentRef, ...inherited.parents] : inherited.parents,
		textures: { ...inherited.textures, ...own },
		elements: parseElements(model.elements) ?? inherited.elements,
		gui: gui ?? inherited.gui,
		guiLight: guiLight ?? inherited.guiLight,
	};
}

/** Follow `#key` indirection to a real texture path. */
function textureFor(textures: Record<string, string>, keys: string[]): string | undefined {
	for (const key of keys) {
		let value = textures[key];
		let hops = 0;

		// a model may carry a non-string under `textures` (a nested definition in
		// newer formats), which is not a path and must not be followed
		while (typeof value === "string" && value.startsWith("#") && hops < 8) {
			value = textures[value.slice(1)] as string;
			hops++;
		}

		if (typeof value === "string" && value && !value.startsWith("#")) {
			return value.replace(/^minecraft:/, "");
		}
	}

	return undefined;
}

function isGenerated(parents: string[]): boolean {
	return parents.some((parent) => parent.includes("generated") || parent.includes("handheld"));
}

/** FNV-1a, only ever used to give identical geometry the same name. */
function digest(value: string): string {
	let hash = 0x811c9dc5;

	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}

	return hash.toString(36);
}

/**
 * Store a geometry once and hand back its key.
 *
 * The registry would be many megabytes if every stone-shaped block carried its
 * own copy of `block/cube_all`; they are identical, so they share an entry. The
 * counter is only there so a hash collision stays a collision of names, not of
 * shapes.
 */
function intern(table: Record<string, ModelGeometry>, geometry: ModelGeometry): string {
	const encoded = JSON.stringify(geometry);
	const base = digest(encoded);
	let key = base;
	let attempt = 0;

	while (table[key] && JSON.stringify(table[key]) !== encoded) {
		attempt++;
		key = `${base}-${attempt}`;
	}

	table[key] ??= geometry;

	return key;
}

/**
 * The texture map an item's faces need, flattened.
 *
 * Only the keys the geometry actually names are kept; a model's texture map
 * carries entries for faces it does not have, and `particle`, which nothing in
 * an inventory ever draws.
 */
function faceTextures(elements: ModelElement[], textures: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};

	for (const element of elements) {
		for (const face of Object.values(element.faces)) {
			if (!face.texture.startsWith("#")) {
				continue;
			}

			const key = face.texture.slice(1);
			const resolved = textureFor(textures, [key]);

			if (resolved) {
				out[key] = resolved;
			}
		}
	}

	return out;
}

/**
 * Find the model an item definition points at.
 *
 * A definition is a small tree; a plain `model`, or a `select` / `condition` /
 * `range_dispatch` with cases; and every branch of it is a different look for
 * the same item. A preview only needs one, so this takes the first model it
 * finds in document order.
 */
function firstModelRef(node: unknown, depth = 0): string | undefined {
	if (depth > 8 || !node || typeof node !== "object") {
		return undefined;
	}

	if (Array.isArray(node)) {
		for (const item of node) {
			const found = firstModelRef(item, depth + 1);

			if (found) {
				return found;
			}
		}

		return undefined;
	}

	const map = node as Record<string, unknown>;

	if (typeof map.model === "string") {
		return (map.model as string).replace(/^minecraft:/, "");
	}

	for (const value of Object.values(map)) {
		const found = firstModelRef(value, depth + 1);

		if (found) {
			return found;
		}
	}

	return undefined;
}

/** The first tint a definition declares, approximated to a fixed colour. */
function firstTint(node: unknown, depth = 0): string | undefined {
	if (depth > 8 || !node || typeof node !== "object") {
		return undefined;
	}

	if (Array.isArray(node)) {
		for (const item of node) {
			const found = firstTint(item, depth + 1);

			if (found) {
				return found;
			}
		}

		return undefined;
	}

	const map = node as Record<string, unknown>;

	if (Array.isArray(map.tints)) {
		for (const tint of map.tints as Array<Record<string, unknown>>) {
			const type = typeof tint?.type === "string" ? (tint.type as string) : "";
			const approximation = TINT_APPROXIMATIONS[type];

			if (approximation) {
				return approximation;
			}

			if (type === "minecraft:constant" && typeof tint.value === "number") {
				return `#${((tint.value as number) & 0xffffff).toString(16).padStart(6, "0")}`;
			}
		}
	}

	for (const value of Object.values(map)) {
		const found = firstTint(value, depth + 1);

		if (found) {
			return found;
		}
	}

	return undefined;
}

/** Read one of the extracted font definitions. */
async function readFontDefinition(version: string, reference: string): Promise<Json | undefined> {
	const clean = reference.replace(/^minecraft:/, "");
	const path = join(assetsDir(version), "font", `${clean}.json`);

	if (!existsSync(path)) {
		return undefined;
	}

	try {
		return (await Bun.file(path).json()) as Json;
	} catch {
		return undefined;
	}
}

/**
 * Whether a provider is gated behind a client option the console does not have.
 *
 * The filters in the vanilla font are `uniform` (the player forcing the unicode
 * font over the sheets) and `jp` (the Japanese glyph variants). Both are off by
 * default, so a filter asking for one to be *on* describes a font this preview
 * is not showing; `{"uniform": false}` is the ordinary case and is kept.
 */
function gated(entry: Json | undefined): boolean {
	const filter = entry?.filter;

	if (!filter || typeof filter !== "object") {
		return false;
	}

	return Object.values(filter as Record<string, unknown>).some((value) => value === true);
}

/** `size_overrides`, with its characters read as the codepoints they bound. */
function parseSizeOverrides(value: unknown): FontUnihexOverride[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}

	const overrides: FontUnihexOverride[] = [];

	for (const raw of value) {
		const entry = raw as Json;
		const from = typeof entry?.from === "string" ? (entry.from as string).codePointAt(0) : undefined;
		const to = typeof entry?.to === "string" ? (entry.to as string).codePointAt(0) : undefined;

		if (from === undefined || to === undefined || typeof entry.left !== "number" || typeof entry.right !== "number") {
			continue;
		}

		overrides.push({ from, to, left: entry.left as number, right: entry.right as number });
	}

	return overrides.length > 0 ? overrides : undefined;
}

/**
 * Flatten the game's font definition into the sheets a browser can draw from.
 *
 * `default.json` is mostly references to other files, and the order they resolve
 * to is the order the client asks them for a glyph; first one that has it wins,
 * which is why the list is kept flat and in sequence rather than keyed by page.
 *
 * A `unihex` provider is kept as a pointer rather than as glyphs: the bundle
 * behind it is eight megabytes and a hundred and fourteen thousand characters,
 * so the browser asks for the few codepoints a preview actually reaches for.
 * `ttf` providers are dropped outright; nothing in a selector uses them.
 */
async function buildFont(version: string, reference = "default", depth = 0): Promise<FontProvider[]> {
	if (depth > 4) {
		return [];
	}

	const definition = await readFontDefinition(version, reference);
	const raw = Array.isArray(definition?.providers) ? (definition.providers as Json[]) : [];
	const providers: FontProvider[] = [];

	for (const entry of raw) {
		if (gated(entry)) {
			continue;
		}

		if (entry?.type === "reference" && typeof entry.id === "string") {
			providers.push(...(await buildFont(version, entry.id, depth + 1)));

			continue;
		}

		if (entry?.type === "space" && entry.advances && typeof entry.advances === "object") {
			providers.push({ kind: "space", advances: entry.advances as Record<string, number> });

			continue;
		}

		if (entry?.type === "unihex" && typeof entry.hex_file === "string") {
			const file = (entry.hex_file as string)
				.replace(/^minecraft:/, "")
				.replace(/^font\//, "")
				.replace(/\.zip$/, "");

			// the bundle is fetched separately from the jar, and a version that
			// publishes none leaves the provider pointing at nothing
			if (!existsSync(join(assetsDir(version), "font", `${file}.hex`))) {
				continue;
			}

			providers.push({ kind: "unihex", file, sizeOverrides: parseSizeOverrides(entry.size_overrides) });

			continue;
		}

		if (entry?.type !== "bitmap" || typeof entry.file !== "string" || !Array.isArray(entry.chars)) {
			continue;
		}

		providers.push({
			kind: "bitmap",
			file: (entry.file as string).replace(/^minecraft:/, "").replace(/\.png$/, ""),
			rows: (entry.chars as unknown[]).map((row) => String(row)),
			ascent: typeof entry.ascent === "number" ? entry.ascent : 7,
			height: typeof entry.height === "number" ? entry.height : 8,
		});
	}

	return providers;
}

/**
 * Decide how each item is drawn.
 *
 * Newer jars describe items in `assets/minecraft/items/*.json`, which point at a
 * model that for a block item lives under `models/block/`; `models/item/` has
 * no entry for it at all. Older jars only have `models/item/`. Both layouts are
 * accepted, because the pinned version is whatever the cluster happens to run.
 */
async function buildRegistry(version: string, reporter: ProgressReporter): Promise<McAssetRegistry> {
	const itemsDir = join(assetsDir(version), "items");
	const modelsDir = join(assetsDir(version), "models", "item");
	const definitions = existsSync(itemsDir);
	const source = definitions ? itemsDir : modelsDir;
	const names = existsSync(source)
		? (await readdir(source)).filter((name) => name.endsWith(".json")).map((name) => name.replace(/\.json$/, ""))
		: [];

	const items: Record<string, ItemRender> = {};
	const geometries: Record<string, ModelGeometry> = {};
	let done = 0;

	for (const name of names) {
		let reference = `item/${name}`;
		let tint: string | undefined;

		if (definitions) {
			try {
				const definition = (await Bun.file(join(itemsDir, `${name}.json`)).json()) as Json;
				reference = firstModelRef(definition) ?? reference;
				tint = firstTint(definition);
			} catch {
				// a definition we cannot read leaves the item on its conventional path
			}
		}

		const resolved = await resolveModel(version, reference);
		let render: ItemRender = { kind: "unknown" };

		const layers: string[] = [];

		// a generated model is a stack of sprites the client composes itself: the
		// potion's liquid over its bottle, the spawn egg's spots over its shell
		for (let index = 0; index < 8; index++) {
			const layer = textureFor(resolved.textures, [`layer${index}`]);

			if (!layer) {
				break;
			}

			layers.push(layer);
		}

		if (layers.length > 0 && isGenerated([reference, ...resolved.parents])) {
			render = { kind: "flat", layers };
		} else if (resolved.elements) {
			const geometry: ModelGeometry = {
				elements: resolved.elements,
				gui: resolved.gui ?? DEFAULT_GUI_TRANSFORM,
				guiLight: resolved.guiLight ?? "side",
			};

			render = {
				kind: "model",
				geometry: intern(geometries, geometry),
				textures: faceTextures(resolved.elements, resolved.textures),
			};
		} else if (layers.length > 0) {
			render = { kind: "flat", layers };
		}

		if (tint && render.kind !== "unknown") {
			render.tint = tint;
		}

		items[name.toUpperCase()] = render;
		done++;

		if (done % 250 === 0) {
			reporter.report(done / Math.max(1, names.length), "info", `${done}/${names.length} items`);
		}
	}

	const providers = await buildFont(version);
	const font: FontAtlas | undefined = providers.length > 0 ? { providers } : undefined;

	return {
		format: MC_REGISTRY_FORMAT,
		version,
		builtAt: new Date().toISOString(),
		items,
		geometries,
		...(font ? { font } : {}),
	};
}

/**
 * Make sure the pinned version's assets are on disk, downloading them if not.
 *
 * The registry is derived from the extracted files, so a change to how items are
 * indexed only invalidates the registry; the jar behind it is still the same
 * jar, and re-fetching thirty megabytes to re-read files already on disk would
 * be silly. A stale `format` therefore rebuilds the index in place.
 *
 * @param opts.force re-download and re-extract even when the assets are present
 * @returns the state the console reads back
 */
export async function ensureMcAssets(
	cfg: ClusterConfig,
	opts: { version?: string; force?: boolean; reporter?: ProgressReporter } = {},
): Promise<McAssetState> {
	const wantedVersion = opts.version ?? pinnedMcVersion(cfg);

	if (!wantedVersion) {
		throw new Error(t("core.mcassets.noVersionAnywhere"));
	}

	const progress = opts.reporter ?? new ProgressReporter("minecraft assets");
	progress.weighOwn(0);

	if (!opts.force && existsSync(join(assetsDir(wantedVersion), "models", "block"))) {
		const current = await assetState(cfg);

		if (current.present) {
			progress.complete(t("core.mcassets.alreadyExtracted", { version: wantedVersion }));

			return current;
		}

		const fonts = progress.child("Font objects", 1);
		const indexing = progress.child("Item registry", 1);

		await ensureFontObjects(wantedVersion, undefined, fonts);
		fonts.complete(t("core.mcassets.fontsPresent"));

		const rebuilt = await buildRegistry(wantedVersion, indexing);
		await Bun.write(registryPath(wantedVersion), JSON.stringify(rebuilt));
		indexing.complete(t("core.mcassets.reindexed", { count: Object.keys(rebuilt.items).length }));

		return await assetState(cfg);
	}

	const locating = progress.child("Version manifest", 1);
	const fetching = progress.child("Client jar", 6);
	const extracting = progress.child("Extract", 2);
	const fonts = progress.child("Font objects", 1);
	const indexing = progress.child("Item registry", 1);

	const target = await resolveClientJarUrl(wantedVersion);

	if (target.version !== wantedVersion) {
		locating.say("warn", t("core.mcassets.notInManifest", { wanted: wantedVersion, using: target.version }));
	} else {
		locating.complete(target.version);
	}

	const version = target.version;
	const dir = assetsDir(version);
	await mkdir(dir, { recursive: true });

	const jarPath = join(dir, "client.jar");
	await fetching.task({ start: `downloading ${version} client`, done: "client jar downloaded" }, async () => {
		await download(target.url, jarPath, target.sha1 ? { sha1: target.sha1 } : {});
	});

	const entries = (await readZipEntries(jarPath)).filter(wanted);
	let written = 0;

	for (const entry of entries) {
		// a texture is a few hundred bytes; the limit only ever trips on something
		// that is not what we asked for
		const body = await readZipEntry(jarPath, entry, 4 * 1024 * 1024);

		if (!body) {
			continue;
		}

		const path = targetPath(version, entry.name);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, body);
		written++;

		if (written % 500 === 0) {
			extracting.report(written / Math.max(1, entries.length), "info", `${written}/${entries.length} files`);
		}
	}

	extracting.complete(t("core.mcassets.extracted", { count: written }));
	await rm(jarPath, { force: true });

	await fonts.task({ start: "fetching unifont", done: "font assets present" }, async () => {
		await ensureFontObjects(version, target.assetIndexUrl, fonts);
	});

	const registry = await buildRegistry(version, indexing);
	await Bun.write(registryPath(version), JSON.stringify(registry));
	indexing.complete(t("core.mcassets.indexed", { count: Object.keys(registry.items).length }));

	return await assetState(cfg);
}

/** Read the registry for the pinned version, when it has been built. */
export async function readRegistry(cfg: ClusterConfig): Promise<McAssetRegistry | undefined> {
	const version = pinnedMcVersion(cfg);

	if (!version || !existsSync(registryPath(version))) {
		return undefined;
	}

	return (await Bun.file(registryPath(version)).json()) as McAssetRegistry;
}

/**
 * Resolve a texture path to a file, refusing anything that tries to leave the
 * assets directory.
 */
/** Where an extracted unihex bundle lives, refusing anything but a plain name. */
export function unihexPath(version: string, file: string): string | undefined {
	if (!/^[a-z0-9_-]+$/i.test(file)) {
		return undefined;
	}

	return join(assetsDir(version), "font", `${file}.hex`);
}

export function texturePath(version: string, relative: string): string | undefined {
	if (!/^[a-z0-9_/-]+\.png$/i.test(relative) || relative.includes("..")) {
		return undefined;
	}

	return join(assetsDir(version), "textures", relative);
}
