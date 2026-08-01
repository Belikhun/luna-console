import { json, error } from '@sveltejs/kit';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

import { loadCluster, saveCluster, loadLock, managedInstances, instanceDir } from '$core/config';
import { setPort, setServerProperty, setVersion } from '$core/admin';
import { syncVelocityToml } from '$core/proxy';
import { getStatus } from '$core/instances';
import { compatReport } from '$core/plugins';
import { pushEvent } from '$lib/server/mrds';

/** Read server.properties into a flat map, skipping comments and blank lines. */
function readServerProperties(path: string): Record<string, string> {
	const props: Record<string, string> = {};

	if (!existsSync(path)) {
		return props;
	}

	for (const line of readFileSync(path, 'utf8').split('\n')) {
		const pair = line.match(/^([a-zA-Z0-9.-]+)=(.*)$/);

		if (pair) {
			props[pair[1]!] = pair[2]!;
		}
	}

	return props;
}

/** GET → the instance's editable settings plus its full server.properties. */
export async function GET({ params }) {
	const cfg = await loadCluster();
	const inst = managedInstances(cfg)[params.name];

	if (!inst) {
		throw error(404, 'unknown instance');
	}

	return json({
		memory: inst.memory,
		profile: inst.profile,
		java: inst.java ?? null,
		port: inst.port,
		mcVersion: inst.mcVersion ?? null,
		profiles: Object.keys(cfg.javaProfiles),
		serverProperties: readServerProperties(join(instanceDir(inst), 'server.properties'))
	});
}

/** PATCH { memory?, profile?, java?, port?, mcVersion?, forceVersion?, properties?: {k:v} } */
export async function PATCH({ params, request }) {
	const body = await request.json();
	const cfg = await loadCluster();
	const lock = await loadLock();
	const name = params.name;
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw error(404, 'unknown instance');
	}

	const changed: string[] = [];

	if (body.memory) {
		inst.memory = body.memory;
		changed.push('memory');
	}

	if (body.profile) {
		if (!cfg.javaProfiles[body.profile]) {
			throw error(400, `unknown profile ${body.profile}`);
		}

		inst.profile = body.profile;
		changed.push('profile');
	}

	if (body.java !== undefined) {
		inst.java = body.java || undefined;
		changed.push('java');
	}

	if (body.port) {
		await setPort(cfg, name, Number(body.port));
		await syncVelocityToml(cfg);
		changed.push('port');
	}

	if (body.properties) {
		for (const [key, value] of Object.entries(body.properties as Record<string, string>)) {
			if (await setServerProperty(cfg, name, key, String(value))) {
				changed.push(`server.properties:${key}`);
			}
		}
	}

	if (body.mcVersion && body.mcVersion !== inst.mcVersion) {
		const status = await getStatus(cfg, name);

		if (status.state !== 'stopped') {
			throw error(409, 'stop the instance before changing its version');
		}

		// server-version gate per DESIGN.md — the client re-sends with forceVersion
		const incompatible = compatReport(cfg, lock, name, body.mcVersion).filter(
			(row) => row.status === 'incompatible'
		);

		if (incompatible.length && !body.forceVersion) {
			return json({ ok: false, incompatible }, { status: 409 });
		}

		const res = await setVersion(cfg, name, body.mcVersion);

		changed.push(`version ${res.from ?? '?'} → ${res.to} (build ${res.build.build})`);
	}

	await saveCluster(cfg);

	if (changed.length) {
		pushEvent(name, 'action', `config changed: ${changed.join(', ')}`);
	}

	return json({ ok: true, changed });
}
