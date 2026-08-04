import { json, error } from '@sveltejs/kit';
import { loadCluster } from '$core/config';
import { loadPacksLock, savePacksLock } from '$core/packslock';
import {
	dynamicResourcePacks,
	releaseDynamicPack,
	takeOverDynamicPack
} from '$core/respacks';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/**
 * Packs that plugins register with luna-pack at runtime, and the two verbs that
 * move one across the line between them and luna.
 *
 * The listing itself is part of `GET /api/respacks` (the rows carry their own
 * registration); this route exists for the raw runtime view and the transfers.
 */

/** GET → the proxy's runtime registrations, or why they are unknown. */
export async function GET() {
	return json({ dynamic: await dynamicResourcePacks() });
}

/**
 * POST { key, action: "takeover" | "release" }
 *
 * `takeover` writes the definition luna-pack prefers, seeded from the running
 * registration, so the operator owns priority/rules/enablement from then on.
 * `release` deletes it again and hands the pack back to its plugin.
 */
export async function POST({ request }) {
	const body = await request.json();
	const key = String(body.key ?? '');
	const action = String(body.action ?? '');

	if (!key) {
		throw error(400, 'key required');
	}

	const cfg = await loadCluster();
	const lock = await loadPacksLock();

	try {
		if (action === 'takeover') {
			const { row, from } = await takeOverDynamicPack(cfg, lock, key);

			// the takeover is recorded in the lock, which is what makes it reversible
			await savePacksLock(lock);
			pushEvent('packs', 'action', `resource pack ${key} taken over from its plugin`);

			return json({ ok: true, pack: row, from });
		}

		if (action === 'release') {
			const { removed, dynamic } = await releaseDynamicPack(cfg, lock, key);

			await savePacksLock(lock);
			pushEvent('packs', 'action', `resource pack ${key} released back to its plugin`);

			return json({ ok: true, removed, dynamic: dynamic ?? null });
		}

		throw error(400, 'action must be "takeover" or "release"');
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
