// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/** GNU screen helpers. */

import { readlink, stat } from "node:fs/promises";

/** Names of every live screen session on the host. */
export async function listSessions(): Promise<string[]> {
	const proc = Bun.spawn(["screen", "-ls"], { stdout: "pipe", stderr: "pipe" });
	const out = await new Response(proc.stdout).text();

	await proc.exited;

	const names: string[] = [];

	for (const line of out.split("\n")) {
		const match = line.match(/^\s+(\d+)\.(\S+)\s+\(/);

		if (match) {
			names.push(match[2]!);
		}
	}

	return names;
}

/** Whether a screen session with this exact name is live. */
export async function sessionExists(name: string): Promise<boolean> {
	return (await listSessions()).includes(name);
}

/** Send text to a session's console followed by Enter. */
export async function stuff(session: string, text: string): Promise<void> {
	const proc = Bun.spawn(["screen", "-S", session, "-p", "0", "-X", "stuff", text + "\r"]);

	await proc.exited;
}

/** Kill a session outright. Silent when the session is already gone. */
export async function quit(session: string): Promise<void> {
	const proc = Bun.spawn(["screen", "-S", session, "-X", "quit"], { stderr: "ignore" });

	await proc.exited;
}

/** Start `script` under bash in a new detached session rooted at `cwd`. */
export async function startDetached(session: string, script: string, cwd: string): Promise<void> {
	const proc = Bun.spawn(["screen", "-dmS", session, "bash", script], { cwd });

	await proc.exited;
}

/** Attach interactively (replaces stdio until user detaches with C-a d). */
export async function attach(session: string): Promise<number> {
	const proc = Bun.spawn(["screen", "-r", session], {
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});

	return await proc.exited;
}

/**
 * Find the pid of a `process` whose cwd is `dir`.
 *
 * The process name is the software's own binary rather than a constant: a
 * native server has no JVM anywhere, so matching `java` would report every
 * pumpkin instance as stopped while its screen session and its server were
 * both perfectly alive.
 */
export async function serverPidFor(dir: string, process: string): Promise<number | undefined> {
	const proc = Bun.spawn(["pgrep", process], { stdout: "pipe", stderr: "ignore" });
	const out = await new Response(proc.stdout).text();

	await proc.exited;

	for (const line of out.split("\n")) {
		const pid = parseInt(line.trim());

		if (!pid) {
			continue;
		}

		try {
			if ((await readlink(`/proc/${pid}/cwd`)) === dir) {
				return pid;
			}
		} catch {
			// the process exited between pgrep and the readlink; skip it
		}
	}

	return undefined;
}

/**
 * Process start time, taken from the mtime of its `/proc` entry.
 * Returns undefined once the process is gone.
 */
export async function processStartTime(pid: number): Promise<Date | undefined> {
	try {
		const entry = await stat(`/proc/${pid}`);

		return entry.mtime;
	} catch {
		return undefined;
	}
}
