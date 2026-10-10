// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { loadCluster, managedInstances } from '$core/config';
import { writeInstanceFile } from '$core/configfiles';
import {
	copyInstancePath,
	deleteInstancePath,
	makeInstanceDir,
	moveInstancePath,
	statInstancePath
} from '$core/instancefiles';
import { pushEvent } from '$lib/server/luna';
import { journal } from '$lib/server/session';
import { errorMessage } from '$lib/server/http';

/**
 * The file manager's verbs, every one of them routed to the daemon owning the
 * instance (the files only exist on that machine's disk).
 *
 * POST { action: 'mkdir',   path }
 * POST { action: 'newfile', path }                      → an empty file, never over an existing one
 * POST { action: 'rename',  from, to }                  → `to` is the new path, same directory or not
 * POST { action: 'move',    paths[], to, overwrite? }   → into the directory `to`
 * POST { action: 'copy',    paths[], to, overwrite? }
 * POST { action: 'delete',  paths[] }                   → recursive; the screen confirmed it
 *
 * The batch verbs answer with one outcome per target rather than failing the
 * whole batch on the first refusal: deleting five files of which one vanished
 * is four deletions and one note, not an error.
 */
export async function POST({ params, request, locals }) {
	const cfg = await loadCluster();
	const name = params.name;

	if (!managedInstances(cfg)[name]) {
		throw error(404, 'unknown instance');
	}

	const body = await request.json();
	const action = String(body.action ?? '');
	const actor = locals.account?.username ?? 'console';

	try {
		if (action === 'mkdir') {
			const info = await makeInstanceDir(cfg, name, requirePath(body.path));

			pushEvent(name, 'action', `directory created by ${actor}: ${info.path}`);

			return json({ ok: true, entry: info });
		}

		if (action === 'newfile') {
			const path = requirePath(body.path);

			if (await statInstancePath(cfg, name, path)) {
				throw error(409, `${path} already exists`);
			}

			const result = await writeInstanceFile(cfg, name, path, '');

			pushEvent(name, 'action', `file created by ${actor}: ${result.path}`);

			return json({ ok: true, path: result.path });
		}

		if (action === 'rename') {
			const from = requirePath(body.from);
			const to = requirePath(body.to);
			const info = await moveInstancePath(cfg, name, from, to, { overwrite: false });

			pushEvent(name, 'action', `renamed by ${actor}: ${from} → ${info.path}`);

			return json({ ok: true, entry: info });
		}

		if (action === 'move' || action === 'copy') {
			const paths = requirePaths(body.paths);
			const dir = String(body.to ?? '').replace(/\/+$/, '');
			const overwrite = body.overwrite === true;
			const outcomes: Array<{ path: string; ok: boolean; to?: string; error?: string }> = [];

			for (const path of paths) {
				const target = dir ? `${dir}/${baseOf(path)}` : baseOf(path);

				try {
					const info = action === 'move'
						? await moveInstancePath(cfg, name, path, target, { overwrite })
						: await copyInstancePath(cfg, name, path, target, { overwrite });

					outcomes.push({ path, ok: true, to: info.path });
				} catch (err) {
					outcomes.push({ path, ok: false, error: errorMessage(err) });
				}
			}

			const done = outcomes.filter((outcome) => outcome.ok).length;

			if (done > 0) {
				pushEvent(name, 'action', `${done} item(s) ${action === 'move' ? 'moved' : 'copied'} to ${dir || '/'} by ${actor}`);
				journal(`${name}: ${done} item(s) ${action === 'move' ? 'moved' : 'copied'} to ${dir || '/'}`, { actor });
			}

			return json({ ok: outcomes.every((outcome) => outcome.ok), outcomes });
		}

		if (action === 'delete') {
			const paths = requirePaths(body.paths);
			const outcomes: Array<{ path: string; ok: boolean; kind?: string; error?: string }> = [];

			for (const path of paths) {
				try {
					const removed = await deleteInstancePath(cfg, name, path, { recursive: true });

					outcomes.push({ path, ok: true, kind: removed.kind });
				} catch (err) {
					outcomes.push({ path, ok: false, error: errorMessage(err) });
				}
			}

			const done = outcomes.filter((outcome) => outcome.ok);

			if (done.length > 0) {
				pushEvent(name, 'action', `deleted by ${actor}: ${done.map((outcome) => outcome.path).join(', ')}`);
				journal(`${name}: ${done.length} item(s) deleted`, { actor, detail: done.map((outcome) => outcome.path).join(', ') });
			}

			return json({ ok: outcomes.every((outcome) => outcome.ok), outcomes });
		}
	} catch (err) {
		// `error()` throws a Response-shaped object; re-throw it untouched so the
		// status it chose survives
		if (err && typeof err === 'object' && 'status' in err) {
			throw err;
		}

		throw error(400, errorMessage(err));
	}

	throw error(400, `unknown action: ${action}`);
}

function requirePath(value: unknown): string {
	const path = String(value ?? '').trim();

	if (!path) {
		throw error(400, 'path is required');
	}

	return path;
}

function requirePaths(value: unknown): string[] {
	const paths = Array.isArray(value) ? value.map((entry) => String(entry)).filter((entry) => entry !== '') : [];

	if (paths.length === 0) {
		throw error(400, 'paths is required');
	}

	return paths;
}

function baseOf(path: string): string {
	return path.replace(/\/+$/, '').split('/').pop() ?? path;
}
