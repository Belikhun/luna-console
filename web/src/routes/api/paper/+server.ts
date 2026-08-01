import { json } from '@sveltejs/kit';
import { listVersions } from '$core/services/papermc';

/** The list moves at PaperMC's release cadence — ten minutes is plenty fresh. */
const CACHE_TTL_MS = 600_000;

let cache: { at: number; versions: string[] } | undefined;

/** Newest first: compare major, minor and patch numerically, missing = 0. */
function byVersionDesc(a: string, b: string): number {
	const left = a.split('.').map(Number);
	const right = b.split('.').map(Number);

	for (let i = 0; i < 3; i++) {
		const delta = (right[i] ?? 0) - (left[i] ?? 0);

		if (delta) {
			return delta;
		}
	}

	return 0;
}

/** GET → the Minecraft versions the launch form offers, newest first. */
export async function GET() {
	if (!cache || Date.now() - cache.at > CACHE_TTL_MS) {
		// plain x.y / x.y.z only — the API also lists snapshots and pre-releases
		const versions = (await listVersions('paper')).filter((version) =>
			/^\d+\.\d+(\.\d+)?$/.test(version)
		);

		versions.sort(byVersionDesc);

		cache = { at: Date.now(), versions };
	}

	return json({ versions: cache.versions });
}
