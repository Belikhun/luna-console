// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';

import { validatePolicyYaml } from '$core/iam';
import { jsonBody } from '$lib/server/http';

/** POST { yaml } → { ok, issues, statements }; what the editor asks as the operator types. */
export async function POST({ request }) {
	const body = await jsonBody(request);

	return json(await validatePolicyYaml(String(body.yaml ?? '')));
}
