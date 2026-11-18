// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/** One row of a `RankedList`: a path, a referrer, a user agent. */
export interface RankedRow {
	/** Stable identity; also the text shown when there is no `label` */
	key: string;
	label?: string;
	count: number;
	/** The row's own view (its requests, its error group); the whole row is the link */
	href?: string;
	/** Paths and user agents: the mono face, cut in the middle so both ends stay */
	mono?: boolean;
	/** A Font Awesome name drawn before the label (a browser, a bot) */
	icon?: string;
	/** A quieter second figure beside the count: an error share, a p95 */
	secondary?: string;
	/** A row that is itself a problem gets a warning or error icon */
	tone?: 'warning' | 'critical';
}

/** Characters a mono label keeps at its end when it is cut in the middle. */
export const MONO_TAIL = 14;

/** A mono label cut into a head that may shrink and a tail that stays whole. */
export function middleCut(text: string): { head: string; tail: string } {
	if (text.length <= MONO_TAIL * 2) {
		return { head: text, tail: '' };
	}

	return {
		head: text.slice(0, -MONO_TAIL),
		tail: text.slice(-MONO_TAIL)
	};
}
