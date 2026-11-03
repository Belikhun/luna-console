// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/agent.
 *
 * Every function is an RPC. `agentLaunch` is the one that carries the agent's
 * credential, and it exists for the console's agent runner alone.
 */

import type * as core from "../../core/agent";

import { call } from "../rpc";

export {
	AGENT_BUILTIN_SUBAGENTS,
	AGENT_EFFORTS,
	AGENT_SHARE_ROLES,
	AGENT_SUBAGENT_NAME,
	AGENT_MODEL_PATTERN,
	AGENT_MODELS,
	AGENT_TOKEN_NAME,
	MAX_AGENT_CONVERSATIONS,
	MAX_AGENT_ENTRIES,
	MAX_AGENT_MESSAGE,
	MAX_AGENT_SHARES,
	MAX_AGENT_SUBAGENTS,
	MAX_AGENT_TOOL_OUTPUT,
} from "../../core/agent";
export type {
	AgentConversation,
	AgentConversationFlags,
	AgentConversationView,
	AgentCredentialKind,
	AgentEffort,
	AgentContextUsage,
	AgentEntry,
	AgentLaunch,
	AgentModelChoice,
	AgentRole,
	AgentSettings,
	AgentSettingsPatch,
	AgentShare,
	AgentShareRole,
	AgentStatus,
	AgentSubagent,
	AgentTranscript,
	AgentTurnUpdate,
} from "../../core/agent";

export const agentStatus = call("agent.status") as typeof core.agentStatus;
export const setAgentCredential = call("agent.setCredential") as typeof core.setAgentCredential;
export const clearAgentCredential = call("agent.clearCredential") as typeof core.clearAgentCredential;
export const updateAgentSettings = call("agent.updateSettings") as typeof core.updateAgentSettings;
export const recordAgentModels = call("agent.recordModels") as typeof core.recordAgentModels;
export const ensureAgentToken = call("agent.ensureToken") as typeof core.ensureAgentToken;
export const agentLaunch = call("agent.launch") as typeof core.agentLaunch;
export const listAgentConversations = call("agent.listConversations") as typeof core.listAgentConversations;
export const getAgentConversation = call("agent.getConversation") as typeof core.getAgentConversation;
export const agentScratch = call("agent.scratch") as typeof core.agentScratch;
export const agentImagePath = call("agent.imagePath") as typeof core.agentImagePath;
export const createAgentConversation = call("agent.createConversation") as typeof core.createAgentConversation;
export const appendAgentTurn = call("agent.appendTurn") as typeof core.appendAgentTurn;
export const renameAgentConversation = call("agent.renameConversation") as typeof core.renameAgentConversation;
export const removeAgentConversation = call("agent.removeConversation") as typeof core.removeAgentConversation;
export const flagAgentConversation = call("agent.flagConversation") as typeof core.flagAgentConversation;
export const setAgentAllowedTools = call("agent.setAllowedTools") as typeof core.setAgentAllowedTools;
export const shareAgentConversation = call("agent.shareConversation") as typeof core.shareAgentConversation;
export const leaveAgentConversation = call("agent.leaveConversation") as typeof core.leaveAgentConversation;
export const forkAgentConversation = call("agent.forkConversation") as typeof core.forkAgentConversation;
export const rewindAgentConversation = call("agent.rewindConversation") as typeof core.rewindAgentConversation;
