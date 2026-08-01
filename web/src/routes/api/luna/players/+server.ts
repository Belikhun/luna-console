import { json } from '@sveltejs/kit';
import * as luna from '$core/services/luna';

/** Activity rows returned alongside the player list. */
const HISTORY_LIMIT = 50;

/**
 * GET ?server= → who is on the network right now plus recent join/leave activity.
 * The two are fetched together because the players page renders them side by side.
 */
export async function GET({ url }) {
	const server = url.searchParams.get('server') ?? undefined;

	const [list, history] = await Promise.all([
		luna.players(server),
		luna.playerHistory(Number(url.searchParams.get('limit') ?? HISTORY_LIMIT))
	]);

	if (!list.ok) {
		return json({ available: false, error: list.error ?? 'unknown error' });
	}

	return json({
		available: true,
		...list.data,
		activity: history.ok ? (history.data?.activity ?? []) : []
	});
}
