import { json } from '@sveltejs/kit';
import * as luna from '$core/services/luna';

/** GET → one registered player's full profile, aggregates and permissions. */
export async function GET({ params }) {
	const result = await luna.registeredPlayer(params.player);

	if (!result.ok) {
		return json(
			{ available: false, error: result.error ?? 'unknown error' },
			{ status: result.status === 404 ? 404 : 200 }
		);
	}

	return json({ available: true, ...result.data });
}
