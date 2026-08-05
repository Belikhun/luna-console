// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { redirect } from '@sveltejs/kit';

export function load() {
	throw redirect(307, '/instances');
}
