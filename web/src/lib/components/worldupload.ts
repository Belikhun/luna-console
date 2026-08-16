// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The shape a staged world takes while the console is holding on to one.
 *
 * In a sibling module rather than in the component, because a type exported
 * from a `.svelte` script block does not resolve for its callers.
 */

import type { WorldFinding, WorldImportPlan, WorldScan } from '$core/world';

/** Where a staged world has got to. */
export type StagedWorldPhase =
	| 'idle'
	| 'uploading'
	| 'scanning'
	| 'reviewing'
	| 'confirmed'
	| 'error';

/** What the scan found, plus where each part of it would land. */
export type StagedWorldScan = WorldScan & { plan: WorldImportPlan };

/**
 * A world zip staged on the server.
 *
 * This, and not a browser `File`, is what a form submits: it names a file the
 * daemon already has and has already read. A parent can therefore never send
 * something the server has not accepted, which is the whole point of the
 * staging step.
 */
export interface StagedWorld {
	/** The server-side handle; the only thing a submit has to carry */
	token: string;
	phase: StagedWorldPhase;
	fileName: string;
	fileSizeBytes: number;
	/** Bytes accepted so far, for the readout in the drop zone */
	uploadedBytes: number;
	/** 0..1 for whatever phase is running, null when it cannot be measured */
	progress: number | null;
	/** Bytes per second, while an upload is in flight */
	rate: number;
	/** What the archive turned out to hold; absent until the scan lands */
	scan: StagedWorldScan | null;
	/** The level name the world will be installed under */
	level: string;
	error: string | null;
}

/**
 * The world a replace would destroy, as the confirmation step describes it.
 *
 * Present only when the target already holds one: installing over an empty
 * instance directory destroys nothing, and a confirmation that says otherwise
 * teaches the operator to click through the ones that matter.
 */
export interface WorldReplaceTarget {
	instance: string;
	/** The directories that go, named so the operator recognises them */
	dirs: string[];
	sizeBytes: number;
}

/** Whether a staged world is finished with and safe to submit. */
export function isStagedWorldReady(value: StagedWorld | null | undefined): boolean {
	return !!value && value.phase === 'confirmed';
}

/** Whether anything found forbids the import outright. */
export function hasBlockingFinding(findings: WorldFinding[] | undefined): boolean {
	return (findings ?? []).some((finding) => finding.level === 'error');
}

/**
 * A finding's own wording, by code.
 *
 * The server sends a stable code and its parameters rather than a sentence, so
 * the console renders it in the reader's own language. An unknown code falls
 * back to the code itself, which shows a gap on screen instead of throwing.
 */
export function findingKey(code: string): string {
	return `web.worldWizard.finding.${code}`;
}
