// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/** Bridge mirror of core/standardize; the migration is a daemon job. */

import type * as core from "../../core/standardize";

import { jobCall } from "../rpc";

export { NAMING_VERSION } from "../../core/standardize";
export type { StandardizeReport } from "../../core/standardize";

export const standardizeNaming = jobCall("standardize.standardizeNaming", {
	cfg: 0,
	lock: 1,
	reporter: { arg: 2, prop: "reporter" },
	kind: "standardize",
}) as typeof core.standardizeNaming;
