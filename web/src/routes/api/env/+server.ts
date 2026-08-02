import { json, error } from '@sveltejs/kit';

import { loadEnv, saveEnv, setVariable, unsetVariable } from '$core/environment';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/**
 * GET → every variable and per-instance override. Secret values never leave
 * the server — the client gets `secret: true` and an empty value.
 */
export async function GET() {
	const env = await loadEnv();

	const variables = Object.entries(env.variables).map(([name, def]) => ({
		name,
		value: def.secret ? '' : def.value,
		secret: !!def.secret,
		description: def.description ?? ''
	}));

	const instances = Object.fromEntries(
		Object.entries(env.instances).map(([instance, vars]) => [instance, Object.keys(vars).sort()])
	);

	return json({ variables: variables.sort((a, b) => a.name.localeCompare(b.name)), instances });
}

/** POST { name, value, secret?, description?, instance? } → set a variable. */
export async function POST({ request }) {
	const body = await request.json();
	const env = await loadEnv();

	try {
		setVariable(env, String(body.name ?? ''), String(body.value ?? ''), {
			secret: !!body.secret,
			description: body.description !== undefined ? String(body.description) : undefined,
			instance: body.instance ? String(body.instance) : undefined
		});
	} catch (err) {
		throw error(400, errorMessage(err));
	}

	await saveEnv(env);
	pushEvent('env', 'action', `variable ${body.name} set${body.instance ? ` on ${body.instance}` : ''}`);

	return json({ ok: true });
}

/** DELETE ?name=&instance= → remove a variable or one instance's override. */
export async function DELETE({ url }) {
	const env = await loadEnv();
	const name = url.searchParams.get('name') ?? '';
	const instance = url.searchParams.get('instance') ?? undefined;

	if (!unsetVariable(env, name, instance)) {
		throw error(404, `${name} is not set${instance ? ` on ${instance}` : ''}`);
	}

	await saveEnv(env);
	pushEvent('env', 'action', `variable ${name} removed${instance ? ` from ${instance}` : ''}`);

	return json({ ok: true });
}
