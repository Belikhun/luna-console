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
