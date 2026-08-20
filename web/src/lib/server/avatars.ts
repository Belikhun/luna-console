// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The avatar service: a URL in, a PNG out.
 *
 * It answers the same shape of request as the hosted renderer luna-messenger
 * used to point at (`/<render>/<size>/<subject>.png`), so a webhook's avatar
 * URL only changes host. Everything behind it is ours: the skin comes from the
 * cluster's own record of the player, the pixels are drawn by
 * `imaging/render.ts`, and a render survives a restart in the disk cache. The
 * point is that a Discord message showing a player's face does not depend on a
 * third-party service being up, or on it tolerating our request volume.
 *
 * It sits in the web server rather than in `core/` because it is presentation
 * of something already public: a route needs the bytes, and moving several
 * hundred kilobytes of finished PNG over the daemon socket per Discord message
 * would buy nothing. The one thing it does ask the daemon for is the player's
 * profile, through the same bridge everything else uses.
 */

import { error } from '@sveltejs/kit';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { root } from '$core/config';
import { decodePng, encodePng } from './imaging/png';
import { processSkin, skinModel } from './imaging/skin';
import { renderAvatar, RENDER_MODES, type RenderKind, type RenderOptions } from './imaging/render';
import { playerSkin, textureSkin, type SkinSource } from './skins';

/** Renders, plus the two endpoints that hand back a skin instead of a render. */
export type AvatarKind = RenderKind | 'skin' | 'processedskin';

const RENDER_KINDS: RenderKind[] = ['face', 'front', 'frontfull', 'head', 'bust', 'full'];

/**
 * Mojang's own default skins, by texture id.
 *
 * A texture id is the SHA-256 of the file, so these are references to art that
 * stays on Mojang's texture server and is fetched on first use; nothing of
 * theirs is stored in this repository. The names are the ones the hosted
 * service accepts, minus its `X-` prefix, which is also accepted.
 */
const BUILTIN_SKINS: Record<string, string> = {
	steve: '31f477eb1a7beee631c2ca64d06f8f68fa93a3386d04452ab27f43acdf1b60cb',
	alex: '46acd06e8483b176e8ea39fc12fe105eb3a2a4970f5100057e9d84d4b60bdfa7',
	ari: '4c05ab9e07b3505dc3ec11370c3bdce5570ad2fb2b562e9b9dd9cf271f81aa44',
	efe: 'daf3d88ccb38f11f74814e92053d92f7728ddb1a7955652a60e30cb27ae6659f',
	kai: 'e5cdc3243b2153ab28a159861be643a4fc1e3c17d291cdd3e57a7f370ad676f3',
	makena: 'dc0fcfaf2aa040a83dc0de4e56058d1bbb2ea40157501f3e7d15dc245e493095',
	noor: '90e75cd429ba6331cd210b9bd19399527ee3bab467b5a9f61cb8a27b177f6789',
	sunny: 'a3bd16079f764cd541e072e888fe43885e711f98658323db0f9a6045da91ee7a',
	zuri: 'f5dddb41dcafef616e959c2817808e0be741c89ffbfed39134a13e75b811863d',
	'legacy-steve': '1a4af718455d4aab528e7a61f86fa25e6a369d1768dcb13f7df319a713eb810b',
	'legacy-alex': 'fb9ab3483f8106ecc9e76bd47c71312b0f16a58784d606864f3b3e9cb1fd7b6c',
	'classic-steve': '74961b1ea0826d71cb7090fdc105c815e4ec51f57b056aa5a641621ebf80e804'
};

/**
 * The nine current defaults, in the order a UUID picks from.
 *
 * The client chooses a player's default skin from their UUID, and so do we, so
 * that a player with no skin at least always looks like the same person. The
 * choice is ours: it is not promised to land on the same one the client picks.
 */
const DEFAULT_BY_UUID = ['alex', 'ari', 'efe', 'kai', 'makena', 'noor', 'steve', 'sunny', 'zuri'];

/** Height used when the URL leaves the size out. */
const DEFAULT_HEIGHT = 128;

/** Sizes round up to a multiple of this, so that near-misses share a cache entry. */
const SIZE_STEP = 8;

/** Renders held in memory, and the budget that decides when the oldest goes. */
const MEMORY_BUDGET_BYTES = 64 * 1024 * 1024;

const memory = new Map<string, Buffer>();
let memoryBytes = 0;

/** Renders in flight, so a burst of joins draws each avatar once. */
const inFlight = new Map<string, Promise<Buffer>>();

interface AvatarRequest {
	kind: AvatarKind;
	height: number;
	subject: string;
	/** Set only when the URL insisted on a model with ?slim or ?wide */
	model?: 'slim' | 'wide';
	/** Everything but the arm width, which the skin itself usually decides */
	options: Omit<RenderOptions, 'slim'>;
}

function cacheDir(): string {
	return join(root(), '.cache', 'avatars');
}

function digest(key: string): string {
	return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

function remember(key: string, body: Buffer): void {
	memory.set(key, body);
	memoryBytes += body.byteLength;

	while (memoryBytes > MEMORY_BUDGET_BYTES) {
		const oldest = memory.keys().next();

		if (oldest.done) {
			break;
		}

		memoryBytes -= memory.get(oldest.value)?.byteLength ?? 0;
		memory.delete(oldest.value);
	}
}

/** Java's `UUID.hashCode`, which is how a UUID chooses a default skin. */
function uuidHash(uuid: string): number {
	const hex = uuid.replace(/-/g, '');
	const high = BigInt(`0x${hex.slice(0, 16)}`);
	const low = BigInt(`0x${hex.slice(16, 32)}`);
	const folded = high ^ low;
	const mask = 0xffffffffn;

	return Number(((folded >> 32n) ^ folded) & mask);
}

function defaultTextureFor(uuid: string): string {
	const name = DEFAULT_BY_UUID[uuidHash(uuid) % DEFAULT_BY_UUID.length]!;

	return BUILTIN_SKINS[name]!;
}

const UUID_PATTERN = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const TEXTURE_PATTERN = /^[0-9a-f]{64}$/i;
const USERNAME_PATTERN = /^[A-Za-z0-9_.]{1,32}$/;

/**
 * Work out whose skin a subject means, and get it.
 *
 * A built-in name and a texture id are answered straight from Mojang's texture
 * server (and then from our disk copy for good); a username or UUID goes to the
 * cluster's own player record. A player we know but have no skin for, and a
 * UUID we do not know at all, both fall back to the default skin that UUID
 * would have in game, because a webhook with a broken image is worse than a
 * webhook showing Steve.
 */
async function resolveSubject(subject: string): Promise<SkinSource> {
	const builtin = subject.replace(/^x-/i, '').toLowerCase();

	if (BUILTIN_SKINS[builtin]) {
		return await textureSkin(BUILTIN_SKINS[builtin]);
	}

	if (TEXTURE_PATTERN.test(subject)) {
		return await textureSkin(subject.toLowerCase());
	}

	if (!UUID_PATTERN.test(subject) && !USERNAME_PATTERN.test(subject)) {
		throw error(400, 'a subject is a username, a UUID, a texture id or a default skin name');
	}

	try {
		const source = await playerSkin(subject);

		if (source.bytes) {
			return source;
		}

		return await textureSkin(defaultTextureFor(source.key));
	} catch (err) {
		const status = (err as { status?: number }).status;

		// an unregistered UUID is still a player somewhere, so it gets its default
		if (status === 404 && UUID_PATTERN.test(subject)) {
			return await textureSkin(defaultTextureFor(subject.toLowerCase()));
		}

		throw err;
	}
}

function number(query: URLSearchParams, name: string): number | undefined {
	const raw = query.get(name);

	if (raw === null || raw.trim() === '') {
		return undefined;
	}

	const value = Number.parseFloat(raw);

	if (!Number.isFinite(value)) {
		throw error(400, `${name} must be a number of degrees`);
	}

	return Math.max(-360, Math.min(360, value));
}

/**
 * Read the request out of the path and the query string.
 *
 * The path is `<kind>/<size>/<subject>` with the size optional, and the subject
 * may carry a `.png` extension. WebP and JPEG-XL are the hosted service's own
 * formats; this one encodes PNG, and says so rather than serving PNG bytes
 * under a name that promises otherwise.
 */
function parseRequest(path: string, query: URLSearchParams): AvatarRequest {
	const segments = path.split('/').filter((part) => part.length > 0);

	if (segments.length < 2) {
		throw error(404, 'a render is /<kind>/<size>/<subject>');
	}

	const kind = segments[0]!.toLowerCase() as AvatarKind;
	const isRender = RENDER_KINDS.includes(kind as RenderKind);

	if (!isRender && kind !== 'skin' && kind !== 'processedskin') {
		throw error(404, `unknown render: ${segments[0]}`);
	}

	let subject = segments[segments.length - 1]!;
	const dot = subject.lastIndexOf('.');

	if (dot > 0) {
		const extension = subject.slice(dot + 1).toLowerCase();

		if (extension === 'webp' || extension === 'jxl') {
			throw error(415, `this service renders PNG; ask for .png instead of .${extension}`);
		}

		if (extension !== 'png') {
			throw error(400, `unknown format: .${extension}`);
		}

		subject = subject.slice(0, dot);
	}

	if (subject.length === 0) {
		throw error(404, 'no subject');
	}

	const sized = segments.length > 2 ? segments[1]! : undefined;
	let height = DEFAULT_HEIGHT;

	if (sized !== undefined) {
		const asked = Number.parseInt(sized, 10);

		if (!Number.isFinite(asked) || asked <= 0) {
			throw error(400, `size must be a number of pixels, not "${sized}"`);
		}

		height = asked;
	}

	if (isRender) {
		const mode = RENDER_MODES[kind as RenderKind];

		height = Math.min(mode.maxHeight, Math.ceil(height / SIZE_STEP) * SIZE_STEP);
	}

	const without = (query.get('no') ?? '').split(',').map((part) => part.trim().toLowerCase());
	const model = query.has('slim') ? 'slim' : query.has('wide') ? 'wide' : undefined;

	return {
		kind,
		height,
		subject,
		model,
		options: {
			height,
			yaw: number(query, 'y'),
			pitch: number(query, 'p'),
			roll: number(query, 'r'),
			shadow: !without.includes('shadow'),
			helmet: !without.includes('helmet'),
			overlay: !without.includes('overlay'),
			autocrop: query.has('autocrop')
		}
	};
}

/**
 * Which model a skin is drawn for, when nothing else has said.
 *
 * A file we cannot read is not slim; the render itself fails a moment later
 * with a message that says why, which is a better answer than failing here on a
 * question that was only a default.
 */
function probeModel(skin: Buffer): boolean {
	try {
		return skinModel(decodePng(skin));
	} catch {
		return false;
	}
}

/** The parts of a request that change the pixels, as one cache key. */
function cacheKey(request: AvatarRequest, source: SkinSource, slim: boolean): string {
	const options = request.options;

	return [
		request.kind,
		request.height,
		source.key,
		source.revision,
		slim ? 'slim' : 'wide',
		options.yaw ?? 0,
		options.pitch ?? 0,
		options.roll ?? 0,
		options.shadow === false ? 'noshadow' : '',
		options.helmet === false ? 'nohelmet' : '',
		options.overlay === false ? 'nooverlay' : '',
		options.autocrop ? 'autocrop' : ''
	].join('|');
}

async function diskRead(key: string): Promise<Buffer | undefined> {
	const file = join(cacheDir(), `${digest(key)}.png`);

	return existsSync(file) ? await readFile(file) : undefined;
}

async function diskWrite(key: string, body: Buffer): Promise<void> {
	await mkdir(cacheDir(), { recursive: true });
	await writeFile(join(cacheDir(), `${digest(key)}.png`), body);
}

/**
 * Draw the render this request asks for; the caller handles caching.
 *
 * A skin file comes from wherever the player made it, so failing to read one is
 * an ordinary outcome rather than a fault of ours: it is reported as a bad
 * gateway with the reason, not as a crash. `skin` never decodes anything, which
 * is what lets the raw endpoint still serve a file this renderer cannot draw.
 */
function draw(request: AvatarRequest, skin: Buffer, slim: boolean): Buffer {
	if (request.kind === 'skin') {
		return skin;
	}

	try {
		const processed = processSkin(decodePng(skin), slim ? 'slim' : 'wide');

		if (request.kind === 'processedskin') {
			return encodePng(processed.image);
		}

		return encodePng(
			renderAvatar(request.kind as RenderKind, processed.image, { ...request.options, slim })
		);
	} catch (err) {
		throw error(502, `this skin could not be rendered: ${(err as Error).message}`);
	}
}

/**
 * Answer one avatar request.
 *
 * @param path everything after the endpoint's own prefix, e.g. `bust/128/Notch.png`
 * @param query the URL's query string, holding the options
 * @param cacheControl what to tell caches; the public endpoint shares, the
 *        console's does not
 * @param ifNoneMatch the request's `If-None-Match`, so a repeat costs a 304
 * @returns the PNG, or a 304 when the caller already has it
 */
export async function avatarResponse(
	path: string,
	query: URLSearchParams,
	cacheControl: string,
	ifNoneMatch?: string | null
): Promise<Response> {
	const request = parseRequest(path, query);
	const source = await resolveSubject(request.subject);

	if (!source.bytes) {
		throw error(404, 'no skin recorded for this player');
	}

	// the URL wins, then the profile's own metadata, then the skin's pixels;
	// the raw endpoint asks none of this, since it reads no pixels at all
	const slim =
		request.kind === 'skin'
			? false
			: request.model !== undefined
				? request.model === 'slim'
				: source.model !== undefined
					? source.model === 'slim'
					: probeModel(source.bytes);

	const key = cacheKey(request, source, slim);
	const etag = `"${digest(key)}"`;

	if (ifNoneMatch === etag) {
		return new Response(null, {
			status: 304,
			headers: { ETag: etag, 'Cache-Control': cacheControl }
		});
	}

	let body = memory.get(key);

	if (!body) {
		body = await diskRead(key);

		if (body) {
			remember(key, body);
		}
	}

	if (!body) {
		const pending =
			inFlight.get(key) ??
			(async () => {
				try {
					const drawn = draw(request, source.bytes!, slim);

					remember(key, drawn);
					await diskWrite(key, drawn).catch(() => {
						// losing the disk copy only costs the next cold request
					});

					return drawn;
				} finally {
					inFlight.delete(key);
				}
			})();

		inFlight.set(key, pending);
		body = await pending;
	}

	return new Response(body as unknown as BodyInit, {
		headers: {
			'Content-Type': 'image/png',
			'Cache-Control': cacheControl,
			ETag: etag
		}
	});
}
