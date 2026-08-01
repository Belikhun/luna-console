/**
 * Minimal line-preserving editors for the config formats plugins use.
 * These only get/set a single scalar key, keeping the rest of the file intact.
 */

import { existsSync } from "node:fs";

export type ConfFormat = "properties" | "hocon" | "yaml" | "toml";

/**
 * Build the match for a single scalar assignment. Capture 1 is everything up to
 * and including the separator, so a replace can keep the original spelling and
 * indentation of the line; capture 2 is the bare value.
 */
function keyRegex(format: ConfFormat, key: string): RegExp {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

	switch (format) {
		case "properties":
			return new RegExp(`^(\\s*${escaped}\\s*=\\s*)(.*)$`, "m");

		case "hocon":
			// hocon accepts both `key: value` and `key = value`
			return new RegExp(`^(\\s*${escaped}\\s*[:=]\\s*)([^\\n#]*)`, "m");

		case "yaml":
			return new RegExp(`^(\\s*${escaped}\\s*:\\s*)([^\\n#]*)`, "m");

		case "toml":
			return new RegExp(`^(\\s*${escaped}\\s*=\\s*)([^\\n#]*)`, "m");
	}
}

/**
 * Read a single scalar key, unquoted and trimmed.
 * Returns undefined when the file or the key is absent.
 */
export async function getConfValue(
	path: string,
	format: ConfFormat,
	key: string,
): Promise<string | undefined> {
	if (!existsSync(path)) {
		return undefined;
	}

	const text = await Bun.file(path).text();
	const match = text.match(keyRegex(format, key));

	if (!match) {
		return undefined;
	}

	return match[2]!.trim().replace(/^["']|["']$/g, "");
}

/** Returns true if the file existed and was updated (or already had the value). */
export async function setConfValue(
	path: string,
	format: ConfFormat,
	key: string,
	value: string | number,
): Promise<boolean> {
	if (!existsSync(path)) {
		return false;
	}

	const text = await Bun.file(path).text();
	const pattern = keyRegex(format, key);

	if (!pattern.test(text)) {
		return false;
	}

	const updated = text.replace(pattern, (_match: string, prefix: string) => `${prefix}${value}`);

	if (updated !== text) {
		await Bun.write(path, updated);
	}

	return true;
}
