// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';
import { SOFTWARE_IDS, hasLoaderVersions, hasProvider, traitsOf } from '$core/software';

/**
 * GET → every server software luna knows, with the facts a picker needs.
 *
 * The traits table is a constant, so this answers from memory rather than from
 * the daemon; only the version lists behind it reach an upstream API.
 */
export function GET() {
	const software = SOFTWARE_IDS.map((id) => {
		const traits = traitsOf(id);

		return {
			id,
			label: traits.label,
			kind: traits.kind,
			isProxy: traits.isProxy,
			usesJava: traits.usesJava,
			addonDirs: traits.addonDirs,
			provisionable: hasProvider(id),
			hasLoaderVersions: hasLoaderVersions(id),
			experimental: traits.experimental ?? false
		};
	});

	return json({ software });
}
