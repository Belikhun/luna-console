// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The signed-in account, for the chrome. `hooks.server.ts` already resolved it,
 * so this only hands it to the layout; the account menu in the top bar must not
 * have to fetch who it belongs to after the page has painted.
 */

import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
	return { account: locals.account };
};
