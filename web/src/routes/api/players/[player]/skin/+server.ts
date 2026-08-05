import { json, error } from '@sveltejs/kit';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as luna from '$core/services/luna';
import { root } from '$core/config';
import { pushEvent } from '$lib/server/luna';

/**
 * GET → the player's raw skin PNG; POST → change or reset it.
 *
 * The texture URL lives base64-encoded inside the game-profile property LunaCore
 * captured at login, and points at textures.minecraft.net; which sends no CORS
 * headers, so the browser could neither read its pixels on a canvas nor cache it
 * per player. Serving it same-origin fixes both.
 *
 * Fetched PNGs are persisted under `<root>/.cache/skins/`, keyed by UUID with
 * the source URL in a sidecar: avatars keep rendering from the disk copy when
 * textures.minecraft.net is unreachable; the console never depends on an
 * external renderer or a live internet connection to draw a face.
 */

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

function png(body: ArrayBuffer | Buffer): Response {
	return new Response(body as BodyInit, {
		headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=300' }
	});
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

export async function GET({ params }) {
	const detail = await luna.registeredPlayer(params.player);

	if (!detail.ok || !detail.data) {
		throw error(404, detail.error ?? 'player not found');
	}

	const uuid = detail.data.uuid;
	const cached = memory.get(uuid);

	if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
		return png(cached.body);
	}

	const encoded = detail.data.skinTexture;
	const url = encoded ? textureUrl(encoded) : undefined;

	if (!url) {
		// no recorded texture; a disk copy from an earlier skin still beats nothing
		const stale = await diskRead(uuid);

		if (stale) {
			return png(stale);
		}

		throw error(404, 'no skin recorded for this player');
	}

	// disk first: same URL means the pixels cannot have changed
	const disk = await diskRead(uuid, url);

	if (disk) {
		memory.set(uuid, { body: disk.buffer.slice(disk.byteOffset, disk.byteOffset + disk.byteLength) as ArrayBuffer, fetchedAt: Date.now() });
		return png(disk);
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

		return png(body);
	} catch (err) {
		// offline or upstream down: serve whatever skin we ever had for them
		const stale = await diskRead(uuid);

		if (stale) {
			return png(stale);
		}

		throw error(502, (err as Error).message);
	}
}

/** MineSkin turns an uploaded PNG into signed texture data. */
const MINESKIN_UPLOAD = 'https://api.mineskin.org/generate/upload';

interface MineSkinTexture {
	value: string;
	signature: string;
}

/**
 * Generate signed texture data from raw PNG bytes via MineSkin. Signing can
 * only happen against Mojang's session servers, so this one step is the only
 * part of skin administration that needs the internet; everything the console
 * *renders* stays local.
 */
async function mineskinUpload(bytes: Buffer, variant: string): Promise<MineSkinTexture> {
	const form = new FormData();

	form.set('file', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'skin.png');
	form.set('visibility', '1');

	if (variant === 'slim' || variant === 'classic') {
		form.set('variant', variant);
	}

	const headers: Record<string, string> = {};
	const key = process.env.LUNA_MINESKIN_KEY;

	if (key) {
		headers.Authorization = `Bearer ${key}`;
	}

	const response = await fetch(MINESKIN_UPLOAD, {
		method: 'POST',
		headers,
		body: form,
		signal: AbortSignal.timeout(45000)
	});

	const body: any = await response.json().catch(() => ({}));

	if (!response.ok) {
		throw new Error(body?.error ?? body?.errorCode ?? `MineSkin answered ${response.status}`);
	}

	const texture = body?.data?.texture;

	if (!texture?.value || !texture?.signature) {
		throw new Error('MineSkin returned no texture data');
	}

	return { value: texture.value, signature: texture.signature };
}

/**
 * POST { mode, ... } → change the player's skin through SkinsRestorer.
 *
 * `mode: "upload"` carries { fileBase64, variant? } and goes through MineSkin
 * for signing before the texture is handed to the proxy; `name`, `url` and
 * `reset` pass straight through to LunaCore.
 */
export async function POST({ params, request }) {
	const body = await request.json();
	const mode = String(body.mode ?? '');

	let result;

	if (mode === 'upload') {
		const encoded = String(body.fileBase64 ?? '');

		if (!encoded) {
			throw error(400, 'fileBase64 is required for mode=upload');
		}

		const bytes = Buffer.from(encoded, 'base64');

		// vanilla skins are 64×64 (legacy 64×32); anything bigger is not a skin
		if (bytes.length === 0 || bytes.length > 256 * 1024) {
			throw error(400, 'not a valid skin file (empty or larger than 256 KiB)');
		}

		let texture: MineSkinTexture;

		try {
			texture = await mineskinUpload(bytes, String(body.variant ?? ''));
		} catch (err) {
			throw error(502, `MineSkin generation failed: ${(err as Error).message}`);
		}

		result = await luna.setSkin(params.player, {
			mode: 'texture',
			value: texture.value,
			signature: texture.signature,
			actor: 'console'
		});
	} else if (mode === 'name' || mode === 'url' || mode === 'reset') {
		result = await luna.setSkin(params.player, {
			mode,
			...(body.skin ? { skin: String(body.skin) } : {}),
			...(body.url ? { url: String(body.url) } : {}),
			...(body.variant ? { variant: String(body.variant) } : {}),
			actor: 'console'
		});
	} else {
		throw error(400, `unknown mode: ${mode}`);
	}

	if (result.ok && result.data) {
		// the cached PNG is now stale; the next avatar fetch re-reads the profile
		memory.delete(result.data.uuid);
		pushEvent('proxy', 'action', `skin ${mode === 'reset' ? 'reset' : 'changed'} for ${params.player}`);
	}

	return json(result);
}
