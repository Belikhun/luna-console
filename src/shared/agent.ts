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
 * - `auto`: every call runs on its own except the ones the catalog marks
 *   destructive (stop, restart, console commands, removals, shells), which
 *   wait. The default.
 * - `plan`: reads run, changes are refused outright, and the agent answers with
 *   a plan instead of acting.
 * - `bypass`: every tool in scope runs without asking. It can be switched off
 *   for the whole console in the agent settings.
 */

export const AGENT_MODES = ["manual", "auto", "plan", "bypass"] as const;

export type AgentMode = typeof AGENT_MODES[number];

export const DEFAULT_AGENT_MODE: AgentMode = "auto";

/**
 * The SDK's built-in question tool, the one tool the agent has besides luna's:
 * it asks the operator to pick from a few options (or type their own) and
 * waits for the answer. It reaches nothing on the cluster. Auto has no one
 * watching by design, so there it is withheld and the agent decides itself.
 */
export const AGENT_ASK_TOOL = "AskUserQuestion";

/** Whether the agent may stop and ask the operator a question in a mode. */
export function agentCanAsk(mode: AgentMode): boolean {
	return mode !== "auto";
}

/** Whether a value names a mode. */
export function isAgentMode(value: unknown): value is AgentMode {
	return typeof value === "string" && (AGENT_MODES as readonly string[]).includes(value);
}
