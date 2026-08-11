// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * One pooled addon a java agent may name, as the instance config route reports
 * it. Only addons this instance is actually given are listed: an agent naming
 * one it never receives is a server that refuses to start.
 */
export interface AgentAddon {
	/** lockfile key, e.g. "nova@paper" */
	key: string;
	/** where deploy puts it, relative to the instance directory */
	path: string;
	version: string | null;
}
