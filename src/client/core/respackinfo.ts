/**
 * Bridge mirror of core/respackinfo. Every function here reads something only
 * the daemon's machine has; the packs directory, the proxy's config, the web
 * server's access log, the proxy's own HTTP API; so all of them are RPCs.
 */

import type * as core from "../../core/respackinfo";

import { call } from "../rpc";

export type {
	PackFailures,
	PackHolder,
	PackHolders,
	PackLoadFailure,
	PackInstanceUse,
	PackManifest,
	PackReachability,
	PackRequest,
	PackResolution,
	PackServeConfig,
	PackTraffic,
	RespackDetail,
	ZipEntry,
} from "../../core/respackinfo";

export const resourcePackDetail = call("respacks.detail", { cfg: 0, lock: 1 }) as typeof core.resourcePackDetail;
export const packServeConfig = call("respacks.serveConfig", { cfg: 0 }) as typeof core.packServeConfig;
export const packHolders = call("respacks.holders") as typeof core.packHolders;
export const packLoadFailures = call("respacks.loadFailures", { cfg: 0 }) as typeof core.packLoadFailures;
export const packResolution = call("respacks.resolution") as typeof core.packResolution;
