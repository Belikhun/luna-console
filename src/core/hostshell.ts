// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Run a bash command on a cluster machine, for the MCP `shell_bash` tool.
 *
 * This is arbitrary code execution as the daemon's service user, so it is off
 * unless the machine itself opts in: `mcpHostShell` in that daemon's config is
 * handed over at boot (`setHostShellEnabled`), the same way the journal learns
 * its machine name, and a machine that never set it refuses every command. The
 * op is routed by instance, so each machine answers from its own setting.
 *
 * A command runs in the instance's directory (or the cluster root), through
 * `bash -c`, with a **scrubbed environment**: the daemon's own environment can
 * carry the cluster token and provider keys, and a command's output goes
 * straight back to a chat model. It is killed at its timeout, its output is
 * capped, and every run is written to the journal before it starts, so a
 * command that hangs or kills the daemon is still on record.
 */

import { resolve } from "node:path";

import type { ClusterConfig } from "./types";
import { t } from "../shared/i18n";
import { instanceDir, managedInstances, root } from "./config";
import { appendJournal } from "./journal";

/** Default and ceiling for one command's run time. */
export const HOST_SHELL_DEFAULT_TIMEOUT_MS = 60_000;
export const HOST_SHELL_MAX_TIMEOUT_MS = 10 * 60_000;

/** Most bytes of stdout (and, separately, stderr) kept from one run. */
export const HOST_SHELL_MAX_OUTPUT = 64 * 1024;

/** Longest command accepted. */
export const HOST_SHELL_MAX_COMMAND = 8 * 1024;

let enabled = false;

/** Set by the daemon runtime from its config. Never called from core. */
export function setHostShellEnabled(value: boolean): void {
	enabled = value;
}

/** Whether this machine accepts host commands. */
export function hostShellEnabled(): boolean {
	return enabled;
}

export interface HostCommandOptions {
	timeoutMs?: number;
	/** Who asked, for the journal: `mcp:<token>` or an account */
	actor?: string;
}

export interface HostCommandResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	truncated: boolean;
	durationMs: number;
	cwd: string;
}

/** The only variables a command sees; nothing from the daemon's own environment leaks through. */
function scrubbedEnv(cwd: string): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		HOME: process.env.HOME ?? cwd,
		LANG: process.env.LANG ?? "C.UTF-8",
		TERM: "dumb",
		NO_COLOR: "1",
	};
}

async function collect(
	stream: ReadableStream<Uint8Array>,
	cap: number,
	signal: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
	const reader = stream.getReader();

	signal.addEventListener("abort", () => {
		void reader.cancel().catch(() => undefined);
	});
	const chunks: Uint8Array[] = [];
	let size = 0;
	let truncated = false;

	while (true) {
		const { done, value } = await reader.read();

		if (done) {
			break;
		}

		// keep draining past the cap, or a chatty command blocks on a full pipe
		if (size >= cap) {
			truncated = true;
			continue;
		}

		const room = cap - size;
		const piece = value.byteLength > room
			? value.subarray(0, room)
			: value;

		truncated ||= piece.byteLength < value.byteLength;
		chunks.push(piece);
		size += piece.byteLength;
	}

	return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated };
}

/**
 * Run one command on this machine. `instance` picks the working directory (and,
 * through the op's routing, the machine); without one it runs in the cluster
 * root on the primary.
 */
export async function runHostCommand(
	cfg: ClusterConfig,
	instance: string | null,
	command: string,
	opts: HostCommandOptions = {},
): Promise<HostCommandResult> {
	if (!enabled) {
		throw new Error(t("core.hostshell.disabled"));
	}

	if (!command.trim()) {
		throw new Error(t("core.hostshell.empty"));
	}

	if (command.length > HOST_SHELL_MAX_COMMAND) {
		throw new Error(t("core.hostshell.tooLong", { max: HOST_SHELL_MAX_COMMAND }));
	}

	let cwd = root();

	if (instance) {
		const inst = managedInstances(cfg)[instance];

		if (!inst) {
			throw new Error(t("core.instances.unknown", { name: instance }));
		}

		cwd = resolve(instanceDir(inst));
	}

	const timeoutMs = Math.min(Math.max(1000, opts.timeoutMs ?? HOST_SHELL_DEFAULT_TIMEOUT_MS), HOST_SHELL_MAX_TIMEOUT_MS);

	await appendJournal({
		source: "mcp",
		level: "warn",
		message: `host command in ${instance ?? "the cluster root"}: ${command.slice(0, 500)}`,
		actor: opts.actor,
	});

	const started = performance.now();

	// `setsid` makes bash the leader of its own process group, so a timeout can
	// kill the whole group; killing bash alone would leave `cmd &` or a pipeline
	// holding the output pipes open and the read below waiting forever
	const proc = Bun.spawn(["setsid", "bash", "-c", command], {
		cwd,
		env: scrubbedEnv(cwd),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	let timedOut = false;
	const abort = new AbortController();

	const timer = setTimeout(() => {
		timedOut = true;

		try {
			process.kill(-proc.pid, "SIGKILL");
		} catch {
			proc.kill("SIGKILL");
		}

		abort.abort();
	}, timeoutMs);

	try {
		const [stdout, stderr] = await Promise.all([
			collect(proc.stdout, HOST_SHELL_MAX_OUTPUT, abort.signal),
			collect(proc.stderr, HOST_SHELL_MAX_OUTPUT, abort.signal),
		]);
		const exitCode = await proc.exited;

		return {
			exitCode: timedOut ? null : exitCode,
			stdout: stdout.text,
			stderr: stderr.text,
			timedOut,
			truncated: stdout.truncated || stderr.truncated,
			durationMs: Math.round(performance.now() - started),
			cwd,
		};
	} finally {
		clearTimeout(timer);
	}
}
