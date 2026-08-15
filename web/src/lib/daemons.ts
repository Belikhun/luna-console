// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Derived figures shared by the daemons list and detail views. The shapes
 * themselves come from the daemon (`$client/daemon`); only the arithmetic the
 * two pages would otherwise duplicate lives here.
 */

import type { DaemonRow, HealthSample } from '$client/daemon';

/** Memory utilization of a health sample, percent; null when not measured. */
export function memPct(health: HealthSample | null | undefined): number | null {
	if (!health || health.memTotalMb <= 0) {
		return null;
	}

	return Math.round((health.memUsedMb / health.memTotalMb) * 100);
}

/** Cluster-root disk utilization of a health sample, percent. */
export function diskPct(health: HealthSample | null | undefined): number | null {
	if (!health || health.diskTotalBytes <= 0) {
		return null;
	}

	return Math.round((health.diskUsedBytes / health.diskTotalBytes) * 100);
}

/** Bytes → "12.4 GB". */
export function fmtGb(bytes: number): string {
	return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/**
 * Tone for a heartbeat round-trip. A LAN hop is a couple of milliseconds, so
 * the thresholds are deliberately tight; 100ms between two machines in the
 * same rack means something is wrong with the link, not with the distance.
 */
export function latencyTone(ms: number | null): 'accent' | 'warning' | 'danger' {
	if (ms === null) {
		return 'accent';
	}

	if (ms >= 250) {
		return 'danger';
	}

	if (ms >= 100) {
		return 'warning';
	}

	return 'accent';
}

/**
 * The badge a daemon's link gets, in one place because three views draw it.
 *
 * Quarantined is red rather than amber, and separate from degraded on purpose:
 * a degraded machine is doing its job with something wrong, a quarantined one is
 * connected and answering but has been refused the job entirely, so treating the
 * two alike would hide the more serious of them behind the softer word.
 */
export function linkBadge(row: DaemonRow): { state: string; label: string } {
	if (row.state === 'offline') {
		return { state: 'stopped', label: 'Offline' };
	}

	if (row.state === 'quarantined') {
		return { state: 'error', label: 'Quarantined' };
	}

	if (checksFailed(row) > 0) {
		return { state: 'warning', label: 'Degraded' };
	}

	return { state: 'ok', label: 'Online' };
}

/** How many of a daemon's checks passed (checks that do not apply do not count). */
export function checksPassed(row: DaemonRow): number {
	return row.checks.filter((check) => check.ok === true).length;
}

/** How many of a daemon's checks are outright failing. */
export function checksFailed(row: DaemonRow): number {
	return row.checks.filter((check) => check.ok === false).length;
}
