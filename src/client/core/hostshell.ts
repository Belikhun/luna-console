// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/hostshell. `runHostCommand` is routed to the machine
 * owning the instance, and that machine's own `mcpHostShell` setting decides.
 */

import type * as core from "../../core/hostshell";

import { call } from "../rpc";

export {
	HOST_SHELL_DEFAULT_TIMEOUT_MS,
	HOST_SHELL_MAX_COMMAND,
	HOST_SHELL_MAX_OUTPUT,
	HOST_SHELL_MAX_TIMEOUT_MS,
} from "../../core/hostshell";
export type { HostCommandOptions, HostCommandResult } from "../../core/hostshell";

export const runHostCommand = call("hostshell.run", { cfg: 0 }) as typeof core.runHostCommand;
export const hostShellEnabled = call("hostshell.enabled") as () => Promise<boolean>;
