import { error } from '@sveltejs/kit';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { loadCluster } from '$core/config';
import { assetsDir, pinnedMcVersion } from '$core/mcassets';

/** GET → the double-chest background the editor draws the grid on top of. */
export async function GET() {
	const cfg = await loadCluster();
	const version = pinnedMcVersion(cfg);
	const path = version ? join(assetsDir(version), 'textures', 'gui', 'container', 'generic_54.png') : undefined;

	if (!path || !existsSync(path)) {
		throw error(404, 'the Minecraft assets have not been extracted yet');
	}

	return new Response(Bun.file(path).stream(), {
		headers: {
			'Content-Type': 'image/png',
			// the file is pinned to a version, so it can never change under this URL
			'Cache-Control': 'public, max-age=31536000, immutable'
		}
	});
}
