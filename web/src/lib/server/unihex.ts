// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Unifont, answered one codepoint at a time.
 *
 * The bundle the daemon extracts is eight megabytes of hex; a hundred and
 * fourteen thousand glyphs, nearly all of them CJK; and a preview needs a
 * handful of box characters out of it. Shipping the file to the browser would
 * cost more than every other asset the editor loads put together, so the browser
 * names the codepoints it could not draw and gets back only those rows.
 *
 * The parsed bundle is held in this process because the alternative is re-reading
 * eight megabytes per request, and it can only change when the assets are
 * re-extracted; which is what the modification time is compared for.
 */

import { stat } from 'node:fs/promises';

interface Bundle {
	stamp: number;
	glyphs: Map<number, string>;
}

const bundles = new Map<string, Bundle>();

async function load(path: string): Promise<Bundle> {
	const info = await stat(path);
	const cached = bundles.get(path);

	if (cached && cached.stamp === info.mtimeMs) {
		return cached;
	}

	const glyphs = new Map<number, string>();
	const text = await Bun.file(path).text();

	for (const line of text.split('\n')) {
		const split = line.indexOf(':');

		if (split < 1) {
			continue;
		}

		const codepoint = Number.parseInt(line.slice(0, split), 16);
		const bits = line.slice(split + 1).trim();

		// four bits a character, sixteen rows: 8 or 16 columns wide and nothing else
		if (!Number.isFinite(codepoint) || (bits.length !== 32 && bits.length !== 64 && bits.length !== 128)) {
			continue;
		}

		glyphs.set(codepoint, bits);
	}

	const bundle: Bundle = { stamp: info.mtimeMs, glyphs };
	bundles.set(path, bundle);

	return bundle;
}

/**
 * Look up the requested codepoints in an extracted bundle.
 *
 * @param path the `.hex` file the registry's provider points at
 * @param codepoints what the browser could not draw
 * @returns the hex row for each codepoint the bundle covers, keyed by codepoint
 */
export async function unihexGlyphs(path: string, codepoints: number[]): Promise<Record<string, string>> {
	const bundle = await load(path);
	const out: Record<string, string> = {};

	for (const codepoint of codepoints) {
		const bits = bundle.glyphs.get(codepoint);

		if (bits) {
			out[String(codepoint)] = bits;
		}
	}

	return out;
}
