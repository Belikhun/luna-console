// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/memory: heap-string arithmetic, as pure functions.
 *
 * Nothing here may reach the RPC client - the same rule `client/core/software.ts`
 * and `client/core/settings.ts` state, and for the same reason. The console's
 * `InstanceRuntimeFields` imports this to drive the memory slider, so a single
 * `call()` here would break every page that renders the field.
 */

export {
	assertMemoryValue,
	formatMemoryGb,
	formatMemoryMb,
	isMemoryValue,
	memoryBytes,
	MEMORY_FALLBACK,
	MEMORY_MIN_MB,
	MEMORY_STEP_MB,
	parseMemoryMb,
} from "../../core/memory";
