/**
 * Bridge mirror of core/services/providers — version-picking, URL building
 * and the compatibility rule are pure; the API calls (and the CurseForge key)
 * live in the daemon, so search/lookup go over RPC.
 */

import type * as core from "../../../core/services/providers";

import { call } from "../../rpc";

export {
	PAPER_LOADERS,
	VELOCITY_LOADERS,
	NEOFORGE_LOADERS,
	RESOURCEPACK_LOADERS,
	DATAPACK_LOADERS,
	PROVIDER_IDS,
	coversMc,
	pickCompatible,
	primaryFile,
	projectUrl,
	remoteRefFor,
	versionUrl,
} from "../../../core/services/providers";
export type {
	AddonProject,
	AddonSearchHit,
	AddonType,
	AddonVersion,
	AddonVersionFile,
	ProviderStatus,
	ReleaseChannel,
} from "../../../core/services/providers";

export const providerStatus = call("providers.status") as typeof core.providerStatus;
export const searchProvider = call("providers.search") as typeof core.searchProvider;
export const getProject = call("providers.getProject") as typeof core.getProject;
export const getVersions = call("providers.getVersions") as typeof core.getVersions;
