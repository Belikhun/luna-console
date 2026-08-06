// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Who the CLI is acting as.
 *
 * The CLI never signs in. A shell that can reach the daemon socket is already
 * inside the trust boundary; the socket's own file permissions are the check, and
 * asking for a password on top of that would only mean an operator with root on
 * the box types one before doing what they could do anyway. So the CLI acts as
 * `root`: the reserved identity that means "the machine itself", which is why no
 * console account may be created under that name.
 *
 * `LUNA_ACTOR` overrides it, and one caller sets it: the console's terminal
 * drawer runs this same binary on behalf of a signed-in account, and attributing
 * those commands to `root` would put a hole in the audit trail exactly where the
 * console's own users are.
 */

import { ROOT_ACTOR } from "../core/accounts";

export { ROOT_ACTOR };

/** The identity this process records for anything it changes. */
export function activeUser(): string {
	const given = process.env.LUNA_ACTOR?.trim();

	return given || ROOT_ACTOR;
}

/** `user@luna`, for the REPL prompt and anywhere else the shell names itself. */
export function actorPrompt(): string {
	return `${activeUser()}@luna`;
}
