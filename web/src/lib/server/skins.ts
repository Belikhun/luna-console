// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Serving a player's skin PNG.
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
 * This lives here rather than in the route because two routes serve it: the
 * console's gated one and the public page's, which reads the same cache under a
 * different gate. The write half (changing a skin) is not here; it stays behind
 * the console's own route, where it belongs.
 */

import { error } from '@sveltejs/kit';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as luna from '$core/services/luna';
import { root } from '$core/config';

interface CachedSkin {
	body: ArrayBuffer;
	fetchedAt: number;
}

/** Skins change rarely; ten minutes keeps repeat visits free. */
const CACHE_TTL_MS = 10 * 60 * 1000;

const memory = new Map<string, CachedSkin>();

function cacheDir(): string {
	return join(root(), '.cache', 'skins');
}

/** Pull the SKIN url out of the decoded textures payload. */
function textureUrl(encoded: string): string | undefined {
	try {
		const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
		const url = decoded?.textures?.SKIN?.url;

		return typeof url === 'string' && url.startsWith('http') ? url : undefined;
	} catch {
		return undefined;
	}
}

/** Read the disk copy, optionally only when it was fetched for `url`. */
async function diskRead(uuid: string, url?: string): Promise<Buffer | undefined> {
	const file = join(cacheDir(), `${uuid}.png`);
	const sidecar = join(cacheDir(), `${uuid}.src`);

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

async function diskWrite(uuid: string, url: string, body: ArrayBuffer): Promise<void> {
	await mkdir(cacheDir(), { recursive: true });
	await writeFile(join(cacheDir(), `${uuid}.png`), Buffer.from(body));
	await writeFile(join(cacheDir(), `${uuid}.src`), url);
}

/** Drop a player's cached PNG; called after their skin changes. */
export function forgetSkin(uuid: string): void {
	memory.delete(uuid);
}

function png(body: ArrayBuffer | Buffer, cacheControl: string): Response {
	return new Response(body as BodyInit, {
		headers: { 'Content-Type': 'image/png', 'Cache-Control': cacheControl }
	});
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
	const detail = await luna.registeredPlayer(player);

	if (!detail.ok || !detail.data) {
		throw error(404, detail.error ?? 'player not found');
	}

	const uuid = detail.data.uuid;
	const cached = memory.get(uuid);

	if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
		return png(cached.body, cacheControl);
	}

	const encoded = detail.data.skinTexture;
	const url = encoded ? textureUrl(encoded) : undefined;

	if (!url) {
		// no recorded texture; a disk copy from an earlier skin still beats nothing
		const stale = await diskRead(uuid);

		if (stale) {
			return png(stale, cacheControl);
		}

		throw error(404, 'no skin recorded for this player');
	}

	// disk first: same URL means the pixels cannot have changed
	const disk = await diskRead(uuid, url);

	if (disk) {
		memory.set(uuid, {
			body: disk.buffer.slice(disk.byteOffset, disk.byteOffset + disk.byteLength) as ArrayBuffer,
			fetchedAt: Date.now()
		});

		return png(disk, cacheControl);
	}

	try {
		const upstream = await fetch(url, { signal: AbortSignal.timeout(8000) });

		if (!upstream.ok) {
			throw new Error(`texture server answered ${upstream.status}`);
		}

		const body = await upstream.arrayBuffer();

		memory.set(uuid, { body, fetchedAt: Date.now() });
		await diskWrite(uuid, url, body).catch(() => {
			// a failed disk write only loses the offline copy, not the response
		});

		return png(body, cacheControl);
	} catch (err) {
		// offline or upstream down: serve whatever skin we ever had for them
		const stale = await diskRead(uuid);

		if (stale) {
			return png(stale, cacheControl);
		}

		throw error(502, (err as Error).message);
	}
}
