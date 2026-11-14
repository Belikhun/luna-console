// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * What a state looks like, shared by `StatusBadge` and the popover rows of
 * `InfoPopover`: a colour and an icon per state word.
 */

/** Structured popover row: a nested state icon + name, with secondary detail. */
export interface StatusDetailRow {
	state: string;
	label: string;
	detail?: string;
}

/** What a popover holds: plain lines, or state rows. */
export type PopoverDetail = string | Array<string | StatusDetailRow>;

export interface StateStyle {
	color: string;
	icon: string;
	spin?: boolean;
}

export const FALLBACK_STYLE: StateStyle = { color: 'var(--text-secondary)', icon: 'circleQuestion' };

export const STATE_STYLES: Record<string, StateStyle> = {
	running: { color: 'var(--success)', icon: 'circleCheck' },
	// the game loop is asleep on an empty server (pause-when-empty): still up,
	// still answering pings, resumes on the first join; calm blue, not amber
	paused: { color: 'var(--info)', icon: 'circlePause' },
	ok: { color: 'var(--success)', icon: 'circleCheck' },
	passed: { color: 'var(--success)', icon: 'circleCheck' },
	stopped: { color: 'var(--text-secondary)', icon: 'ban' },
	failed: { color: 'var(--error)', icon: 'circleXMark' },
	incompatible: { color: 'var(--error)', icon: 'circleXMark' },
	error: { color: 'var(--error)', icon: 'circleXMark' },
	starting: { color: 'var(--text-secondary)', icon: 'rotate', spin: true },
	stopping: { color: 'var(--warning)', icon: 'rotate', spin: true },
	restarting: { color: 'var(--text-secondary)', icon: 'rotate', spin: true },
	// not asked for: the server went down on its own and the wrapper is waiting
	// to relaunch it, which is worth an amber rather than the neutral spinner
	'auto-restarting': { color: 'var(--warning)', icon: 'rotate', spin: true },
	provisioning: { color: 'var(--link)', icon: 'rotate', spin: true },
	deleting: { color: 'var(--warning)', icon: 'rotate', spin: true },
	pending: { color: 'var(--text-secondary)', icon: 'rotate', spin: true },
	// an addon the server has begun loading: amber to match its slice of the
	// distribution bar, spinning because it is a phase that resolves on its own
	loading: { color: 'var(--warning)', icon: 'rotate', spin: true },
	warning: { color: 'var(--warning)', icon: 'triangleExclamation' },
	// a plain statement of fact rather than a state: a linked identity, an
	// ordinary entry in an audit trail, a note beside a title
	info: { color: 'var(--info)', icon: 'circleInfo' },
	unknown: { color: 'var(--text-secondary)', icon: 'circleQuestion' },
	external: { color: 'var(--text-secondary)', icon: 'externalLink' }
};

/** The look of a state word, or the neutral one for a word nobody declared. */
export function stateStyle(state: string): StateStyle {
	return STATE_STYLES[state] ?? FALLBACK_STYLE;
}
