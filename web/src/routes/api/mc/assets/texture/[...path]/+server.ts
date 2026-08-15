// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { textureResponse } from '$lib/server/mcassets';

/**
 * GET → one item or block texture, e.g. `/api/mc/assets/texture/item/compass.png`.
 * The handler is shared with the public page's mirror.
 */
export async function GET({ params }) {
	return await textureResponse(params.path ?? '');
}
