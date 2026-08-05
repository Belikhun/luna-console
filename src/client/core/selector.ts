// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/selector: the model and its validation are pure, so the
 * console can check a draft as the admin types; everything that reads
 * `servers.yml` or talks to the proxy runs in the daemon.
 */

import type * as core from "../../core/selector";
import type { ProgressReporter } from "../../core/progress";
import type { ClusterConfig } from "../../core/types";

import { call, jobCall } from "../rpc";

export {
	SELECTOR_STATUSES,
	SELECTOR_PAGE_SIZE,
	KNOWN_PLACEHOLDERS,
	DEFAULT_STATUS_MATERIALS,
	isPlaced,
	selectorErrors,
	validateSelectorDraft,
} from "../../shared/selector";
export type {
	SelectorStatus,
	SelectorConditionalRule,
	InstanceSelectorEntry,
	SelectorTemplate,
	SelectorTemplateOverride,
	SelectorMessages,
	SelectorDiagnostics,
	ServerSelectorConfig,
	SelectorServerDraft,
	SelectorDraft,
	SelectorIssue,
} from "../../shared/selector";
// pure registry surgery; it mutates the object the caller already holds, so it
// belongs on this side of the socket rather than costing a round trip
export { applyDraftToCluster } from "../../core/selector";
export { parseWhen, formatWhen, WHEN_OPERATORS, WHEN_VARIABLES } from "../../shared/selectorwhen";
export type { WhenExpression, WhenClause, WhenTerm, WhenOperator } from "../../shared/selectorwhen";
export type { SelectorState, ApplyResult, ImportReport } from "../../core/selector";

// The daemon-side wrappers drop the `primaryName` argument the core functions
// take; it is the daemon's own identity, which a client cannot know; so these
// are typed by hand rather than off `typeof core.*`.

export const draft = call("selector.draft", { cfg: 0 }) as (cfg: ClusterConfig) => Promise<core.SelectorDraft>;
export const preview = call("selector.preview", { cfg: 0 }) as (cfg: ClusterConfig) => Promise<string>;
export const state = call("selector.state", { cfg: 0 }) as (cfg: ClusterConfig) => Promise<core.SelectorState>;
export const importServersYml = call("selector.import", { cfg: 0 }) as (
	cfg: ClusterConfig,
	opts?: { dryRun?: boolean; force?: boolean },
) => Promise<core.ImportReport>;
export const apply = jobCall("selector.apply", {
	cfg: 0,
	reporter: { arg: 1, prop: "reporter" },
	kind: "selector-apply",
}) as (cfg: ClusterConfig, opts?: { reporter?: ProgressReporter }) => Promise<core.ApplyResult>;
