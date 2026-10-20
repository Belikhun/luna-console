// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Who a daemon call is made for.
 *
 * Every RPC carries an actor in the `x-luna-actor` header: the daemon records
 * it as the creator of whatever the op created, and the console journal and the
 * audit trails name it. The web server handles many accounts at once, so the
 * actor is request-scoped through an `AsyncLocalStorage`: `withActor` wraps a
 * request and every `dfetch` inside it reads the name back. Outside any such
 * scope (the CLI, a scheduler tick) the value is `LUNA_ACTOR`, which the
 * console's terminal drawer sets, or `root`.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { ROOT_ACTOR } from "../core/accounts";

const storage = new AsyncLocalStorage<string>();

/** Run `fn` with every daemon call inside it attributed to `actor`. */
export function withActor<T>(actor: string, fn: () => T): T {
	return storage.run(actor, fn);
}

/** The actor the current call is attributed to. */
export function currentActor(): string {
	const scoped = storage.getStore();

	if (scoped) {
		return scoped;
	}

	const given = process.env.LUNA_ACTOR?.trim();

	return given || ROOT_ACTOR;
}
