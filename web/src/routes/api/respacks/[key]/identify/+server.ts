import { json, error } from '@sveltejs/kit';
import { loadCluster, loadLock } from '$core/config';
import { loadPacksLock, savePacksLock } from '$core/packslock';
import {
	forgetRespackIdentity,
	identifyResourcePack,
	probeRespackIdentity
} from '$core/respacks';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';
import type { ProviderId } from '$core/types';

/**
 * The provider mapping of one resource pack.
 *
 * GET grades what the zip could be and writes nothing, so the dialog can show
 * the evidence before the operator commits; POST records the mapping; DELETE
 * drops it. The three-step shape is the point; a mapping guessed silently is
 * how a later "update" turns into a downgrade.
 */

/** GET ?provider=&project= → what this pack's zip could be at that project. */
export async function GET({ params, url }) {
	const project = url.searchParams.get('project');

	if (!project) {
		throw error(400, 'project required');
	}

	const provider = (url.searchParams.get('provider') ?? 'modrinth') as ProviderId;

	try {
		const probe = await probeRespackIdentity(
			await loadCluster(),
			await loadPacksLock(),
			params.key,
			provider,
			project
		);

		return json({ probe });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}

/** POST { provider, project, versionId?, unidentified?, autoUpdate? } → map it. */
export async function POST({ params, request }) {
	const body = await request.json();
	const cfg = await loadCluster();
	const lock = await loadPacksLock();

	if (!body.project) {
		throw error(400, 'project required');
	}

	try {
		const result = await identifyResourcePack(cfg, lock, params.key, {
			provider: (body.provider ?? 'modrinth') as ProviderId,
			project: String(body.project),
			versionId: body.versionId ?? undefined,
			unidentified: body.unidentified === true,
			autoUpdate: body.autoUpdate
		});

		await savePacksLock(lock);
		pushEvent(
			'packs',
			'action',
			`resource pack ${params.key} mapped to ${result.probe.provider}:${result.probe.project.slug}` +
				`${result.match ? ` ${result.match.versionNumber}` : ' (version unknown)'}`
		);

		return json({ ok: true, pack: result.row, match: result.match ?? null });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}

/** DELETE → forget the mapping, keeping the zip and its rules. */
export async function DELETE({ params }) {
	const cfg = await loadCluster();
	const lock = await loadPacksLock();

	try {
		const row = await forgetRespackIdentity(cfg, lock, params.key);

		await savePacksLock(lock);
		pushEvent('packs', 'action', `resource pack ${params.key} unmapped`);

		return json({ ok: true, pack: row });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
