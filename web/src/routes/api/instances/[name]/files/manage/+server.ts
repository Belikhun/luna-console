// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { loadCluster, managedInstances } from '$core/config';
import {
	createPlaceholder,
	discardDrift,
	manageFile,
	managedFileReport,
	readoptFile,
	renderManagedFiles,
	unmanageFile
} from '$core/configfiles';
import { listDaemons } from '$client/daemon';
import { machineKeyFor } from '$shared/machines';
import { pushEvent } from '$lib/server/luna';
import { startJob } from '$lib/server/jobs';
import { errorMessage } from '$lib/server/http';

/**
 * Everything that changes a file's *management* rather than its text: taking it
 * under management, releasing it, creating a placeholder inside it, re-adopting
 * a drifted one, and rendering the whole set.
 */

/** GET → every managed file of this instance, with its placeholders and state. */
export async function GET({ params }) {
	const cfg = await loadCluster();

	if (!managedInstances(cfg)[params.name]) {
		throw error(404, 'unknown instance');
	}

	return json({ files: await managedFileReport(cfg, params.name) });
}

/**
 * POST { action, path, … }
 *
 * `manage` / `unmanage` / `readopt` / `discard-drift` act on one file;
 * `placeholder` replaces a literal with `${NAME}` and defines the variable;
 * `render` re-derives every managed file and answers with a job to follow.
 */
export async function POST({ params, request }) {
	const cfg = await loadCluster();
	const name = params.name;

	if (!managedInstances(cfg)[name]) {
		throw error(404, 'unknown instance');
	}

	const body = await request.json();
	const action = String(body.action ?? '');
	const path = body.path !== undefined ? String(body.path) : '';

	if (action === 'render') {
		const job = startJob('render-configs', name, `render ${name} config files`, async (reporter) => {
			const fresh = await loadCluster();
			const results = await renderManagedFiles(fresh, name, reporter);
			const changed = results.filter((result) => result.outcome !== 'unchanged');

			if (changed.length) {
				pushEvent(name, 'action', `${changed.length} managed config file(s) re-rendered`);
			}

			return { results };
		});

		return json({ ok: true, job });
	}

	if (!path) {
		throw error(400, 'path is required');
	}

	try {
		if (action === 'manage') {
			await manageFile(cfg, name, path, {
				description: body.description !== undefined ? String(body.description) : undefined
			});
			pushEvent(name, 'action', `${path} taken under management`);

			return json({ ok: true });
		}

		if (action === 'unmanage') {
			if (!(await unmanageFile(cfg, name, path))) {
				throw error(404, `${path} is not managed`);
			}

			pushEvent(name, 'action', `${path} released from management`);

			return json({ ok: true });
		}

		if (action === 'readopt') {
			const result = await readoptFile(cfg, name, path);

			pushEvent(name, 'action', `${path} re-adopted from disk`);

			return json({ ok: true, ...result });
		}

		if (action === 'discard-drift') {
			return json({ ok: await discardDrift(cfg, name, path) });
		}

		if (action === 'placeholder') {
			// a machine-scoped placeholder arrives as a name; the store keys the
			// primary by "", which the console never sees
			let machine: string | undefined;

			if (body.machine) {
				machine = machineKeyFor(await listDaemons(), String(body.machine));

				if (machine === undefined) {
					throw error(400, `unknown machine: ${body.machine}`);
				}
			}

			const result = await createPlaceholder(cfg, name, path, {
				name: String(body.name ?? ''),
				value: String(body.value ?? ''),
				all: !!body.all,
				...(body.at !== undefined && body.at !== null ? { at: Number(body.at) } : {}),
				secret: !!body.secret,
				force: !!body.force,
				description: body.description !== undefined ? String(body.description) : undefined,
				...(body.scope === 'instance' ? { instance: name } : {}),
				...(machine !== undefined ? { machine } : {})
			});

			pushEvent(name, 'action', `\${${result.name}} placeholder created in ${result.path}`);

			return json({ ok: true, ...result });
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
