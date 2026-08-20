// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';

import { instanceThreads } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/** Bounds on the caller's window, so a stray query cannot hold a daemon call open. */
const MIN_WINDOW_MS = 200;
const MAX_WINDOW_MS = 5000;

/**
 * GET → per-thread CPU of one instance's process, measured over a window.
 *
 * The request is deliberately slow: a rate is two readings apart in time, so the
 * daemon holds the call for the length of the window. `?window=` tunes it - a
 * longer window smooths a bursty thread, a shorter one keeps the panel snappy.
 *
 * A null report is a normal answer, not a failure: the instance may be stopped,
 * external, or owned by a daemon that cannot be reached, and none of those have a
 * process to walk.
 */
export async function GET({ params, url }) {
	// the raw param is checked before the cast: an absent one is null, Number(null)
	// is a perfectly finite 0, and clamping that would pin every default request to
	// the floor instead of letting the daemon pick its own window
	const raw = url.searchParams.get('window');
	const requested = raw === null || raw === '' ? Number.NaN : Number(raw);
	const windowMs = Number.isFinite(requested)
		? Math.min(MAX_WINDOW_MS, Math.max(MIN_WINDOW_MS, requested))
		: undefined;

	// An owner that cannot answer is one of the normal cases, not a fault: the call is
	// routed to the machine holding the process, and that daemon may be offline,
	// quarantined, or running a build that has never heard of this op. All of those
	// mean the same thing to the panel - no report - and none of them is a 500.
	try {
		return json({ report: await instanceThreads(params.name, windowMs) });
	} catch (err) {
		return json({ report: null, reason: errorMessage(err) });
	}
}
