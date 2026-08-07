// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Job kinds both the daemon and its clients name.
 *
 * A kind is normally the op's own name and nobody has to agree on it; the
 * upgrade is the exception, because the daemon has to recognise the job the
 * upgrade itself runs in and not count it as work worth waiting for.
 */

/** Registry kind of a daemon upgrade, on the daemon and on the client alike. */
export const UPGRADE_JOB_KIND = "daemon-upgrade";
