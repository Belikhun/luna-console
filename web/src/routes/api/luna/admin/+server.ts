import { json, error } from '@sveltejs/kit';
import * as luna from '$core/services/luna';
import { pushEvent } from '$lib/server/mrds';

/**
 * POST { action, ... } → an administrative action on the live network.
 *
 * Actions are named rather than mapped onto REST paths so the console has one
 * endpoint to call and one place where every action is audit-logged into the
 * cluster event log. The result is whatever LunaCore reported: a command's own
 * output, how many players a broadcast reached, whether a transfer was accepted.
 */
export async function POST({ request }) {
	const body = await request.json();
	const action = String(body.action ?? '');

	if (action === 'command') {
		const command = String(body.command ?? '').trim();

		if (!command) {
			throw error(400, 'command is required');
		}

		const result = await luna.runCommand(command);

		pushEvent('proxy', 'action', `console command: ${command}`);

		return json(result);
	}

	if (action === 'broadcast') {
		const message = String(body.message ?? '').trim();

		if (!message) {
			throw error(400, 'message is required');
		}

		const result = await luna.broadcast(message, body.server ? String(body.server) : undefined);

		pushEvent('proxy', 'action', `broadcast to ${result.data?.reached ?? 0} player(s)`);

		return json(result);
	}

	const player = String(body.player ?? '').trim();

	if (!player) {
		throw error(400, 'player is required');
	}

	if (action === 'kick') {
		const result = await luna.kick(player, String(body.reason ?? ''));

		pushEvent('proxy', 'action', `kicked ${player}`);

		return json(result);
	}

	if (action === 'message') {
		const text = String(body.message ?? '').trim();

		if (!text) {
			throw error(400, 'message is required');
		}

		return json(await luna.message(player, text));
	}

	if (action === 'transfer') {
		const server = String(body.server ?? '').trim();

		if (!server) {
			throw error(400, 'server is required');
		}

		const result = await luna.transfer(player, server);

		pushEvent(server, 'action', `${player} moved in from the console`);

		return json(result);
	}

	throw error(400, `unknown action: ${action}`);
}
