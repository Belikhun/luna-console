// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { currentLanguage } from '$lib/i18n.svelte';

/** A moment as the console receives it: epoch milliseconds, an ISO string or a `Date`. */
export type DateValue = number | string | Date;

/** Everything `DateTime`'s card says about one moment, already worded for the reader. */
export interface DateFacts {
	/** weekday, date and time to the second, in the viewer's zone */
	local: string;
	/** the viewer's IANA zone: "Asia/Ho_Chi_Minh" */
	zone: string;
	/** the zone's own name in the reader's language: "Indochina Time" */
	zoneName: string;
	/** "UTC+07:00", at that moment (so a summer date reads its summer offset) */
	offset: string;
	/** "3 hours ago", "in 2 days" */
	relative: string;
	/** the same moment on the UTC clock */
	utc: string;
	/** `2026-11-14T07:02:11.000Z` */
	iso: string;
	/** `2026-11-14T14:02:11+07:00`: the local reading with its offset */
	isoLocal: string;
	/** whole seconds since the epoch */
	unix: number;
	/** milliseconds since the epoch */
	unixMs: number;
}

const DATE_LOCALES: Record<string, string> = { en: 'en-GB', vi: 'vi-VN' };

const RELATIVE_STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
	['second', 60],
	['minute', 60],
	['hour', 24],
	['day', 30],
	['month', 12],
	['year', Infinity]
];

/** The `Intl` locale the console's language reads dates in. Tracked, so a switch repaints. */
export function dateLocale(): string {
	return DATE_LOCALES[currentLanguage()] ?? 'en-GB';
}

/** Epoch milliseconds of a moment, or null when it is missing or not a date. */
export function toMillis(at: DateValue | null | undefined): number | null {
	if (at === null || at === undefined || at === '') {
		return null;
	}

	const ms = at instanceof Date
		? at.getTime()
		: typeof at === 'number'
			? at
			: Date.parse(at);

	return Number.isFinite(ms)
		? ms
		: null;
}

/** The console's default reading of a moment: "14 Nov 2026, 14:02:11". */
export function fmtMoment(ms: number): string {
	return new Date(ms).toLocaleString(dateLocale(), {
		day: 'numeric',
		month: 'short',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false
	});
}

/** "in 2 days", "3 hours ago", "now": the largest unit that fits, in the reader's language. */
export function fmtRelative(ms: number, now: number): string {
	const format = new Intl.RelativeTimeFormat(dateLocale(), { numeric: 'auto' });
	let value = Math.round((ms - now) / 1000);

	for (const [unit, size] of RELATIVE_STEPS) {
		if (Math.abs(value) < size) {
			return format.format(value, unit);
		}

		value = Math.round(value / size);
	}

	return format.format(value, 'year');
}

/** "+07:00" for an offset east of UTC in minutes. */
function offsetText(minutes: number): string {
	const sign = minutes < 0
		? '-'
		: '+';

	const size = Math.abs(minutes);
	const hours = String(Math.floor(size / 60)).padStart(2, '0');
	const rest = String(size % 60).padStart(2, '0');

	return `${sign}${hours}:${rest}`;
}

/** The local wall clock with its offset, as ISO 8601 writes it. */
function isoWithOffset(date: Date, offsetMinutes: number): string {
	const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
	const clock = shifted.toISOString().slice(0, 19);
	const millis = date.getMilliseconds();

	const fraction = millis
		? `.${String(millis).padStart(3, '0')}`
		: '';

	return `${clock}${fraction}${offsetText(offsetMinutes)}`;
}

/**
 * Every reading of one moment the date card lists, in the console's language
 * and the viewer's time zone.
 *
 * @param ms the moment, epoch milliseconds
 * @param now the clock the relative reading is measured against
 */
export function dateFacts(ms: number, now: number = Date.now()): DateFacts {
	const locale = dateLocale();
	const date = new Date(ms);

	// getTimezoneOffset is minutes *behind* UTC, so east of Greenwich is negative
	const offsetMinutes = -date.getTimezoneOffset();
	const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

	const zoneName = new Intl.DateTimeFormat(locale, { timeZoneName: 'long' })
		.formatToParts(date)
		.find((part) => part.type === 'timeZoneName')?.value ?? zone;

	const clock: Intl.DateTimeFormatOptions = {
		weekday: 'long',
		day: 'numeric',
		month: 'long',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false
	};

	return {
		local: date.toLocaleString(locale, clock),
		zone,
		zoneName,
		offset: `UTC${offsetText(offsetMinutes)}`,
		relative: fmtRelative(ms, now),
		utc: date.toLocaleString(locale, { ...clock, timeZone: 'UTC' }),
		iso: date.toISOString(),
		isoLocal: isoWithOffset(date, offsetMinutes),
		unix: Math.floor(ms / 1000),
		unixMs: ms
	};
}
