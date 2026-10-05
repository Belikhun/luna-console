// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The build `ModpackPicker` hands its page once a runnable version is chosen:
 * a Modrinth pack by slug and version, or an uploaded .mrpack by staging token.
 */
export interface PickedModpack {
	/** Modrinth project slug; absent for an upload */
	slug?: string;
	/** Modrinth version id; absent for an upload */
	versionId?: string;
	/** Staging token of an uploaded .mrpack; absent for a Modrinth pick */
	stage?: string;
	title: string;
	versionNumber: string;
	/** The hosted loader the build runs on: neoforge, forge or fabric */
	loader: string;
	mcVersion: string;
}
