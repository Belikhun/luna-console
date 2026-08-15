// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';

import {
	JOURNAL_LEVELS,
	JOURNAL_SOURCES,
	readJournal,
	type JournalLevel,
	type JournalSource
} from '$core/journal';

/**
 * The console journal: what luna itself has been doing on this machine.
 *
 * The filtering happens in core, over the monthly files, rather than in the
 * browser: a month's journal is far larger than a screen's worth, and shipping it
 * all so the client can drop 99% of it is not a filter.
 */
export async function GET({ url }) {
	const params = url.searchParams;
	const sources = params
		.getAll('source')
		.filter((value): value is JournalSource => JOURNAL_SOURCES.includes(value as JournalSource));
	const level = params.get('level');
	const since = Number(params.get('since') ?? '');

	const page = await readJournal({
		limit: Number(params.get('limit') ?? '') || undefined,
		sources: sources.length ? sources : undefined,
		minLevel: JOURNAL_LEVELS.includes(level as JournalLevel)
			? (level as JournalLevel)
			: undefined,
		since: Number.isFinite(since) && since > 0 ? since : undefined,
		search: params.get('search') || undefined
	});

	return json(page);
}
