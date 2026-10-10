// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { loadCluster, managedInstances } from '$core/config';
import { browseInstance, readInstanceFile, writeInstanceFile } from '$core/configfiles';
import { findInstanceFiles, pathDetails } from '$core/instancefiles';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/**
 * The instance file browser and editor. Listing is one level at a time; a world
 * directory holds hundreds of thousands of region files, so nothing recurses
 * unless asked to by name.
 *
 * GET ?path=<dir>              → that directory's entries
 * GET ?path=<file>&read=1      → the file's text, plus its template when managed
 * GET ?path=<dir>&find=<name>  → entries below it whose name matches, bounded
 * GET ?path=<p>&details=1      → size, type and (for a directory) what sits below
 * PUT { path, text }           → write it (a managed file's text *is* its template)
 */
export async function GET({ params, url }) {
	const cfg = await loadCluster();

	if (!managedInstances(cfg)[params.name]) {
		throw error(404, 'unknown instance');
	}

	const path = url.searchParams.get('path') ?? '';

	try {
		if (url.searchParams.get('read')) {
			return json(await readInstanceFile(cfg, params.name, path));
		}

		if (url.searchParams.get('details')) {
			return json(await pathDetails(cfg, params.name, path));
		}

		const find = url.searchParams.get('find');

		if (find) {
			const depth = Number(url.searchParams.get('depth') ?? 6);

			return json(await findInstanceFiles(cfg, params.name, { path, name: `*${find}*`, depth, limit: 500 }));
		}

		return json(await browseInstance(cfg, params.name, path));
	} catch (err) {
		// a path that escapes the instance, a missing file, a binary or oversized
		// one; all of them are the caller's request being wrong, not a server fault
		throw error(400, errorMessage(err));
	}
}

/** PUT { path, text, description? } → write a plain file, or a managed file's template. */
export async function PUT({ params, request }) {
	const cfg = await loadCluster();

	if (!managedInstances(cfg)[params.name]) {
		throw error(404, 'unknown instance');
	}

	const body = await request.json();
	const path = String(body.path ?? '');

	if (!path) {
		throw error(400, 'path is required');
	}

	if (typeof body.text !== 'string') {
		throw error(400, 'text is required');
	}

	try {
		const result = await writeInstanceFile(cfg, params.name, path, body.text, {
			description: body.description !== undefined ? String(body.description) : undefined
		});

		pushEvent(
			params.name,
			'action',
			`${result.managed ? 'template' : 'file'} saved: ${result.path}`
		);

		return json(result);
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
