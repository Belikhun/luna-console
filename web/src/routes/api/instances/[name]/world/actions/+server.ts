// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import { loadCluster, managedInstances } from '$core/config';
import { getStatus } from '$core/instances';
import { createBackup, restoreBackup } from '$core/backups';
import { replaceWorld, resetWorld, worldLock } from '$core/world';
import { startJob } from '$lib/server/jobs';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/**
 * Verbs that rewrite the world, each as a job.
 *
 * POST { action: 'backup', label?, note? }
 * POST { action: 'replace', token, level?, backupFirst? }
 * POST { action: 'restore', id, backupFirst? }
 * POST { action: 'reset', backupFirst? }
 *
 * `backup` is allowed while the server runs, because a live backup is the only
 * kind you can take of a running world and the alternative is none; the daemon
 * freezes saving around it. The other three require a stopped instance, and
 * that is checked here *and* in the daemon - the UI's disabled buttons are a
 * courtesy, the routed op is the rule.
 */
export async function POST({ params, request, locals }) {
	const body = await request.json();
	const action = String(body.action ?? '');
	const name = params.name;
	const cfg = await loadCluster();
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw error(404, 'unknown instance');
	}

	if (inst.external) {
		throw error(400, 'this server runs outside luna; it has no world here');
	}

	const held = await worldLock(cfg, name);

	if (held) {
		throw error(409, `a world ${held.kind} is already running on ${name}`);
	}

	if (action !== 'backup') {
		const status = await getStatus(cfg, name);

		if (status.state !== 'stopped') {
			throw error(409, `${name} is running; stop it first`);
		}
	}

	const actor = locals.account?.username;

	if (action === 'backup') {
		return json({ ok: true, job: backupJob(cfg, name, body, actor) });
	}

	if (action === 'replace') {
		const token = String(body.token ?? '');

		if (!token) {
			throw error(400, 'token is required');
		}

		const backupFirst = body.backupFirst !== false;

		const job = startJob('world-replace', name, `Replace ${name}'s world`, async (reporter) => {
			// the safety copy is its own child so a failed backup stops the replace
			// before the old world is touched, exactly as it does for a reset
			if (backupFirst) {
				await createBackup(cfg, name, {
					label: `before replacing ${name}`,
					trigger: 'pre-replace',
					skipFreeze: true,
					actor,
					reporter: reporter.child('Back up the current world', 5)
				});
			}

			const result = await replaceWorld(cfg, name, token, {
				level: body.level ? String(body.level) : undefined,
				actor,
				source: body.source ? String(body.source) : undefined,
				reporter: reporter.child('Install the new world', 5)
			});

			pushEvent(name, 'action', 'world replaced');

			return result;
		});

		return json({ ok: true, job });
	}

	if (action === 'restore') {
		const id = String(body.id ?? '');

		if (!id) {
			throw error(400, 'id is required');
		}

		const job = startJob('world-restore', name, `Restore ${name}'s world`, async (reporter) => {
			const result = await restoreBackup(cfg, name, id, {
				backupFirst: body.backupFirst !== false,
				actor,
				reporter
			});

			pushEvent(name, 'action', 'world restored');

			return result;
		});

		return json({ ok: true, job });
	}

	if (action === 'reset') {
		const job = startJob('world-reset', name, `Reset ${name}'s world`, async (reporter) => {
			// the safety copy is a separate job so it is visible as its own card and
			// so a failed backup stops the reset before anything is destroyed
			if (body.backupFirst !== false) {
				await createBackup(cfg, name, {
					label: `before resetting ${name}`,
					trigger: 'pre-reset',
					skipFreeze: true,
					actor,
					reporter: reporter.child('Back up the current world', 4)
				});
			}

			const result = await resetWorld(cfg, name, {
				actor,
				reporter: reporter.child('Reset the world', 4)
			});

			pushEvent(name, 'action', 'world reset');

			return result;
		});

		return json({ ok: true, job });
	}

	throw error(400, 'unknown action');
}

/** The backup verb, shared by the manual button and by a schedule firing. */
function backupJob(
	cfg: Awaited<ReturnType<typeof loadCluster>>,
	name: string,
	body: Record<string, unknown>,
	actor: string | undefined
) {
	return startJob('world-backup', name, `Back up ${name}'s world`, async (reporter) => {
		try {
			const entry = await createBackup(cfg, name, {
				label: body.label ? String(body.label) : undefined,
				note: body.note ? String(body.note) : undefined,
				trigger: 'manual',
				actor,
				reporter
			});

			pushEvent(name, 'action', `world backed up (${entry.label})`);

			return entry;
		} catch (err) {
			pushEvent(name, 'error', `backup failed: ${errorMessage(err)}`);

			throw err;
		}
	});
}
