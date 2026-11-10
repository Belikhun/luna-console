// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/claudecode: the Claude Code build Mèo Béo runs.
 *
 * Both functions touch the network and the cluster root, so both run in the
 * daemon; an upgrade is a job whose progress mirrors into the caller's reporter.
 */

import type * as core from "../../core/claudecode";

import { call, jobCall } from "../rpc";

export type { ClaudeCodeCheck, ClaudeCodeTarget, ClaudeCodeUpgradeResult } from "../../core/claudecode";

export const checkClaudeCode = call("agent.checkClaudeCode") as typeof core.checkClaudeCode;
export const upgradeClaudeCode = jobCall("agent.upgradeClaudeCode", {
	reporter: { arg: 0, prop: "reporter" },
	kind: "claude-code-upgrade",
}) as typeof core.upgradeClaudeCode;
