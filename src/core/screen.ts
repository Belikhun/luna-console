// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/** GNU screen helpers. */

import { randomBytes } from "node:crypto";
import { readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One row of `screen -ls`: a socket's session name and whether it still answers. */
interface Socket {
	name: string;
	dead: boolean;
}

// `screen -ls` prints one tab-separated row per socket: the pid and the name,
// the socket's timestamp, then its state. A socket whose screen process is gone
// is listed exactly like a live one, and only that trailing state tells them
// apart, which is why it is parsed rather than skipped. `Dead ???` is what a
// killed screen leaves behind (a container restart keeps /run/screen while the
// processes go with it); `Removed` is a socket that vanished mid-listing.
const SESSION_LINE = /^\s+(\d+)\.(\S+)\s+.*\(([^()]*)\)\s*$/;

/** Every screen socket on the host, live and stale alike. */
async function listSockets(): Promise<Socket[]> {
	const proc = Bun.spawn(["screen", "-ls"], { stdout: "pipe", stderr: "pipe" });
	const out = await new Response(proc.stdout).text();

	await proc.exited;

	const sockets: Socket[] = [];

	for (const line of out.split("\n")) {
		const match = line.match(SESSION_LINE);

		if (!match) {
			continue;
		}

		const state = match[3]!;

		sockets.push({
			name: match[2]!,
			dead: state.startsWith("Dead") || state === "Removed",
		});
	}

	return sockets;
}

/**
 * Names of every live screen session on the host.
 *
 * Stale sockets are left out deliberately: every caller reads this as "the
 * instance is up", and a start refusing with "already running" against a socket
 * nothing is listening on is the bug that costs an operator the most time,
 * because `getStatus` wants a server process too and reports the truth.
 */
export async function listSessions(): Promise<string[]> {
	const sockets = await listSockets();

	return sockets.filter((socket) => !socket.dead).map((socket) => socket.name);
}

/** Whether a screen session with this exact name is live. */
export async function sessionExists(name: string): Promise<boolean> {
	return (await listSessions()).includes(name);
}

/** Names of the stale sockets a killed screen left behind. */
export async function listDeadSessions(): Promise<string[]> {
	const sockets = await listSockets();

	return sockets.filter((socket) => socket.dead).map((socket) => socket.name);
}

/** Remove every stale socket on the host. Live sessions are untouched. */
export async function wipe(): Promise<void> {
	const proc = Bun.spawn(["screen", "-wipe"], { stdout: "ignore", stderr: "ignore" });

	await proc.exited;
}

/**
 * Longest text, in bytes, that goes through `stuff`. GNU screen discards a
 * `-X stuff` argument past 768 bytes without a word (measured: 750 landed, 770
 * vanished), so anything longer takes the paste buffer instead.
 */
const STUFF_MAX_BYTES = 700;

/**
 * Type a long line through screen's paste buffer: `readbuf` loads a file into
 * the buffer and `paste` types it into the window, neither with a length cap
 * worth hitting. The file is private to this user and gone once pasted.
 */
async function paste(session: string, line: string): Promise<void> {
	const file = join(tmpdir(), `luna-paste-${randomBytes(8).toString("hex")}`);

	await writeFile(file, line, { mode: 0o600 });

	try {
		const load = Bun.spawn(["screen", "-S", session, "-p", "0", "-X", "readbuf", "-e", "utf8", file]);

		await load.exited;

		const type = Bun.spawn(["screen", "-S", session, "-p", "0", "-X", "paste", "."]);

		await type.exited;
	} finally {
		await rm(file, { force: true });
	}
}

/** Send text to a session's console followed by Enter, at any length. */
export async function stuff(session: string, text: string): Promise<void> {
	const line = text + "\r";

	if (Buffer.byteLength(line, "utf8") > STUFF_MAX_BYTES) {
		await paste(session, line);

		return;
	}

	const proc = Bun.spawn(["screen", "-S", session, "-p", "0", "-X", "stuff", line]);

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
