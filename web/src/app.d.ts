// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces

import type { AccountSummary } from '$core/accounts';

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			/**
			 * The signed-in console account, resolved once per request in
			 * `hooks.server.ts`. Null only on the login screen and the two public
			 * auth endpoints; every other route is refused without one.
			 */
			account: AccountSummary | null;
			/** The bearer token from the cookie; what a sign-out and "revoke the others" need */
			sessionToken: string | null;
			/** Id of the session this request arrived on, when it arrived on one */
			sessionId: string | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
