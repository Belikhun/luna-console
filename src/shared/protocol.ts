// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Revision of the local API a daemon serves and a client speaks.
 *
 * It lives in `shared/` because both halves need the same number and a client
 * refuses to talk across a mismatch: two copies kept in sync by hand drift the
 * first time only one of them is remembered, and the symptom is every command
 * failing against a daemon built from the same commit.
 *
 * Bump it whenever an op's wire shape changes, not when behaviour behind an
 * unchanged shape does. This is not the build version; `src/version.ts` carries
 * that, and an upgrade is what changes it.
 *
 * 4: the papermc ops became software-registry ops, and `admin.setVersion` takes
 *    an options object rather than a bare Minecraft version.
 */
export const PROTOCOL_VERSION = 4;
