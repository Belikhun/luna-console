// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/software: the traits table, as pure data.
 *
 * A client asking what launch kind a software has, or which families it
 * accepts, is asking about a constant and should not need a daemon for it -
 * which is why the console's own components import this module directly.
 *
 * Nothing here may reach the RPC client. That path pulls in the unix-socket
 * plumbing, and `node:path` with it, which a browser bundle cannot have. The
 * version lists, which genuinely do need the daemon, live in
 * `client/core/services/software.ts` for exactly that reason.
 */

export type {
	ForwardingKind,
	ForwardingMod,
	LaunchKind,
	LogGrammar,
	PortConfig,
	SoftwareTraits,
} from "../../core/software";

export {
	compareMcVersionsDesc,
	FAMILY_DIRS,
	familyForDir,
	hasLoaderVersions,
	hasProvider,
	isReleaseVersion,
	mcVersionParts,
	newestRelease,
	SOFTWARE_IDS,
	SOFTWARE_TRAITS,
	traitsOf,
} from "../../core/software";

export type { BuildSpec, SoftwareBuild, SoftwareProviderId } from "../../core/services/software/types";
