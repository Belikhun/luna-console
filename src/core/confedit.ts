/**
 * Minimal line-preserving editors for the config formats plugins use.
 * These only get/set a single scalar key, keeping the rest of the file intact.
 */

import { existsSync } from "node:fs";

export type ConfFormat = "properties" | "hocon" | "yaml" | "toml";

/**
 * Horizontal whitespace only. Plain `\s` matches newlines, so padding written
 * as `\s*` around a separator happily runs off the end of an empty assignment
 * (`server-ip=`) and swallows the line below it; which a get would then report
 * as the value and a set would overwrite, merging two lines into one.
 */
const HSPACE = "[^\\S\\r\\n]*";

/**
 * Build the match for a single scalar assignment. Capture 1 is everything up to
 * and including the separator, so a replace can keep the original spelling and
 * indentation of the line; capture 2 is the bare value, empty when the key is
 * assigned nothing.
 */
function keyRegex(format: ConfFormat, key: string): RegExp {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

	switch (format) {
		case "properties":
			return new RegExp(`^(${HSPACE}${escaped}${HSPACE}=${HSPACE})(.*)$`, "m");

		case "hocon":
			// hocon accepts both `key: value` and `key = value`
			return new RegExp(`^(${HSPACE}${escaped}${HSPACE}[:=]${HSPACE})([^\\n#]*)`, "m");

		case "yaml":
			return new RegExp(`^(${HSPACE}${escaped}${HSPACE}:${HSPACE})([^\\n#]*)`, "m");

		case "toml":
			return new RegExp(`^(${HSPACE}${escaped}${HSPACE}=${HSPACE})([^\\n#]*)`, "m");
	}
}

/**
 * Undo Java's properties escaping. Its writer escapes the separator characters
 * wherever they appear, so Paper writes `level-type=minecraft\:flat`; read back
 * verbatim that value matches no known level type. Everything after the first
 * separator is literal to a properties reader, so unescaping is all that is
 * needed to get the value the server actually uses.
 */
function unescapeProperty(value: string): string {
	return value.replace(/\\([:=\\ #!])/g, "$1");
}

/** Escape a value for one properties line. See `unescapeProperty` for the round trip. */
function escapeProperty(value: string | number): string {
	return String(value).replace(/\\/g, "\\\\");
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

	const value = match[2]!.trim().replace(/^["']|["']$/g, "");

	return format === "properties" ? unescapeProperty(value) : value;
}

/**
 * Every `key=value` line of a properties file, as a flat map. Comments, blank
 * lines and anything without a `=` are skipped.
 */
export async function readProperties(path: string): Promise<Record<string, string>> {
	const props: Record<string, string> = {};

	if (!existsSync(path)) {
		return props;
	}

	const text = await Bun.file(path).text();

	for (const line of text.split("\n")) {
		const pair = line.match(/^([A-Za-z0-9._-]+)\s*=(.*)$/);

		if (pair) {
			props[pair[1]!] = unescapeProperty(pair[2]!.trim());
		}
	}

	return props;
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

/**
 * Set a properties key, appending the line when the file has no such key yet.
 *
 * Paper only writes out the keys it knows about, and a freshly created instance
 * carries the minimal template until its first boot; so setting e.g.
 * `difficulty` before that has to add the line rather than fail. Appending is
 * safe for properties files only; the other formats are sectioned, where a new
 * line at the end would land in the wrong block.
 */
export async function upsertProperty(
	path: string,
	key: string,
	value: string | number,
): Promise<"updated" | "appended"> {
	const escaped = escapeProperty(value);

	if (await setConfValue(path, "properties", key, escaped)) {
		return "updated";
	}

	const existing = existsSync(path) ? await Bun.file(path).text() : "";
	const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";

	await Bun.write(path, `${existing}${separator}${key}=${escaped}\n`);

	return "appended";
}
