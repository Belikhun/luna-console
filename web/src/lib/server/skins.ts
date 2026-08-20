// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Where a skin's pixels come from.
 *
 * The texture URL lives base64-encoded inside the game-profile property
 * LunaCore captured at login, and points at textures.minecraft.net; which sends
 * no CORS headers, so the browser could neither read its pixels on a canvas nor
 * cache it per player. Serving it same-origin fixes both.
 *
 * Fetched PNGs are persisted under `<root>/.cache/skins/`, keyed by UUID with
 * the source URL in a sidecar: avatars keep rendering from the disk copy when
 * textures.minecraft.net is unreachable, so the console never depends on an
 * external renderer or a live internet connection to draw a face.
 *
 * This lives here rather than in the route because several callers serve it:
 * the console's gated route, the public page's ungated one, and the avatar
 * renderer, which needs the bytes rather than a response. The write half
 * (changing a skin) is not here; it stays behind the console's own route,
 * where it belongs.
 */

import { error } from '@sveltejs/kit';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as luna from '$core/services/luna';
import { root } from '$core/config';

/** A skin as the renderer and the routes need it. */
export interface SkinSource {
	/** The player this belongs to, or the texture id for a direct lookup */
	key: string;
	/** The file, or undefined when the player has never had a skin recorded */
	bytes?: Buffer;
	/** What the profile says the model is, when it says anything */
	model?: 'slim' | 'classic';
	/**
	 * Identity of these pixels. It is the texture URL when one is known, so a
	 * skin change gives every cache downstream a new key without anyone having
	 * to be told about it.
	 */
	revision: string;
}

interface CachedSkin extends SkinSource {
	fetchedAt: number;
}

/** Skins change rarely; ten minutes keeps repeat visits free. */
const CACHE_TTL_MS = 10 * 60 * 1000;

/** Long enough for a texture server hiccup, short enough not to hold a route. */
const FETCH_TIMEOUT_MS = 8000;

const memory = new Map<string, CachedSkin>();

function cacheDir(): string {
	return join(root(), '.cache', 'skins');
}

interface TexturePayload {
	url?: string;
	model?: 'slim' | 'classic';
}

/** Pull the SKIN url and its model out of the decoded textures payload. */
function texturePayload(encoded: string): TexturePayload {
	try {
		const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
		const skin = decoded?.textures?.SKIN;
		const url = skin?.url;
		const model = skin?.metadata?.model;

		return {
			url: typeof url === 'string' && url.startsWith('http') ? url : undefined,
			model: model === 'slim' ? 'slim' : model === 'classic' ? 'classic' : undefined
		};
	} catch {
		return {};
	}
}

/** Read the disk copy, optionally only when it was fetched for `url`. */
async function diskRead(key: string, url?: string): Promise<Buffer | undefined> {
	const file = join(cacheDir(), `${key}.png`);
	const sidecar = join(cacheDir(), `${key}.src`);

	if (!existsSync(file)) {
		return undefined;
	}

	if (url !== undefined) {
		const source = existsSync(sidecar) ? (await readFile(sidecar, 'utf8')).trim() : '';

		if (source !== url) {
			return undefined;
		}
	}

	return await readFile(file);
}

async function diskWrite(key: string, url: string, body: Buffer): Promise<void> {
	await mkdir(cacheDir(), { recursive: true });
	await writeFile(join(cacheDir(), `${key}.png`), body);
	await writeFile(join(cacheDir(), `${key}.src`), url);
}

/** Drop a player's cached PNG; called after their skin changes. */
export function forgetSkin(uuid: string): void {
	memory.delete(uuid);
}

function png(body: Buffer, cacheControl: string): Response {
	return new Response(body as unknown as BodyInit, {
		headers: { 'Content-Type': 'image/png', 'Cache-Control': cacheControl }
	});
}

async function download(url: string): Promise<Buffer> {
	const upstream = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

	if (!upstream.ok) {
		throw new Error(`texture server answered ${upstream.status}`);
	}

	return Buffer.from(await upstream.arrayBuffer());
}

/**
 * A player's skin file, from memory, then disk, then the texture server.
 *
 * @param player UUID or username, whatever the caller has
 * @returns the file and what is known about it; `bytes` is absent when the
 *          player exists but has never had a skin recorded
 * @throws 404 when no such player is registered, 502 when the texture server
 *         failed and nothing was ever cached for them
 */
export async function playerSkin(player: string): Promise<SkinSource> {
	const detail = await luna.registeredPlayer(player);

	if (!detail.ok || !detail.data) {
		throw error(404, detail.error ?? 'player not found');
	}

	const uuid = detail.data.uuid;
	const cached = memory.get(uuid);

	if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
		return cached;
	}

	const encoded = detail.data.skinTexture;
	const payload = encoded ? texturePayload(encoded) : {};

	if (!payload.url) {
		// no recorded texture; a disk copy from an earlier skin still beats nothing
		const stale = await diskRead(uuid);

		return { key: uuid, bytes: stale, model: payload.model, revision: 'none' };
	}

	// disk first: the same URL means the pixels cannot have changed
	const disk = await diskRead(uuid, payload.url);

	if (disk) {
		const source: CachedSkin = {
			key: uuid,
			bytes: disk,
			model: payload.model,
			revision: payload.url,
			fetchedAt: Date.now()
		};

		memory.set(uuid, source);

		return source;
	}

	try {
		const bytes = await download(payload.url);
		const source: CachedSkin = {
			key: uuid,
			bytes,
			model: payload.model,
			revision: payload.url,
			fetchedAt: Date.now()
		};

		memory.set(uuid, source);
		await diskWrite(uuid, payload.url, bytes).catch(() => {
			// a failed disk write only loses the offline copy, not the response
		});

		return source;
	} catch (err) {
		// offline or upstream down: serve whatever skin we ever had for them
		const stale = await diskRead(uuid);

		if (stale) {
			return { key: uuid, bytes: stale, model: payload.model, revision: 'stale' };
		}

		throw error(502, (err as Error).message);
	}
}

/** Where Mojang serves a texture by its content hash. */
const TEXTURE_HOST = 'https://textures.minecraft.net/texture';

/**
 * A skin by Mojang texture id.
 *
 * A texture id is the hash of the file, so the pixels behind one can never
 * change: the disk copy needs no sidecar and never expires. This is the path
 * the default skins and any `<hash>` subject take.
 *
 * @param hash the 64-character texture id
 * @returns the file
 * @throws 502 when the texture server cannot be reached and nothing is cached
 */
export async function textureSkin(hash: string): Promise<SkinSource> {
	const key = `texture-${hash}`;
	const cached = memory.get(key);

	if (cached) {
		return cached;
	}

	const disk = await diskRead(key);

	if (disk) {
		const source: CachedSkin = { key, bytes: disk, revision: hash, fetchedAt: Date.now() };

		memory.set(key, source);

		return source;
	}

	const url = `${TEXTURE_HOST}/${hash}`;

	try {
		const bytes = await download(url);
		const source: CachedSkin = { key, bytes, revision: hash, fetchedAt: Date.now() };

		memory.set(key, source);
		await diskWrite(key, url, bytes).catch(() => {
			// as above: losing the offline copy is not losing the response
		});

		return source;
	} catch (err) {
		throw error(502, (err as Error).message);
	}
}

/**
 * The player's skin PNG, from memory, then disk, then the texture server.
 *
 * `cacheControl` differs by caller: the console keeps it private, the public
 * page lets a shared cache hold it, since a skin is public information and the
 * page is served to everyone.
 */
export async function skinResponse(
	player: string,
	cacheControl = 'private, max-age=300'
): Promise<Response> {
	const source = await playerSkin(player);

	if (!source.bytes) {
		throw error(404, 'no skin recorded for this player');
	}

	return png(source.bytes, cacheControl);
}
