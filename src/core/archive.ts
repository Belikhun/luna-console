// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Reading things out of jars.
 *
 * Its own module rather than a helper inside one of its callers: a jar is read
 * by the plugin-state scanner, by the luna module builder and by the java-agent
 * check in `instances.ts`, and those already import each other in one direction.
 * Anything generic enough to be wanted from all three belongs below all three.
 */

/** Read one member of a jar (jars are zip files); undefined when absent. */
export async function unzipRead(jar: string, member: string): Promise<string | undefined> {
	const proc = Bun.spawn(["unzip", "-p", jar, member], {
		stdout: "pipe",
		stderr: "ignore",
	});

	const text = await new Response(proc.stdout).text();

	await proc.exited;

	if (proc.exitCode !== 0 || !text.trim()) {
		return undefined;
	}

	return text;
}

/**
 * The namespaces a data pack zip declares, from its `data/<namespace>/` tree.
 *
 * A pack's own file name appears in almost nothing the server logs about its
 * *contents*: a broken recipe or advancement is reported by resource location
 * (`Parsing error loading custom advancement parcool:grant_parcool_guide`,
 * `Couldn't parse data file 'rdm:randomitem/items' from …`), and the namespace
 * in front of the colon is the only link back to the pack that shipped it. So
 * reading the namespaces out of the zip is what lets a content error be
 * attributed to a pack at all.
 *
 * Also returns whether the pack carries a `pack.mcmeta`, since a pack without
 * one is refused outright and the server says so in the same vocabulary.
 */
export async function packContents(zip: string): Promise<{ namespaces: string[]; hasMeta: boolean }> {
	const proc = Bun.spawn(["unzip", "-Z1", zip], { stdout: "pipe", stderr: "ignore" });
	const listing = await new Response(proc.stdout).text();

	await proc.exited;

	const namespaces = new Set<string>();
	let hasMeta = false;

	for (const entry of listing.split(/\r?\n/)) {
		const path = entry.trim();

		if (!path) {
			continue;
		}

		if (path === "pack.mcmeta") {
			hasMeta = true;

			continue;
		}

		// a pack zipped with its own directory at the root is a common mistake, and
		// the server refuses it; only a `data/` at the top counts
		const segments = path.split("/");

		if (segments[0] === "data" && segments[1]) {
			namespaces.add(segments[1].toLowerCase());
		}
	}

	return { namespaces: [...namespaces], hasMeta };
}

/**
 * The jars nested inside a jar, by their base file names.
 *
 * A mod loader that supports jar-in-jar packaging extracts these and loads
 * *them*, under their own inner names: the modpack container
 * `kotlinforforge-4.11.0-all.jar` carries `kffmod-4.11.0.jar`, and it is the
 * inner name that appears in the loader's roster. Without this, the container on
 * disk looks like a file the loader never mentioned.
 *
 * Both layouts are read. Forge's own convention is a directory of real entries
 * under `META-INF/jarjar/`; some builds instead ship only a `metadata.json`
 * there, whose `jars[].path` points at the payload elsewhere in the archive.
 * Empty for a jar with no nested jars, which is nearly all of them.
 */
export async function nestedJarNames(jar: string): Promise<string[]> {
	const proc = Bun.spawn(["unzip", "-Z1", jar, "META-INF/jarjar/*"], {
		stdout: "pipe",
		stderr: "ignore",
	});

	const listing = await new Response(proc.stdout).text();

	await proc.exited;

	const names = new Set<string>();

	for (const entry of listing.split(/\r?\n/)) {
		const name = entry.trim();

		if (name.toLowerCase().endsWith(".jar")) {
			names.add(name.slice(name.lastIndexOf("/") + 1));
		}
	}

	const metadata = await unzipRead(jar, "META-INF/jarjar/metadata.json");

	if (metadata) {
		try {
			const parsed = JSON.parse(metadata) as { jars?: { path?: string }[] };

			for (const nested of parsed.jars ?? []) {
				if (nested.path?.toLowerCase().endsWith(".jar")) {
					names.add(nested.path.slice(nested.path.lastIndexOf("/") + 1));
				}
			}
		} catch {
			// a container whose metadata does not parse still loads; it just cannot
			// be matched to the roster through this route
		}
	}

	return [...names];
}

/**
 * Whether a jar can be loaded with `-javaagent:`.
 *
 * The JVM's rule is exactly this manifest attribute, and it checks it before
 * anything else runs: a jar without one aborts the VM with `Failed to find
 * Premain-Class manifest attribute` and no server log at all. Reading it
 * ourselves is what turns that into a sentence naming the addon.
 *
 * An unreadable jar answers `true`. This gates starting a server, and refusing
 * to start over a manifest we could not parse would be worse than letting the
 * JVM have the final say - which it does regardless.
 */
export async function isJavaAgentJar(jar: string): Promise<boolean> {
	const manifest = await unzipRead(jar, "META-INF/MANIFEST.MF");

	if (manifest === undefined) {
		return true;
	}

	// continuation lines: the manifest format wraps at 72 bytes and resumes with a
	// single leading space, so a long class name arrives split
	return /^Premain-Class:/m.test(manifest.replace(/\r?\n /g, ""));
}
