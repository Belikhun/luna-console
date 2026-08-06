// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { redirect } from '@sveltejs/kit';

/**
 * The Console group has no landing page of its own; Accounts is its first screen.
 * The redirect exists because the breadcrumb strip links every path segment, so
 * without it the "Console" crumb on every screen below here is a 404.
 */
export function load() {
	throw redirect(307, '/console/accounts');
}
