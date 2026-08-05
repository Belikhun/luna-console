// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { revealAndRecord } from '$core/environment';
import { listDaemons } from '$client/daemon';
import { machineKeyFor } from '$shared/machines';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/**
 * POST { machine?, instance? } → the secret's real value at that scope.
 *
 * Deliberately a POST, not a GET: revealing a secret is an action that gets
 * recorded, and a GET would be linkable, cacheable and prefetchable. The daemon
 * appends the read to the environment store's trail, so the variable's own screen
 * can show that it was looked at and when.
 */
export async function POST({ params, request }) {
	const body = await request.json().catch(() => ({}));
	const name = params.name;

	if (!name) {
		throw error(400, 'name is required');
	}

	const instance = body.instance ? String(body.instance) : undefined;
	const machineName = body.machine !== undefined && body.machine !== null ? String(body.machine) : undefined;

	if (instance && machineName !== undefined) {
		throw error(400, 'a scope is an instance or a machine, not both');
	}

	let machine: string | undefined;

	if (machineName !== undefined) {
		machine = machineKeyFor(await listDaemons(), machineName);

		if (machine === undefined) {
			throw error(400, `unknown machine: ${machineName}`);
		}
	}

	try {
		const revealed = await revealAndRecord(name, {
			...(instance !== undefined ? { instance } : {}),
			...(machine !== undefined ? { machine } : {})
		});

		pushEvent(
			'env',
			'action',
			`secret ${name} revealed in the console (${revealed.scope}${revealed.target ? ` · ${revealed.target}` : ''})`
		);

		return json(revealed);
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
