import { json, error } from '@sveltejs/kit';
import { loadCluster } from '$core/config';
import { loadPacksLock, savePacksLock } from '$core/packslock';
import {
	forgetDataPackIdentity,
	identifyDataPack,
	probeDataPackIdentity
} from '$core/datapacks';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';
import type { ProviderId } from '$core/types';

/**
 * The provider mapping of one pooled data pack. Same three steps as the other
 * kinds: grade, record, drop; the pool zip and the worlds already holding it
 * are untouched throughout.
 */

/** GET ?provider=&project= → what this pack's pooled zip could be. */
export async function GET({ params, url }) {
	const project = url.searchParams.get('project');

	if (!project) {
		throw error(400, 'project required');
	}

	const provider = (url.searchParams.get('provider') ?? 'modrinth') as ProviderId;

	try {
		const probe = await probeDataPackIdentity(
			await loadPacksLock(),
			params.name,
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
		const result = await identifyDataPack(cfg, lock, params.name, {
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
			`data pack ${params.name} mapped to ${result.probe.provider}:${result.probe.project.slug}` +
				`${result.match ? ` ${result.match.versionNumber}` : ' (version unknown)'}`
		);

		return json({ ok: true, entry: result.entry, match: result.match ?? null });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}

/** DELETE → forget the mapping, keeping the pool zip and its targets. */
export async function DELETE({ params }) {
	const lock = await loadPacksLock();

	try {
		const entry = await forgetDataPackIdentity(lock, params.name);

		await savePacksLock(lock);
		pushEvent('packs', 'action', `data pack ${params.name} unmapped`);

		return json({ ok: true, entry });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
