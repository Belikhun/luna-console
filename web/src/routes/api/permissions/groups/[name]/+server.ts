import { json, error } from '@sveltejs/kit';
import * as luna from '$core/services/luna';
import { pushEvent } from '$lib/server/luna';

/** GET → one group with its full node list and direct members. */
export async function GET({ params }) {
	const result = await luna.permissionGroup(params.name);

	if (!result.ok) {
		return json(
			{ available: false, error: result.error ?? 'unknown error' },
			{ status: result.status === 404 ? 404 : 200 }
		);
	}

	return json({ available: true, ...result.data });
}

/** DELETE → remove the group (LuckPerms refuses to drop `default`). */
export async function DELETE({ params }) {
	const result = await luna.deletePermissionGroup(params.name);

	if (result.ok) {
		pushEvent('proxy', 'action', `permission group deleted: ${params.name}`);
	}

	return json(result);
}

/**
 * POST { op: "node" | "meta", ... } → edit the group.
 *
 * `node` carries { action, key, value?, expirySeconds?, contexts? };
 * `meta` carries { field: weight|prefix|suffix|displayname, value, priority? }.
 */
export async function POST({ params, request }) {
	const body = await request.json();
	const op = String(body.op ?? '');

	if (op === 'node') {
		const result = await luna.editGroupNode(params.name, {
			action: body.action === 'remove' ? 'remove' : 'add',
			key: String(body.key ?? ''),
			...(body.value !== undefined ? { value: Boolean(body.value) } : {}),
			...(body.expirySeconds ? { expirySeconds: Number(body.expirySeconds) } : {}),
			...(body.contexts ? { contexts: body.contexts } : {})
		});

		if (result.ok) {
			pushEvent('proxy', 'action', `group ${params.name} node ${body.action}: ${body.key}`);
		}

		return json(result);
	}

	if (op === 'meta') {
		const field = String(body.field ?? '');

		if (!['weight', 'prefix', 'suffix', 'displayname'].includes(field)) {
			throw error(400, `unknown meta field: ${field}`);
		}

		const result = await luna.editGroupMeta(
			params.name,
			field as 'weight' | 'prefix' | 'suffix' | 'displayname',
			String(body.value ?? ''),
			body.priority !== undefined ? Number(body.priority) : undefined
		);

		if (result.ok) {
			pushEvent('proxy', 'action', `group ${params.name} meta: ${field} = ${body.value}`);
		}

		return json(result);
	}

	throw error(400, `unknown op: ${op}`);
}
