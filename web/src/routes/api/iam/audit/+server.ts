// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';

import { iamAudit } from '$core/iam';

/** GET ?target=&limit= → the IAM audit trail, newest first. */
export async function GET({ url }) {
	const target = url.searchParams.get('target') ?? undefined;
	const limit = Number(url.searchParams.get('limit') ?? 200);

	return json({ audit: await iamAudit({ target, limit: Number.isFinite(limit) ? limit : 200 }) });
}
