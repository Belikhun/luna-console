// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Fetching a LunaCore log in full.
 *
 * Every paged log the proxy serves (sessions, chat, moderation) clamps a request
 * to `LOG_PAGE` rows however many are asked for, so a complete record is several
 * requests. The first one reports the total; the rest are independent and go out
 * together. Screens used to each carry this loop; they share it now, so a cap or
 * a page size changes in one place.
 */

/** The most rows one LunaCore request answers with. */
export const LOG_PAGE = 200;

/** How many rows a screen loads before it says "newest N of TOTAL shown". */
export const LOG_LIMIT = 2000;

/**
 * Fetch the rest of a log whose first page already reported its total, newest
 * first and capped at `LOG_LIMIT` rows in all.
 *
 * @param total the size the first request reported
 * @param loaded how many rows the first request returned
 * @param fetchPage one page at the given offset; an unavailable page is `[]`
 */
export async function restOfLog<T>(
	total: number,
	loaded: number,
	fetchPage: (offset: number) => Promise<T[]>
): Promise<T[]> {
	const wanted = Math.min(total, LOG_LIMIT);
	const offsets: number[] = [];

	for (let offset = loaded; offset < wanted; offset += LOG_PAGE) {
		offsets.push(offset);
	}

	const pages = await Promise.all(offsets.map((offset) => fetchPage(offset)));

	return pages.flat().slice(0, wanted - loaded);
}

/** A page of a log plus the total the route reported alongside it. */
export interface LogPage<T> {
	total: number;
	rows: T[];
}

/**
 * The whole log, first page and the rest, in one call: `fetchPage(0)` reports
 * the total, and `restOfLog` fans out the remainder.
 */
export async function loadWholeLog<T>(
	fetchPage: (offset: number) => Promise<LogPage<T>>
): Promise<{ total: number; rows: T[] }> {
	const first = await fetchPage(0);
	const rest = await restOfLog<T>(first.total, first.rows.length, async (offset) => (await fetchPage(offset)).rows);

	return { total: first.total, rows: [...first.rows, ...rest] };
}
