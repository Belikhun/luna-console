/** Bridge mirror of core/templates — config ops apply on the instance's daemon. */

import type * as core from "../../core/templates";

import { call } from "../rpc";

export { notableTemplateResults } from "../../core/templates";
export type { TemplateResult } from "../../core/templates";

export const applyTemplates = call("templates.applyTemplates", {
	cfg: 0,
	lock: 1,
}) as typeof core.applyTemplates;
