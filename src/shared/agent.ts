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

/**
 * The agent's look at the operator's screen: the panel that owns the run renders
 * the console as it stands in that browser and posts the image back. Like the
 * question, it lives in the console's runner rather than among luna's MCP tools,
 * because only the browser can see it. It reads and changes nothing, so it runs
 * unasked everywhere but Manual.
 */
export const AGENT_SCREENSHOT_TOOL = "console_screenshot";

/**
 * The agent's hand on the operator's screen: it opens a console page in the
 * browser following the run, to show them something or take them to where a
 * fix lives. It changes nothing but what they are looking at, so like the
 * screenshot it runs unasked everywhere but Manual.
 */
export const AGENT_NAVIGATE_TOOL = "console_navigate";

/** The console tools that act on the operator's browser rather than the cluster. */
export const AGENT_SCREEN_TOOLS: readonly string[] = [AGENT_SCREENSHOT_TOOL, AGENT_NAVIGATE_TOOL];

/**
 * Whether a path is a console page the agent may open: same-origin, absolute,
 * and not an API route, so it can only ever move the operator between screens.
 */
export function isConsolePath(path: string): boolean {
	return /^\/(?![\/\\])[^\s]*$/.test(path)
		&& !/^\/api(\/|$|\?)/.test(path)
		&& path.length <= 500;
}

/** Whether the agent may stop and ask the operator a question in a mode. */
export function agentCanAsk(mode: AgentMode): boolean {
	return mode !== "auto";
}

/** Whether a value names a mode. */
export function isAgentMode(value: unknown): value is AgentMode {
	return typeof value === "string" && (AGENT_MODES as readonly string[]).includes(value);
}
