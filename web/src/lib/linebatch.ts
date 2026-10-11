// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Live log lines, handed to the view once per frame.
 *
 * A console stream delivers a few lines per event, and a server in a loop can
 * print hundreds a second. Updating the view per line meant copying the whole
 * scrollback, re-rendering it and scrolling, hundreds of times a second, which
 * froze the tab. Lines are collected here instead and flushed on the next
 * animation frame, so the view does that work at most once a frame however
 * fast they arrive. A hidden tab gets no frames; while it waits, only the
 * newest `cap` lines are kept, since the view would trim the rest anyway.
 */

export interface LineBatcher {
	push(line: string): void;
	/** Drop what is waiting and stop flushing */
	stop(): void;
}

/**
 * Collect lines and hand them to `flush` in one batch per animation frame.
 *
 * @param cap the most lines worth keeping between frames; older ones are dropped
 */
export function lineBatcher(flush: (lines: string[]) => void, cap: number): LineBatcher {
	let pending: string[] = [];
	let frame = 0;
	let stopped = false;

	const run = (): void => {
		frame = 0;

		if (stopped || pending.length === 0) {
			return;
		}

		const batch = pending;

		pending = [];
		flush(batch);
	};

	return {
		push(line: string): void {
			if (stopped) {
				return;
			}

			pending.push(line);

			if (pending.length > cap * 2) {
				pending = pending.slice(-cap);
			}

			if (!frame) {
				frame = requestAnimationFrame(run);
			}
		},

		stop(): void {
			stopped = true;
			pending = [];

			if (frame) {
				cancelAnimationFrame(frame);
				frame = 0;
			}
		}
	};
}
