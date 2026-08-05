// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/screen; screen sessions live on the same host as the
 * daemon the client talks to, and attaching needs the caller's own terminal,
 * so this module stays entirely local.
 */

export * from "../../core/screen";
