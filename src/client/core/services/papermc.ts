/** Bridge mirror of core/services/papermc — Fill API calls run in the daemon. */

import type * as core from "../../../core/services/papermc";

import { call } from "../../rpc";

export type { BuildInfo, PaperProject } from "../../../core/services/papermc";

export const latestBuild = call("papermc.latestBuild") as typeof core.latestBuild;
export const listVersions = call("papermc.listVersions") as typeof core.listVersions;
