// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import * as luna from '$core/services/luna';
import { forgetSkin, skinResponse } from '$lib/server/skins';
import { pushEvent } from '$lib/server/luna';

/**
 * GET → the player's raw skin PNG; POST → change or reset it.
 *
 * The read half lives in `$lib/server/skins`, because the public page serves
 * the same pixels from the same cache under its own gate. Writing a skin stays
 * here: it is an operator action and it belongs behind the console's session.
 */

export async function GET({ params }) {
	return await skinResponse(params.player);
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
		forgetSkin(result.data.uuid);
		pushEvent('proxy', 'action', `skin ${mode === 'reset' ? 'reset' : 'changed'} for ${params.player}`);
	}

	return json(result);
}
