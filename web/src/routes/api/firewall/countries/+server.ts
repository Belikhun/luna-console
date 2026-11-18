// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';
import * as firewall from '$core/firewall';

/** POST → send the proxy the prefixes of every country a rule names, now. */
export async function POST() {
	return json(await firewall.syncCountries());
}
