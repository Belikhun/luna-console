import { json, error } from '@sveltejs/kit';

import { loadCluster, saveCluster } from '$core/config';
import { draft as loadDraft, state as loadState } from '$core/selector';
import { applyDraftToCluster, validateSelectorDraft, type SelectorDraft } from '$core/selector';
import { pushEvent } from '$lib/server/luna';
import { errorMessage, jsonBody } from '$lib/server/http';

/** GET → the editor's whole world: the draft, its state, and what is unplaced. */
export async function GET() {
	const cfg = await loadCluster();
	const draft = await loadDraft(cfg);
	const state = await loadState(cfg);

	const unplaced = Object.entries(draft.servers)
		.filter(([, server]) => !server.selector)
		.map(([name]) => name);

	return json({ draft, state, unplaced });
}

/**
 * PATCH → save an edited draft.
 *
 * Saving is deliberately separate from applying, and deliberately permissive:
 * an admin mid-edit may well have a duplicate slot or a blank name, and being
 * unable to save that is worse than saving it. `apply` is where validation bites.
 */
export async function PATCH({ request }) {
	const body = (await jsonBody(request)) as { draft?: SelectorDraft };

	if (!body?.draft || typeof body.draft !== 'object' || !body.draft.servers) {
		throw error(400, 'a draft is required');
	}

	try {
		const cfg = await loadCluster();
		applyDraftToCluster(cfg, body.draft);
		await saveCluster(cfg);

		const issues = validateSelectorDraft(body.draft);
		pushEvent('proxy', 'action', 'server selector edited');

		return json({ saved: true, issues });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
