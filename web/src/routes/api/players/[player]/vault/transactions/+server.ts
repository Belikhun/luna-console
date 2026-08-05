import { json } from '@sveltejs/kit';
import * as luna from '$core/services/luna';

/** GET ?page=&pageSize= → a page of the player's transactions, newest first. */
export async function GET({ params, url }) {
	const page = Number(url.searchParams.get('page') ?? 0);
	const pageSize = Number(url.searchParams.get('pageSize') ?? 25);

	const result = await luna.vaultTransactions(
		params.player,
		Number.isFinite(page) ? page : 0,
		Number.isFinite(pageSize) ? pageSize : 25
	);

	if (!result.ok) {
		return json({ available: false, error: result.error ?? 'unknown error' });
	}

	return json({ available: true, ...result.data });
}
