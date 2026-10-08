// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * When Mèo Béo may run a tool without asking, by mode. Shared by the runner's
 * `canUseTool` and the background tasks, so a task handed to the background
 * can never run what the same call in the foreground would have had to ask for.
 */

import { mcpTool } from '$shared/mcptools';
import { AGENT_LOCAL_TOOLS } from '$shared/agent';
import type { AgentMode } from '$shared/agent';

/** Tools that leave the cluster as it was: those that only read, and the agent's own memory. Plan runs only these. */
function leavesClusterAlone(name: string): boolean {
	const tool = mcpTool(name);

	if (!tool) {
		return false;
	}

	return tool.annotations.readOnlyHint === true || tool.group === 'knowledge-write';
}

/**
 * Whether Auto runs a tool without asking: everything except what the catalog
 * marks destructive (stopping, restarting, raw console commands, removals,
 * shells), which still waits for the operator. The agent's own memory always
 * runs, forgetting included.
 */
function safeUnattended(name: string): boolean {
	const tool = mcpTool(name);

	if (!tool) {
		return false;
	}

	return leavesClusterAlone(name) || tool.annotations.destructiveHint !== true;
}

/** Whether a tool runs without asking in a mode. Plan refuses the rest in `canUseTool` instead. */
export function runsUnasked(name: string, mode: AgentMode): boolean {
	switch (mode) {
		case 'manual':
			return false;

		case 'bypass':
			return true;

		case 'plan':
			if (AGENT_LOCAL_TOOLS.includes(name)) {
				return true;
			}

			return leavesClusterAlone(name);

		default:
			return AGENT_LOCAL_TOOLS.includes(name) || safeUnattended(name);
	}
}
