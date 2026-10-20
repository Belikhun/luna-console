// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { isResourceType, listResources, tagVocabulary } from '$core/resources';
import { filterAllowed } from '$lib/server/authz';

/**
 * GET ?type=&createdBy=&tag=k=v&tag=k → every recorded resource the account may
 * describe, with the tag vocabulary for the filters.
 */
export async function GET({ url, locals }) {
	const type = url.searchParams.get('type') ?? undefined;

	if (type && !isResourceType(type)) {
		throw error(400, `unknown resource type ${type}`);
	}

	const tags: Record<string, string> = {};

	for (const entry of url.searchParams.getAll('tag')) {
		const eq = entry.indexOf('=');

		if (eq < 0) {
			tags[entry] = '';
		} else {
			tags[entry.slice(0, eq)] = entry.slice(eq + 1);
		}
	}

	const [rows, vocabulary] = await Promise.all([
		listResources({
			type: type as never,
			createdBy: url.searchParams.get('createdBy') ?? undefined,
			tags: Object.keys(tags).length > 0 ? tags : undefined
		}),
		tagVocabulary()
	]);

	const visible = await filterAllowed(locals, 'tag:Describe', rows, (row) => row.id);

	return json({ resources: visible, vocabulary });
}
