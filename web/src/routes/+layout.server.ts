// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The signed-in account, for the chrome. `hooks.server.ts` already resolved it,
 * so this only hands it to the layout; the account menu in the top bar must not
 * have to fetch who it belongs to after the page has painted.
 */

import type { LayoutServerLoad } from './$types';

import { principalContext } from '$core/iam';

/**
 * The principal's context travels with the account: the documents that apply
 * to it and its tags, so the browser evaluates the same grammar the gate does
 * when it hides a nav entry or disables a verb. It is a read, never a decision;
 * every API call is still decided server-side.
 */
export const load: LayoutServerLoad = async ({ locals }) => {
	const principal = locals.account
		? await principalContext(locals.account.id).catch(() => null)
		: null;

	return { account: locals.account, principal };
};
