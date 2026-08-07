// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/profiles.
 *
 * Java profiles live in `cluster.json` and every function here mutates the
 * config object the caller already loaded, so all of it runs in-process: the
 * daemon round trip is the `config.saveCluster` the caller makes afterwards,
 * exactly as it is for any other registry edit. There are no profile ops.
 */

export {
	createProfile,
	getProfile,
	listProfiles,
	profileConsumers,
	removeProfile,
	renameProfile,
	updateProfile,
} from "../../core/profiles";
export type { ProfileSummary } from "../../core/profiles";
