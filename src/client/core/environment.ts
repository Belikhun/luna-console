// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/environment: variable math is pure, the store and the
 * builtin resolution (which reads instance files) live in the daemon.
 */

import type * as core from "../../core/environment";
import type { ClusterConfig } from "../../core/types";
import { layerScopes } from "../../core/environment";

import { call } from "../rpc";

export {
	BUILTIN_SECRETS,
	ENV_NAME_PATTERN,
	ENV_SCOPES,
	ENV_SCRIPT,
	MAX_HISTORY,
	layerScopes,
	machineKeyOf,
	recordChange,
	renderEnvFile,
	scopesOf,
	setVariable,
	substitute,
	unsetInstanceScope,
	unsetVariable,
} from "../../core/environment";
export type {
	EnvChange,
	EnvironmentStore,
	EnvScope,
	EnvVarDef,
	ResolvedVar,
	ScopeTarget,
} from "../../core/environment";

export const loadEnv = call("environment.loadEnv") as typeof core.loadEnv;
export const saveEnv = call("environment.saveEnv") as typeof core.saveEnv;
export const builtinVars = call("environment.builtinVars", { cfg: 0 }) as typeof core.builtinVars;
export const resolveVars = call("environment.resolveVars", { cfg: 0 }) as typeof core.resolveVars;
/**
 * Resolve an instance's environment with the scope each value came from.
 *
 * Deliberately **not** a single op: the layering is pure math over a store that
 * is byte-identical on every machine, so only the builtins need the instance's
 * own daemon; and `environment.builtinVars` has existed since the first
 * release. Doing it this way keeps the screen working against a follower that
 * has not been upgraded yet, which a newer op would not.
 */
export async function resolveDetailed(
	cfg: ClusterConfig,
	store: core.EnvironmentStore,
	instance: string,
): Promise<core.ResolvedVar[]> {
	return layerScopes(cfg, store, instance, await builtinVars(cfg, instance));
}

/**
 * Reveal a secret's value. The daemon loads the store, records the read in its
 * trail and saves it, so the reveal is audited wherever it came from.
 */
export const revealAndRecord = call("environment.reveal") as typeof core.revealAndRecord;

/**
 * Rewrite one instance's `.luna-env` from the store without restarting it. The
 * JVM only reads the file at startup, so this is a staging step; what it buys
 * is a wrapper loop that picks the new values up on its next crash-restart, and
 * a file the operator can inspect.
 */
export const writeEnvFile = call("environment.writeEnvFile", {
	cfg: 0,
}) as typeof import("../../core/instances").writeEnvFile;
