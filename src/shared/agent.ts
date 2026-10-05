// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Mèo Béo's permission modes, shared by the console's runner and its panel.
 *
 * A mode only decides **when the operator is asked**; what the agent can reach
 * at all is its MCP token's scope, in every mode, bypass included.
 *
 * - `manual`: every tool call waits for the operator, even a read.
 * - `auto`: reads and the agent's own memory run; anything that changes the
 *   cluster waits. The default.
 * - `plan`: reads run, changes are refused outright, and the agent answers with
 *   a plan instead of acting.
 * - `bypass`: every tool in scope runs without asking. It can be switched off
 *   for the whole console in the agent settings.
 */

export const AGENT_MODES = ["manual", "auto", "plan", "bypass"] as const;

export type AgentMode = typeof AGENT_MODES[number];

export const DEFAULT_AGENT_MODE: AgentMode = "auto";

/** Whether a value names a mode. */
export function isAgentMode(value: unknown): value is AgentMode {
	return typeof value === "string" && (AGENT_MODES as readonly string[]).includes(value);
}
