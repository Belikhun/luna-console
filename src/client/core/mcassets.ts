/**
 * Bridge mirror of core/mcassets: the version pin is pure arithmetic over the
 * registry; downloading and extracting Mojang's client jar happens in the daemon.
 */

import type * as core from "../../core/mcassets";
import type { ProgressReporter } from "../../core/progress";
import type { ClusterConfig } from "../../core/types";

import { call, jobCall } from "../rpc";

export { pinnedMcVersion, assetsDir, registryPath, texturePath, unihexPath } from "../../core/mcassets";
export type { ItemRender, McAssetRegistry, McAssetState } from "../../core/mcassets";

export const assetState = call("mcassets.state", { cfg: 0 }) as typeof core.assetState;
export const ensureMcAssets = jobCall("mcassets.ensure", {
	cfg: 0,
	reporter: { arg: 1, prop: "reporter" },
	kind: "mcassets",
}) as (
	cfg: ClusterConfig,
	opts?: { version?: string; force?: boolean; reporter?: ProgressReporter },
) => Promise<core.McAssetState>;
