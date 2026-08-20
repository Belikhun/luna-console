// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/** Coarse duration, dropping to the two most significant units. Null renders as a dash. */
export function fmtDuration(ms: number | null): string {
	if (ms == null) {
		return '–';
	}

	const seconds = Math.floor(ms / 1000);

	if (seconds < 60) {
		return `${seconds}s`;
	}

	const minutes = Math.floor(seconds / 60);

	if (minutes < 60) {
		return `${minutes}m ${seconds % 60}s`;
	}

	const hours = Math.floor(minutes / 60);

	if (hours < 48) {
		return `${hours}h ${minutes % 60}m`;
	}

	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Human-readable byte count, one decimal below 100 of a unit. */
export function fmtBytes(n: number): string {
	if (n < 1024) {
		return `${n} B`;
	}

	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = n / 1024;
	let unit = 0;

	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}

	return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** Wall-clock time of a timestamp, in the console's en-GB locale. */
export function fmtTime(t: number): string {
	return new Date(t).toLocaleTimeString('en-GB');
}

/** Date and time of a timestamp, in the console's en-GB locale. */
export function fmtDateTime(t: number): string {
	return new Date(t).toLocaleString('en-GB');
}

/**
 * Ceiling a per-instance CPU figure is measured against, percent.
 *
 * An instance's CPU is percent of *one* core, so a threaded server reads well
 * past 100: a 366% survival backend is nearly four cores' worth of work, not a
 * fault. A bar scaled to 100 pegs from the second busy thread onwards and then
 * reports every busy server as identical, so the denominator is the machine's
 * whole capacity instead.
 *
 * @param cores cores of the machine the instance runs on; unknown counts as one,
 *   which keeps the old single-core scale rather than inventing headroom
 * @returns the maximum to give a gauge, always at least 100
 */
export function cpuCeiling(cores: number | null | undefined): number {
	return Math.max(1, Number(cores) || 1) * 100;
}

/** A CPU percentage as shown: one decimal, so a busy server is not rounded flat. */
export function fmtCpuPct(value: number): string {
	return `${Math.round(value * 10) / 10}%`;
}
