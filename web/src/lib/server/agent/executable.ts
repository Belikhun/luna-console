// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Where the Claude Code executable the Agent SDK drives comes from.
 *
 * The SDK normally finds the native binary in its own per-platform npm package,
 * but that binary is a quarter of a gigabyte and the published console bundle
 * ships no `node_modules`, so a deployed console uses one already on the host.
 * The search is ordered by how deliberately each was chosen: the path in the
 * agent's settings, `LUNA_CLAUDE_BIN`, a copy in the cluster root's `.bin/`,
 * `claude` on PATH, the native installer's `~/.local/bin`, and last the SDK's
 * own package, which only exists in a source checkout. The path is always
 * explicit, so the SDK never goes looking on its own.
 */

import { existsSync, accessSync, constants } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { root } from '$lib/server/luna';

export interface ExecutableChoice {
	/** Absolute path to hand the SDK; undefined only when nothing was found */
	path: string | undefined;
	/** Where the choice came from, for the settings screen */
	source: 'settings' | 'env' | 'cluster' | 'path' | 'home' | 'sdk' | 'none';
}

function runnable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);

		return true;
	} catch {
		return false;
	}
}

function onPath(name: string): string | undefined {
	for (const dir of (process.env.PATH ?? '').split(delimiter)) {
		if (!dir) {
			continue;
		}

		const candidate = join(dir, name);

		if (runnable(candidate)) {
			return candidate;
		}
	}

	return undefined;
}

/** The SDK's own per-platform binary, when its package is installed (a source checkout). */
function sdkBundled(): string | undefined {
	const arch = process.arch === 'arm64'
		? 'arm64'
		: 'x64';

	try {
		const manifest = Bun.resolveSync(`@anthropic-ai/claude-agent-sdk-linux-${arch}/package.json`, process.cwd());
		const binary = join(dirname(manifest), 'claude');

		return runnable(binary)
			? binary
			: undefined;
	} catch {
		return undefined;
	}
}

/** Pick the Claude Code executable for a run. */
export function findClaudeExecutable(configured: string): ExecutableChoice {
	if (configured) {
		return { path: configured, source: 'settings' };
	}

	const fromEnv = process.env.LUNA_CLAUDE_BIN;

	if (fromEnv && runnable(fromEnv)) {
		return { path: fromEnv, source: 'env' };
	}

	const inCluster = join(root(), '.bin', 'claude');

	if (runnable(inCluster)) {
		return { path: inCluster, source: 'cluster' };
	}

	const found = onPath('claude');

	if (found) {
		return { path: found, source: 'path' };
	}

	const native = join(homedir(), '.local', 'bin', 'claude');

	if (existsSync(native) && runnable(native)) {
		return { path: native, source: 'home' };
	}

	const bundled = sdkBundled();

	if (bundled) {
		return { path: bundled, source: 'sdk' };
	}

	return { path: undefined, source: 'none' };
}
