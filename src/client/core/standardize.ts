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
