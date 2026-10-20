// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/iam.
 *
 * Every function is an RPC: the YAML is parsed in the daemon, the store is read
 * there, and what comes back is a summary or a principal's context. The grammar
 * itself (`shared/iam/grammar.ts`) runs on this side too, so a route or a
 * component can evaluate a context it was handed without another round trip.
 */

import type * as core from "../../core/iam";

import { call } from "../rpc";

export { IAM_NAME_PATTERN, MAX_IAM_AUDIT, MAX_POLICY_BYTES } from "../../core/iam";
export type {
	AccountPermissions,
	AttachTarget,
	CreateGroupInput,
	CreatePolicyInput,
	GroupMember,
	GroupPatch,
	GroupSummary,
	IamAuditAction,
	IamAuditEntry,
	InlinePolicyCounts,
	InlineView,
	PolicyPatch,
	PolicySummary,
	PolicyValidationResult,
	SimulationOptions,
	SimulationResult,
} from "../../core/iam";

export const listPolicies = call("iam.listPolicies") as typeof core.listPolicies;
export const getPolicy = call("iam.getPolicy") as typeof core.getPolicy;
export const validatePolicyYaml = call("iam.validatePolicy") as typeof core.validatePolicyYaml;
export const createPolicy = call("iam.createPolicy") as typeof core.createPolicy;
export const updatePolicy = call("iam.updatePolicy") as typeof core.updatePolicy;
export const deletePolicy = call("iam.deletePolicy") as typeof core.deletePolicy;
export const listGroups = call("iam.listGroups") as typeof core.listGroups;
export const getGroup = call("iam.getGroup") as typeof core.getGroup;
export const createGroup = call("iam.createGroup") as typeof core.createGroup;
export const updateGroup = call("iam.updateGroup") as typeof core.updateGroup;
export const deleteGroup = call("iam.deleteGroup") as typeof core.deleteGroup;
export const addGroupMembers = call("iam.addGroupMembers") as typeof core.addGroupMembers;
export const removeGroupMembers = call("iam.removeGroupMembers") as typeof core.removeGroupMembers;
export const attachPolicy = call("iam.attachPolicy") as typeof core.attachPolicy;
export const detachPolicy = call("iam.detachPolicy") as typeof core.detachPolicy;
export const putInlinePolicy = call("iam.putInlinePolicy") as typeof core.putInlinePolicy;
export const deleteInlinePolicy = call("iam.deleteInlinePolicy") as typeof core.deleteInlinePolicy;
export const principalContext = call("iam.principalContext") as typeof core.principalContext;
export const accountPermissions = call("iam.accountPermissions") as typeof core.accountPermissions;
export const authorize = call("iam.authorize") as typeof core.authorize;
export const authorizeMany = call("iam.authorizeMany") as typeof core.authorizeMany;
export const simulatePrincipal = call("iam.simulatePrincipal") as typeof core.simulatePrincipal;
export const inlinePolicyCounts = call("iam.inlineCounts") as typeof core.inlinePolicyCounts;
export const iamAudit = call("iam.audit") as typeof core.iamAudit;
