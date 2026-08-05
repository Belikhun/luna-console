// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import enCli from "../lang/en/cli.json";
import enCore from "../lang/en/core.json";
import enDaemon from "../lang/en/daemon.json";
import enWeb from "../lang/en/web.json";
import viCli from "../lang/vi/cli.json";
import viCore from "../lang/vi/core.json";
import viDaemon from "../lang/vi/daemon.json";
import viWeb from "../lang/vi/web.json";

/**
 * JSON-backed language strings for every user-facing surface: the CLI, the
 * daemon, core result messages and the web console. Each locale is a set of
 * JSON files under `src/lang/<code>/`, one per domain, merged here into a
 * single dictionary and addressed by dot path: `t("cli.ports.check.noIssues")`.
 *
 * The lookup falls back to English for a key a locale has not translated yet,
 * and to the key itself when the key is unknown, so a missing entry shows up
 * on screen as the key instead of crashing the caller.
 */

export type LanguageCode = "en" | "vi";

export interface LanguageInfo {
	code: LanguageCode;
	/** The language's own name for itself, which is how pickers label it. */
	label: string;
}

export const LANGUAGES: LanguageInfo[] = [
	{ code: "en", label: "English" },
	{ code: "vi", label: "Tiếng Việt" },
];

type LangTree = { [key: string]: string | LangTree };

const Dictionaries: Record<LanguageCode, LangTree> = {
	en: {
		cli: enCli as LangTree,
		core: enCore as LangTree,
		daemon: enDaemon as LangTree,
		web: enWeb as LangTree,
	},
	vi: {
		cli: viCli as LangTree,
		core: viCore as LangTree,
		daemon: viDaemon as LangTree,
		web: viWeb as LangTree,
	},
};

let current: LanguageCode = "en";

/** True when `code` names a locale this build ships. */
export function isLanguage(code: string): code is LanguageCode {
	return LANGUAGES.some((lang) => lang.code === code);
}

/** The active locale code. */
export function language(): LanguageCode {
	return current;
}

/** Switch the active locale. Strings resolved after this call use the new one. */
export function setLanguage(code: LanguageCode): void {
	current = code;
}

/** Walk a dot path into a locale tree; undefined when the path dead-ends. */
function lookup(tree: LangTree, key: string): string | undefined {
	let node: string | LangTree | undefined = tree;

	for (const part of key.split(".")) {
		if (typeof node !== "object" || node === undefined) {
			return undefined;
		}

		node = node[part];
	}

	return typeof node === "string" ? node : undefined;
}

/**
 * Resolve a language string by dot path and fill its `{name}` placeholders.
 * Falls back to English, then to the key itself, so callers never branch on a
 * missing translation. A placeholder without a matching param is kept as-is,
 * which makes the omission visible instead of silently dropping text.
 */
export function t(key: string, params?: Record<string, string | number>): string {
	const text = lookup(Dictionaries[current], key) ?? lookup(Dictionaries.en, key) ?? key;

	if (!params) {
		return text;
	}

	return text.replace(/\{(\w+)\}/g, (match, name: string) => {
		const value = params[name];

		return value === undefined ? match : String(value);
	});
}

// A process picks its locale from the environment once, at import time: the
// CLI, the daemon and the console's server side all honour LUNA_LANG without
// each entry point wiring it up. The browser has no process env; the web
// layer sets the locale from the user's saved preference instead.
if (typeof process !== "undefined" && process.env?.LUNA_LANG !== undefined) {
	const wanted = process.env.LUNA_LANG;

	if (isLanguage(wanted)) {
		current = wanted;
	}
}
