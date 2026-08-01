import { json } from '@sveltejs/kit';
import * as luna from '$core/services/luna';

/**
 * GET → LunaCore's network telemetry for every backend the proxy knows, external
 * servers included. An unreachable proxy is reported in the body rather than as an
 * HTTP error: the page shows a "telemetry unavailable" state and keeps working on
 * the data mrds collects itself.
 */
export async function GET() {
	const result = await luna.dashboard();

	if (!result.ok) {
		return json({ available: false, error: result.error ?? 'unknown error' });
	}

	return json({ available: true, runtimeMillis: result.runtimeMillis, ...result.data });
}
