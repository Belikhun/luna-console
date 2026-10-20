// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';

import { inlinePolicyCounts } from '$core/iam';

/** GET → the counts the IAM dashboard cannot read off the policy and group lists. */
export async function GET() {
	return json({ inline: await inlinePolicyCounts() });
}
