// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/** The build `ModpackPicker` hands its page once a runnable version is chosen. */
export interface PickedModpack {
	slug: string;
	title: string;
	versionId: string;
	versionNumber: string;
	/** The hosted loader the build runs on: neoforge, forge or fabric */
	loader: string;
	mcVersion: string;
}
