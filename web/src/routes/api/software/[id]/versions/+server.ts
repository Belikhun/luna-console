// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { error, json } from '@sveltejs/kit';
import type { Software } from '$core/types';
import { SOFTWARE_IDS, hasProvider, isReleaseVersion } from '$core/software';
import { listLoaderVersions, listMcVersions } from '$core/services/software';
import { errorMessage } from '$lib/server/http';

/**
 * GET ?mc= → the versions a software publishes.
 *
 * Without `mc`, the Minecraft versions; with it, the loader builds for that
 * one. Snapshots and pre-releases are filtered out, because a picker offering
 * `1.21.11-pre3` beside `1.21.11` invites a mistake nobody meant to make.
 */
export async function GET({ params, url }) {
	const id = params.id as Software;

	if (!SOFTWARE_IDS.includes(id)) {
		throw error(404, `unknown software: ${params.id}`);
	}

	if (!hasProvider(id)) {
		throw error(409, `${id} has no download provider; it can only be adopted`);
	}

	const mc = url.searchParams.get('mc') ?? undefined;

	try {
		if (mc) {
			return json({ loaderVersions: await listLoaderVersions(id, mc) });
		}

		const versions = await listMcVersions(id);
		const releases = versions.filter(isReleaseVersion);

		// a software that does not version itself by the game (pumpkin publishes
		// release tags) has no release-shaped entries at all; filtering those to
		// nothing would leave the picker empty rather than honest
		return json({ mcVersions: releases.length ? releases : versions });
	} catch (err) {
		// the upstream being down is not this console's fault, and the launch form
		// needs to be able to say so rather than showing an empty picker
		throw error(502, errorMessage(err));
	}
}
