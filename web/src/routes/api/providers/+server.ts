import { json } from '@sveltejs/kit';
import { providerStatus } from '$core/services/providers';

/**
 * GET; availability of every addon provider, for the install dialogs'
 * provider tabs. CurseForge reports itself unavailable until the daemon is
 * given an API key.
 */
export async function GET() {
	return json({ providers: await providerStatus() });
}
