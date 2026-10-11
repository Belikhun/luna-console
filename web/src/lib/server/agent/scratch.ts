// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Mèo Béo's scratch folder: one directory per conversation (`agentScratch` in
 * core) where Claude Code's own Read, Write, Edit, Glob and Grep work, for
 * drafts, notes, a config being prepared, or a large tool result kept to page
 * through. The tools themselves would reach the whole disk, so every call
 * passes the `PreToolUse` hook built here first, which sees each call whether
 * or not the CLI would have asked for permission, and refuses any path that
 * resolves outside the folder. Symlinks are resolved before the check, so a
 * link inside cannot point the tools elsewhere.
 *
 * The one other place a read may go is the session's own `tool-results`
 * folder, where the CLI saves an oversized tool result and tells the model to
 * Read it back; that is the agent's own output, and only this session's.
 */

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { HookCallback, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

import { AGENT_SCRATCH_TOOLS } from '$shared/agent';

/** The argument of each tool that names a path, and whether the tool falls back to the working directory without one. */
const PATH_ARGS: Record<string, { key: string; optional: boolean }> = {
	Read: { key: 'file_path', optional: false },
	Write: { key: 'file_path', optional: false },
	Edit: { key: 'file_path', optional: false },
	Glob: { key: 'path', optional: true },
	Grep: { key: 'path', optional: true }
};

/** The matcher the hook registers under; the SDK reads it as a regular expression. */
export const SCRATCH_TOOL_MATCHER = `^(${AGENT_SCRATCH_TOOLS.join('|')})$`;

export interface ScratchGateOptions {
	/** The conversation's scratch folder */
	scratch: string;
	/** The subprocess's own HOME, which holds the session folders */
	home: string;
	/** The session the run is in, once the SDK has said */
	sessionId: () => string | null;
	/** Whether the current mode runs the tool without asking; a rewritten call keeps that answer */
	unasked: (tool: string) => boolean;
}

/**
 * A path as the filesystem will treat it: symlinks resolved for the part that
 * exists, the rest appended, so a file about to be written is judged by the
 * real folder it lands in.
 */
function realPath(path: string): string {
	let existing = resolve(path);
	const rest: string[] = [];

	while (!existsSync(existing)) {
		const parent = dirname(existing);

		if (parent === existing) {
			break;
		}

		rest.unshift(basename(existing));
		existing = parent;
	}

	const real = existsSync(existing)
		? realpathSync(existing)
		: existing;

	return rest.length
		? join(real, ...rest)
		: real;
}

/** The leading folders of a glob, up to its first segment with a wildcard in it. */
function fixedPart(pattern: string): string {
	const segments = pattern.split('/');
	const wild = segments.findIndex((segment) => /[*?[\]{}]/.test(segment));
	const fixed = wild < 0
		? segments
		: segments.slice(0, wild);

	return fixed.join('/') || '/';
}

function inside(path: string, dir: string): boolean {
	return path === dir || path.startsWith(dir + sep);
}

/** Whether a path is a file the CLI saved from one of this session's oversized tool results. */
function sessionToolResult(path: string, home: string, sessionId: string | null): boolean {
	if (!sessionId || !inside(path, home)) {
		return false;
	}

	const parts = relative(home, path).split(sep);

	return parts[0] === 'projects' && parts[2] === sessionId && parts[3] === 'tool-results' && parts.length > 4;
}

function deny(reason: string): HookJSONOutput {
	return {
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: 'deny',
			permissionDecisionReason: reason
		}
	};
}

/** Build the hook that keeps the file tools inside one conversation's scratch folder. */
export function scratchGate(options: ScratchGateOptions): HookCallback {
	const scratch = realPath(options.scratch);
	const home = realPath(options.home);
	const outside = `Your file tools work only inside your scratch folder, ${options.scratch}. Use an absolute path inside it; for an instance's files use the luna file tools (file_read, file_edit, file_write).`;

	return async (input) => {
		if (input.hook_event_name !== 'PreToolUse') {
			return {};
		}

		const spec = PATH_ARGS[input.tool_name];

		if (!spec) {
			return {};
		}

		const args = (input.tool_input ?? {}) as Record<string, unknown>;

		// a glob climbing out with ../ would escape whatever folder it is given, and an
		// absolute one ignores that folder, so it is judged by where its fixed part points
		for (const key of input.tool_name === 'Glob' ? ['pattern'] : ['glob']) {
			const pattern = args[key];

			if (typeof pattern !== 'string') {
				continue;
			}

			if (pattern.split(/[\\/]/).includes('..')) {
				return deny(`${key} may not contain "..": ${outside}`);
			}

			if (isAbsolute(pattern) && !inside(realPath(fixedPart(pattern)), scratch)) {
				return deny(outside);
			}
		}

		const given = args[spec.key];

		if (given === undefined || given === '') {
			if (!spec.optional) {
				return deny(outside);
			}

			// left to itself it would search the session's HOME; point it at the folder
			return {
				hookSpecificOutput: {
					hookEventName: 'PreToolUse',
					permissionDecision: options.unasked(input.tool_name)
						? 'allow'
						: 'ask',
					updatedInput: { ...args, [spec.key]: options.scratch }
				}
			};
		}

		if (typeof given !== 'string' || !isAbsolute(given)) {
			return deny(outside);
		}

		const target = realPath(given);

		if (inside(target, scratch)) {
			return {};
		}

		if (input.tool_name === 'Read' && sessionToolResult(target, home, options.sessionId())) {
			return {};
		}

		return deny(outside);
	};
}

/** Where an attachment lands in the scratch folder: its own name, made safe, under `attachments/`. */
export function attachmentPath(scratch: string, id: string, name: string): string {
	const safe = basename(name).replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'file';

	return join(scratch, 'attachments', `${id.slice(-8)}-${safe}`);
}
