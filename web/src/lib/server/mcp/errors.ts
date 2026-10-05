// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The shapes every tool adapter shares, apart from the adapters themselves so
 * that the handler modules (`handlers.ts`, `addons.ts`) can import them without
 * importing each other.
 */

import type { McpPrincipal } from '$core/mcp';

/** What an adapter is handed besides its arguments. */
export interface ToolContext {
	principal: McpPrincipal;
	/** `mcp:<token name>`, the actor every change made over MCP is recorded as */
	actor: string;
}

export type ToolArgs = Record<string, unknown>;

export type ToolHandler = (args: ToolArgs, ctx: ToolContext) => Promise<unknown>;

/** A failure the model should read as-is, rather than as an internal error. */
export class ToolError extends Error {}
