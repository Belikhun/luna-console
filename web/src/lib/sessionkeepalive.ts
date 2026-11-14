// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Keeps the console session alive while a tab is open.
 *
 * The gate renews a session whenever a request reaches it (`resolveSession` in
 * core/accounts.ts), but a screen that only follows an SSE stream (a job's card,
 * Mèo Béo's answer, a build log) sends no request for hours, and its operator
 * came back to the sign-in page with the work done behind it. Every open tab
 * asks `/api/auth/session` on a timer: a cheap read that passes the gate like any
 * other, so it renews the session and re-issues the cookie.
 *
 * Hidden tabs keep beating on purpose, since that is where a long task is
 * usually left running. A session nobody has open still lapses 12 hours after
 * its last tab closed, and none outlives `SESSION_MAX_AGE_MS`.
 */

/**
 * How often an open tab checks in. The store renews at most once per
 * `SESSION_TOUCH_MS` (5 minutes), so a shorter beat would only cost requests.
 */
const HEARTBEAT_MS = 10 * 60 * 1000;

/**
 * A tab that comes back into view, or back online, checks in at once when its
 * last beat is older than this: a browser throttles or freezes a background
 * tab's timers, and a laptop that slept missed every beat.
 */
const RESUME_MS = 60 * 1000;

/**
 * Start the heartbeat for this tab; returns the function that stops it. Call it
 * only while an account is signed in.
 */
export function keepSessionAlive(): () => void {
	let lastBeat = Date.now();

	async function beat(): Promise<void> {
		lastBeat = Date.now();

		try {
			await fetch('/api/auth/session', { cache: 'no-store' });
		} catch {
			// offline, or the console is restarting; the next beat tries again
		}
	}

	function resume(): void {
		if (document.visibilityState !== 'visible') {
			return;
		}

		if (Date.now() - lastBeat < RESUME_MS) {
			return;
		}

		void beat();
	}

	const timer = setInterval(() => {
		void beat();
	}, HEARTBEAT_MS);

	document.addEventListener('visibilitychange', resume);
	window.addEventListener('online', resume);

	return () => {
		clearInterval(timer);
		document.removeEventListener('visibilitychange', resume);
		window.removeEventListener('online', resume);
	};
}
