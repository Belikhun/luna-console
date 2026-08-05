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

/** Resolve a language string; see `$shared/i18n`. Tracked, unlike the shared `t`. */
export function t(key: string, params?: Record<string, string | number>): string {
	void stamp;

	return resolve(key, params);
}
