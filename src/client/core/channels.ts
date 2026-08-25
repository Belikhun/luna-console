// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/channels: the release-channel vocabulary, as pure data.
 *
 * The same rule `client/core/software.ts`, `settings.ts` and `memory.ts` state:
 * nothing here may reach the RPC client. `ChannelSelect.svelte` imports this to
 * render its options, and it read them from `client/core/services/providers.ts`
 * first; that module calls `call()` at its top, which drags `client/socket.ts`
 * and `node:fs` into the browser bundle and 500s every page rendering the
 * component under `luna web --dev`.
 */

export { isReleaseChannel, RELEASE_CHANNELS } from "../../core/channels";
export type { ReleaseChannel } from "../../core/channels";
