// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/journal. The files live in the cluster root, so both
 * halves are RPCs; the vocabulary (sources, levels, caps) is pure data and comes
 * across as a plain re-export, which is what lets a filter be built without a
 * round trip.
 */

import type * as core from "../../core/journal";

import { call } from "../rpc";

export {
	DEFAULT_JOURNAL_LINES,
	JOURNAL_LEVELS,
	JOURNAL_SOURCES,
	MAX_JOURNAL_LINES,
} from "../../core/journal";
export type { JournalEntry, JournalLevel, JournalPage, JournalQuery, JournalSource } from "../../core/journal";

export const appendJournal = call("journal.append") as typeof core.appendJournal;
export const readJournal = call("journal.read") as typeof core.readJournal;
