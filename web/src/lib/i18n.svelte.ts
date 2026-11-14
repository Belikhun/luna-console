// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { browser } from "$app/environment";
import {
	LANGUAGES,
	isLanguage,
	language,
	setLanguage,
	t as resolve,
	type LanguageCode,
	type LanguageInfo,
} from "$shared/i18n";

/**
 * The console's reactive face for `$shared/i18n`: same dictionaries, same dot
 * paths, plus a rune the templates read so a locale switch re-renders every
 * string without a reload. Components import `t` from here, never from
 * `$shared/i18n` directly, or they would miss the switch.
 */

const STORAGE_KEY = "luna:lang";

// Bumped on every switch. t() touches it, so each rendered string subscribes
// to the locale and repaints when it changes.
let stamp = $state(0);

if (browser) {
	const saved = localStorage.getItem(STORAGE_KEY);

	if (saved !== null && isLanguage(saved)) {
		setLanguage(saved);
		document.documentElement.lang = saved;
	}
}

export { LANGUAGES };
export type { LanguageCode, LanguageInfo };

/** The active locale, tracked: reading it inside a template subscribes to switches. */
export function currentLanguage(): LanguageCode {
	void stamp;

	return language();
}

/** Switch the console's locale, persist the choice, and repaint every string. */
export function switchLanguage(code: LanguageCode): void {
	setLanguage(code);
	stamp += 1;

	if (browser) {
		localStorage.setItem(STORAGE_KEY, code);
		document.documentElement.lang = code;
	}
}

/**
 * Open the console in the signed-in account's preferred language, unless this
 * browser picked one in the status bar, which always wins. Not persisted: the
 * account's setting stays the default, so changing it reaches every browser
 * that never chose for itself.
 */
export function adoptAccountLanguage(code: string | null | undefined): void {
	if (!browser || !code || !isLanguage(code)) {
		return;
	}

	let saved: string | null = null;

	try {
		saved = localStorage.getItem(STORAGE_KEY);
	} catch {
		// storage blocked: nothing was picked here, so the account's choice stands
	}

	if (saved !== null && isLanguage(saved)) {
		return;
	}

	if (language() === code) {
		return;
	}

	setLanguage(code);
	stamp += 1;
	document.documentElement.lang = code;
}

/** Resolve a language string; see `$shared/i18n`. Tracked, unlike the shared `t`. */
export function t(key: string, params?: Record<string, string | number>): string {
	void stamp;

	return resolve(key, params);
}

/** A sentence cut at one placeholder: the text before it and the text after. */
export interface SplitText {
	before: string;
	after: string;
}

// a character no translation holds, put where the placeholder goes and cut at
const SLOT_MARK = "\u0000";

/**
 * Resolve a language string with one placeholder left open, so markup can
 * stand in it: `{split.before}<DateTime at={x} />{split.after}` renders
 * "Stopped 3 min ago" with a clickable date and the sentence's word order
 * still the translation's.
 *
 * @param key the language key
 * @param slot the placeholder the markup takes (`time` for `{time}`)
 * @param params the sentence's other placeholders
 * @returns the text around the slot; all of it is `before` when the
 *   translation does not name the slot
 */
export function tSplit(key: string, slot: string, params: Record<string, string | number> = {}): SplitText {
	const text = t(key, { ...params, [slot]: SLOT_MARK });
	const at = text.indexOf(SLOT_MARK);

	if (at < 0) {
		return { before: text, after: "" };
	}

	return {
		before: text.slice(0, at),
		after: text.slice(at + SLOT_MARK.length),
	};
}
