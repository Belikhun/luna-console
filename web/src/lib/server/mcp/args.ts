// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Argument readers and scope checks the newer handler modules share
 * (`network.ts`, `packs.ts`). The endpoint has already validated the arguments
 * against each tool's schema, so these only narrow the types.
 */

import { ToolError } from './errors';
import type { ToolArgs, ToolContext } from './errors';

/** A required string argument. */
export function str(args: ToolArgs, key: string): string {
	return String(args[key] ?? '');
}

/** An optional string argument; undefined when absent. */
export function optStr(args: ToolArgs, key: string): string | undefined {
	const value = args[key];

	return typeof value === 'string'
		? value
		: undefined;
}

/** An optional boolean argument; undefined when absent. */
export function optBool(args: ToolArgs, key: string): boolean | undefined {
	const value = args[key];

	return typeof value === 'boolean'
		? value
		: undefined;
}

/** An optional integer argument; undefined when absent. */
export function optInt(args: ToolArgs, key: string): number | undefined {
	const value = args[key];

	return typeof value === 'number' && Number.isInteger(value)
		? value
		: undefined;
}

/** An optional list of strings; undefined when absent, so "not given" and "empty" stay apart. */
export function optList(args: ToolArgs, key: string): string[] | undefined {
	const value = args[key];

	return Array.isArray(value)
		? value.map(String)
		: undefined;
}

/**
 * Refuse a token limited to some instances. The menu, velocity's routing, the
 * port pools and the pack pools are each one thing shared by every server, so
 * changing them reaches instances such a token was never given.
 */
export function requireWholeCluster(ctx: ToolContext, what: string): void {
	if (ctx.principal.scope.instances !== null) {
		throw new ToolError(`this token is limited to some instances, and ${what} is shared by all of them, so it cannot change it`);
	}
}
