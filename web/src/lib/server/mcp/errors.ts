// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The shapes every tool adapter shares, apart from the adapters themselves so
 * that the handler modules (`handlers.ts`, `addons.ts`) can import them without
 * importing each other.
 */

import type { McpOnBehalfOf, McpPrincipal } from '$core/mcp';

/** What an adapter is handed besides its arguments. */
export interface ToolContext {
	principal: McpPrincipal;
	/** `mcp:<token name>`, the actor every change made over MCP is recorded as */
	actor: string;
	/** Who the client says it acts for; a claim, used only to narrow what a call may do */
	onBehalfOf?: McpOnBehalfOf;
	/**
	 * The console account the call runs for, when the console established it (a
	 * Mèo Béo run); its IAM policies bound the call and its listings
	 */
	account?: string;
	/** The Mèo Béo conversation whose run made the call; set only for a run's own bearer */
	conversation?: string;
}

export type ToolArgs = Record<string, unknown>;

export type ToolHandler = (args: ToolArgs, ctx: ToolContext) => Promise<unknown>;

/** A failure the model should read as-is, rather than as an internal error. */
export class ToolError extends Error {}

/** One block of a tool result as MCP carries it. */
export type ToolContentBlock =
	| { type: 'text'; text: string }
	| { type: 'image'; data: string; mimeType: string };

/**
 * A result that is more than text (a screenshot), returned by an adapter in
 * place of a plain value. The endpoint sends its blocks as they are; text
 * blocks are still cut at the result limit.
 */
export class ToolContent {
	constructor(readonly blocks: ToolContentBlock[]) {}
}
