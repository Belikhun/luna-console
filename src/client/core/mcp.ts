// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/mcp.
 *
 * Every function is an RPC; a token's digest never leaves the daemon, so there is
 * no bridge for the raw token store and authorizing a bearer is itself an op.
 */

import type * as core from "../../core/mcp";

import { call } from "../rpc";

export {
	DEFAULT_MCP_CALLS,
	KNOWLEDGE_KINDS,
	MAX_KNOWLEDGE_BODY,
	MAX_MCP_CALLS,
	MCP_MAX_AUDIT,
	MCP_TOKEN_NAME_PATTERN,
	SKILL_NAME_PATTERN,
} from "../../core/mcp";
export type {
	CreateMcpTokenInput,
	KnowledgeFilter,
	KnowledgeInput,
	KnowledgeItem,
	KnowledgeKind,
	KnowledgePatch,
	KnowledgeScope,
	McpAuditAction,
	McpAuditEntry,
	McpCallInput,
	McpCallPage,
	McpCallQuery,
	McpCallRecord,
	McpOnBehalfOf,
	McpPrincipal,
	McpTokenPatch,
	McpTokenSecret,
	McpTokenSummary,
	MemoryHit,
} from "../../core/mcp";

export const listMcpTokens = call("mcp.listTokens") as typeof core.listMcpTokens;
export const getMcpToken = call("mcp.getToken") as typeof core.getMcpToken;
export const createMcpToken = call("mcp.createToken") as typeof core.createMcpToken;
export const updateMcpToken = call("mcp.updateToken") as typeof core.updateMcpToken;
export const setMcpTokenEnabled = call("mcp.setTokenEnabled") as typeof core.setMcpTokenEnabled;
export const rotateMcpToken = call("mcp.rotateToken") as typeof core.rotateMcpToken;
export const removeMcpToken = call("mcp.removeToken") as typeof core.removeMcpToken;
export const mcpAudit = call("mcp.audit") as typeof core.mcpAudit;
export const authorizeMcpToken = call("mcp.authorize") as typeof core.authorizeMcpToken;
export const recordMcpCall = call("mcp.recordCall") as typeof core.recordMcpCall;
export const readMcpCalls = call("mcp.readCalls") as typeof core.readMcpCalls;
export const mcpInstructions = call("mcp.instructions") as typeof core.mcpInstructions;
export const mcpServerVersion = call("mcp.serverVersion") as () => Promise<string>;
export const listKnowledge = call("mcp.listKnowledge") as typeof core.listKnowledge;
export const getKnowledge = call("mcp.getKnowledge") as typeof core.getKnowledge;
export const knowledgeFor = call("mcp.knowledgeFor") as typeof core.knowledgeFor;
export const createKnowledge = call("mcp.createKnowledge") as typeof core.createKnowledge;
export const updateKnowledge = call("mcp.updateKnowledge") as typeof core.updateKnowledge;
export const removeKnowledge = call("mcp.removeKnowledge") as typeof core.removeKnowledge;
export const searchMemories = call("mcp.searchMemories") as typeof core.searchMemories;
