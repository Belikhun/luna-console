// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/** Key hints as people read them on their own keyboard. */

/** Whether the browser runs on an Apple platform, where Ctrl's shortcuts take Cmd. */
export function isApplePlatform(): boolean {
	if (typeof navigator === 'undefined') {
		return false;
	}

	const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
	const platform = data?.platform || navigator.platform || '';

	return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * A shortcut written the portable way (`Ctrl+C`, `Shift+Alt+F`) as this
 * platform names it: on macOS `Ctrl` becomes `⌘` and `Alt` becomes `⌥`.
 * The text is protocol text, never a language key.
 *
 * @param shortcut keys joined with `+`
 * @returns the hint to draw
 */
export function shortcutLabel(shortcut: string): string {
	if (!isApplePlatform()) {
		return shortcut;
	}

	return shortcut
		.split('+')
		.map((key) => {
			if (key === 'Ctrl') {
				return '⌘';
			}

			if (key === 'Alt') {
				return '⌥';
			}

			return key;
		})
		.join('+');
}
