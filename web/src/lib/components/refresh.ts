// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/** Auto-refresh intervals offered by RefreshControl; labels are i18n keys. */
export const REFRESH_INTERVALS: Array<{ label: string; ms: number }> = [
	{ label: 'web.refresh.off', ms: 0 },
	{ label: 'web.refresh.s5', ms: 5_000 },
	{ label: 'web.refresh.s10', ms: 10_000 },
	{ label: 'web.refresh.m1', ms: 60_000 },
	{ label: 'web.refresh.m5', ms: 300_000 },
	{ label: 'web.refresh.m15', ms: 900_000 }
];

export const DEFAULT_REFRESH_MS = 10_000;

/**
 * Absolute timestamp in the console's format, e.g.
 * "August 1, 2026, 13:38 (UTC+7:00)".
 */
export function formatLastUpdated(at: number | null): string {
	if (!at) {
		return '—';
	}

	const when = new Date(at);
	const date = when.toLocaleDateString('en-US', {
		month: 'long',
		day: 'numeric',
		year: 'numeric'
	});

	const time = when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

	// getTimezoneOffset is minutes *behind* UTC, so the sign is inverted here
	const offsetMin = -when.getTimezoneOffset();
	const sign = offsetMin < 0 ? '-' : '+';
	const abs = Math.abs(offsetMin);
	const zone = `UTC${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}`;

	return `${date}, ${time} (${zone})`;
}

/** Read a stored refresh interval, ignoring anything not on the offered list. */
export function loadInterval(storageKey: string | undefined): number {
	if (!storageKey || typeof localStorage === 'undefined') {
		return DEFAULT_REFRESH_MS;
	}

	const raw = localStorage.getItem(`luna.refresh.${storageKey}`);
	const ms = raw === null ? NaN : Number(raw);

	return REFRESH_INTERVALS.some((interval) => interval.ms === ms) ? ms : DEFAULT_REFRESH_MS;
}

/** Persist a refresh interval. Controls without a storage key are not remembered. */
export function saveInterval(storageKey: string | undefined, ms: number): void {
	if (!storageKey || typeof localStorage === 'undefined') {
		return;
	}

	localStorage.setItem(`luna.refresh.${storageKey}`, String(ms));
}
