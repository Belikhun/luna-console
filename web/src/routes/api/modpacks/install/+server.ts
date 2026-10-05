// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import { loadCluster, loadLock, saveCluster } from '$core/config';
import { completeProvision, installModpack } from '$core/modpack';
import { parseJavaAgents, parseJavaArgs, validateJavaAgents, validateJavaArgs, validateSettings } from '$core/settings';
import { validateRuntimeId } from '$core/runtimes';
import { pushEvent } from '$lib/server/luna';
import { startJob } from '$lib/server/jobs';
import { errorMessage, jsonBody } from '$lib/server/http';

/** The loaders a pack can name, as the provisioning row labels its software. */
const PACK_SOFTWARE = new Set(['fabric', 'forge', 'neoforge']);

/**
 * POST { name, slug | mrpackStage, versionId?, software?, memory?, port?, profile?, runtime?,
 * daemon?, register?, skipOptional?, settings?, javaArgs?, javaAgents?,
 * autoRestart?, restartDelay?, addonGroups?, pluginOverrides? } → provision an
 * instance from a Modrinth modpack, as a job: the pack alone is hundreds of
 * downloads.
 *
 * `software` is only a label: the page knows the loader of the version it
 * picked, and the provisioning row shows it before the pack's index has even
 * been read. The install itself takes the loader from the index.
 *
 * Everything cheap to check is checked here, as the plain create route does,
 * so a bad flag is a 400 and not a job that fails after the download.
 */
export async function POST({ request }) {
	const body = await jsonBody(request);
	const name = String(body.name ?? '').trim();
	const slug = String(body.slug ?? '').trim();
	const mrpackStage = String(body.mrpackStage ?? '').trim();

	if (!/^[a-z0-9_-]+$/.test(name)) {
		throw error(400, 'name must be lowercase letters, digits, - or _');
	}

	if (!slug === !mrpackStage) {
		throw error(400, 'give a Modrinth slug or an uploaded mrpackStage, not both');
	}

	const settings: Record<string, string> = body.settings && typeof body.settings === 'object' ? body.settings : {};
	const javaArgs = Array.isArray(body.javaArgs)
		? body.javaArgs.map(String)
		: parseJavaArgs(String(body.javaArgs ?? ''));
	const javaAgents = Array.isArray(body.javaAgents)
		? body.javaAgents.map(String)
		: parseJavaAgents(String(body.javaAgents ?? ''));

	const badSettings = validateSettings(settings);

	if (badSettings.length) {
		throw error(400, badSettings.map((problem) => problem.error).join('; '));
	}

	const badArgs = validateJavaArgs(javaArgs);

	if (badArgs) {
		throw error(400, badArgs);
	}

	const badAgents = validateJavaAgents(javaAgents);

	if (badAgents) {
		throw error(400, badAgents);
	}

	const runtime = body.runtime ? String(body.runtime) : undefined;
	const badRuntime = runtime ? validateRuntimeId(runtime) : undefined;

	if (badRuntime) {
		throw error(400, badRuntime);
	}

	const addonGroups = Array.isArray(body.addonGroups) ? body.addonGroups.map(String) : undefined;

	if (addonGroups?.length) {
		const lock = await loadLock();
		const unknown = addonGroups.filter((group: string) => !lock.groups?.[group]);

		if (unknown.length) {
			throw error(400, `unknown addon group(s): ${unknown.join(', ')}`);
		}
	}

	const cfg = await loadCluster();

	if (cfg.instances[name]) {
		throw error(409, `an instance named ${name} already exists`);
	}

	const pluginOverrides =
		body.pluginOverrides && typeof body.pluginOverrides === 'object'
			? Object.fromEntries(Object.entries(body.pluginOverrides).map(([key, value]) => [key, !!value]))
			: undefined;

	const register = body.register !== false;
	const targetDaemon = typeof body.daemon === 'string' && body.daemon ? body.daemon : null;
	const label = PACK_SOFTWARE.has(String(body.software)) ? String(body.software) : 'fabric';

	const job = startJob('modpack-install', name, `Install modpack ${slug || 'upload'} as ${name}`, async (reporter) => {
		const fresh = await loadCluster();
		const lock = await loadLock();

		reporter.weighOwn(0);

		const pack = reporter.child('Modpack', 10);
		const plugins = reporter.child('Plugins', 2);
		const packs = reporter.child('Packs', 1);
		const ports = reporter.child('Port allocations', 1);
		const proxy = reporter.child('Proxy registration', 1);

		try {
			const result = await installModpack(fresh, name, {
				...(slug ? { slug } : { mrpackStage }),
				versionId: slug && body.versionId ? String(body.versionId) : undefined,
				memory: body.memory ? String(body.memory) : undefined,
				port: body.port ? Number(body.port) : undefined,
				profile: body.profile ? String(body.profile) : undefined,
				runtime,
				daemon: targetDaemon ?? undefined,
				register,
				skipOptional: body.skipOptional === true,
				settings,
				javaArgs,
				javaAgents,
				autoRestart: body.autoRestart === undefined ? undefined : !!body.autoRestart,
				restartDelay: body.restartDelay === undefined ? undefined : Number(body.restartDelay),
				addonGroups,
				pluginOverrides,
				reporter: pack
			});

			await saveCluster(fresh);

			const outcome = await completeProvision(fresh, lock, name, { plugins, packs, ports, proxy }, register);

			pushEvent(
				name,
				'action',
				`instance created from modpack ${result.modpack.name} ${result.modpack.versionNumber} (${result.software} ${result.mcVersion}, port ${result.port})`
			);

			return { ...result, ...outcome };
		} catch (err) {
			pushEvent(name, 'error', `modpack install failed: ${errorMessage(err)}`);

			throw err;
		}
	}, { daemon: targetDaemon, software: label });

	return json({ ok: true, job });
}
