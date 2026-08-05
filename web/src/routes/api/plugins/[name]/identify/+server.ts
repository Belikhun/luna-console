import { json, error } from '@sveltejs/kit';
import { loadCluster, loadLock, saveLock } from '$core/config';
import {
	forgetPluginIdentity,
	identifyPlugin,
	probePluginIdentity
} from '$core/plugins';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';
import type { ProviderId } from '$core/types';

/**
 * The provider mapping of one plugin or mod entry (`<plugin>@<family>`).
 *
 * GET grades what the pooled jar could be and writes nothing; POST records the
 * mapping; DELETE drops it. Only the entry changes; the jar is never
 * re-downloaded or renamed, because mapping is a statement about a file luna
 * already has.
 */

/** GET ?provider=&project= → what this entry's jar could be at that project. */
export async function GET({ params, url }) {
	const project = url.searchParams.get('project');

	if (!project) {
		throw error(400, 'project required');
	}

	const provider = (url.searchParams.get('provider') ?? 'modrinth') as ProviderId;

	try {
		const probe = await probePluginIdentity(await loadLock(), params.name, provider, project);

		return json({ probe });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}

/** POST { provider, project, versionId?, unidentified?, autoUpdate? } → map it. */
export async function POST({ params, request }) {
	const body = await request.json();
	const cfg = await loadCluster();
	const lock = await loadLock();

	if (!body.project) {
		throw error(400, 'project required');
	}

	try {
		const result = await identifyPlugin(cfg, lock, params.name, {
			provider: (body.provider ?? 'modrinth') as ProviderId,
			project: String(body.project),
			versionId: body.versionId ?? undefined,
			unidentified: body.unidentified === true,
			autoUpdate: body.autoUpdate
		});

		await saveLock(lock);
		pushEvent(
			'plugins',
			'action',
			`${params.name} mapped to ${result.probe.provider}:${result.probe.project.slug}` +
				`${result.match ? ` ${result.match.versionNumber}` : ' (version unknown)'}`
		);

		return json({ ok: true, entry: result.entry, match: result.match ?? null });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}

/** DELETE → forget the mapping, keeping the jar and its deployments. */
export async function DELETE({ params }) {
	const lock = await loadLock();

	try {
		const entry = await forgetPluginIdentity(lock, params.name);

		await saveLock(lock);
		pushEvent('plugins', 'action', `${params.name} unmapped`);

		return json({ ok: true, entry });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
