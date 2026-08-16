// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The half of core/settings that needs a daemon: reading and writing an
 * instance's `server.properties`.
 *
 * Separate from `client/core/settings.ts` because that module is imported by
 * the console's own components, and anything reaching `../rpc` drags the
 * unix-socket client - and `node:fs` with it - into the browser bundle. Same
 * split, and same reason, as `client/core/services/software.ts`.
 */

import type * as core from "../../../core/settingsapply";

import { call } from "../../rpc";

export const readServerProperties = call("settings.readServerProperties", {
	cfg: 0,
}) as typeof core.readServerProperties;

export const applySettings = call("settings.applySettings", {
	cfg: 0,
}) as typeof core.applySettings;
