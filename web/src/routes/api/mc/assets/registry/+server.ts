// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { registryResponse } from '$lib/server/mcassets';

/**
 * GET → the item registry: every material the editor can offer, and how each is
 * drawn. The handler is shared with the public page's mirror.
 */
export async function GET({ request }) {
	return await registryResponse(request);
}
