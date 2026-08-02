/**
 * Bridge mirror of core/environment: variable math is pure, the store and the
 * builtin resolution (which reads instance files) live in the daemon.
 */

import type * as core from "../../core/environment";

import { call } from "../rpc";

export { ENV_NAME_PATTERN, setVariable, unsetVariable, substitute } from "../../core/environment";
export type { EnvironmentStore, EnvVarDef } from "../../core/environment";

export const loadEnv = call("environment.loadEnv") as typeof core.loadEnv;
export const saveEnv = call("environment.saveEnv") as typeof core.saveEnv;
export const builtinVars = call("environment.builtinVars", { cfg: 0 }) as typeof core.builtinVars;
export const resolveVars = call("environment.resolveVars", { cfg: 0 }) as typeof core.resolveVars;
