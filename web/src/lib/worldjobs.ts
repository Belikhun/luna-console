// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The world and backup flows, each behind a live flash card.
 *
 * Sibling of `instancejobs.ts` and the same shape, kept apart because these are
 * the long ones: archiving 29 GB or putting it back runs for minutes, and the
 * card is where the operator watches it. The wording lives here so a job the
 * page *discovers* - started in another tab, by the CLI, or by a schedule -
 * reads exactly as one this browser started.
 */

import { post, del, patch } from '$lib/api';
import { t } from '$lib/i18n.svelte';
import { jobFlash, attachJobFlash, type JobFlashConfig } from '$lib/jobflash';
import type { JobView } from '$lib/jobs';

type FlashConfig = Omit<JobFlashConfig, 'start' | 'started'>;

/** A backup entry as the card's success line describes it. */
interface BackupResult {
	label?: string;
	sizeBytes?: number;
	fileCount?: number;
}

/** Bytes, for a one-line card summary. */
function bytes(value: number | undefined): string {
	if (!value) {
		return '';
	}

	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let size = value;
	let unit = 0;

	while (size >= 1024 && unit < units.length - 1) {
		size /= 1024;
		unit++;
	}

	return `${size < 10 && unit > 0 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

/** The card wording for each world job, shared by starting one and attaching. */
export function worldFlashConfig(kind: string, name: string): FlashConfig {
	if (kind === 'world-backup') {
		return {
			title: t('web.worldJobs.backingUp', { name }),
			success: (result) => {
				const entry = result as BackupResult;

				return {
					message: t('web.worldJobs.backedUp', { name }),
					detail: t('web.worldJobs.backedUpDetail', {
						label: entry?.label ?? '',
						size: bytes(entry?.sizeBytes),
						files: String(entry?.fileCount ?? 0)
					})
				};
			},
			failure: () => ({ message: t('web.worldJobs.backupFailed', { name }) })
		};
	}

	if (kind === 'world-restore') {
		return {
			title: t('web.worldJobs.restoring', { name }),
			success: () => ({ message: t('web.worldJobs.restored', { name }) }),
			failure: () => ({ message: t('web.worldJobs.restoreFailed', { name }) })
		};
	}

	if (kind === 'world-replace') {
		return {
			title: t('web.worldJobs.replacing', { name }),
			success: () => ({ message: t('web.worldJobs.replaced', { name }) }),
			failure: () => ({ message: t('web.worldJobs.replaceFailed', { name }) })
		};
	}

	if (kind === 'world-reset') {
		return {
			title: t('web.worldJobs.resetting', { name }),
			success: () => ({ message: t('web.worldJobs.reset', { name }) }),
			failure: () => ({ message: t('web.worldJobs.resetFailed', { name }) })
		};
	}

	return {
		title: t('web.worldJobs.verifying', { name }),
		success: () => ({ message: t('web.worldJobs.verified', { name }) }),
		failure: () => ({ message: t('web.worldJobs.verifyFailed', { name }) })
	};
}

/** Archive an instance's world; safe while it is running. */
export function backupWorldJob(
	name: string,
	opts: { label?: string; note?: string } = {}
): Promise<JobView | undefined> {
	return jobFlash({
		...worldFlashConfig('world-backup', name),
		start: () => post(`/instances/${name}/world/actions`, { action: 'backup', ...opts })
	});
}

/** Put a backup back over the current world. */
export function restoreWorldJob(
	name: string,
	id: string,
	backupFirst: boolean
): Promise<JobView | undefined> {
	return jobFlash({
		...worldFlashConfig('world-restore', name),
		start: () => post(`/instances/${name}/world/actions`, { action: 'restore', id, backupFirst })
	});
}

/** Install an uploaded world over the current one. */
export function replaceWorldJob(
	name: string,
	token: string,
	opts: { level?: string; source?: string; backupFirst?: boolean } = {}
): Promise<JobView | undefined> {
	return jobFlash({
		...worldFlashConfig('world-replace', name),
		start: () => post(`/instances/${name}/world/actions`, { action: 'replace', token, ...opts })
	});
}

/** Wipe the world so the server regenerates it on next start. */
export function resetWorldJob(name: string, backupFirst: boolean): Promise<JobView | undefined> {
	return jobFlash({
		...worldFlashConfig('world-reset', name),
		start: () => post(`/instances/${name}/world/actions`, { action: 'reset', backupFirst })
	});
}

/** Re-read an archive and record that it is intact. */
export function verifyBackupJob(name: string, id: string): Promise<JobView | undefined> {
	return jobFlash({
		...worldFlashConfig('world-verify', name),
		start: () => post(`/instances/${name}/world/backups/${id}`, { action: 'verify' })
	});
}

/** Rename a backup, annotate it, or pin it out of retention's reach. */
export async function updateBackup(
	name: string,
	id: string,
	body: { label?: string; note?: string; pinned?: boolean }
): Promise<void> {
	await patch(`/instances/${name}/world/backups/${id}`, body);
}

/** Delete one backup and its archive. */
export async function deleteBackup(name: string, id: string): Promise<void> {
	await del(`/instances/${name}/world/backups/${id}`);
}

/** Whether a job kind belongs to this module, for the discovery dispatch. */
export function isWorldJobKind(kind: string): boolean {
	return kind.startsWith('world-');
}

/** Raise the matching card for a world job already in flight. */
export function attachWorldJobFlash(job: JobView): void {
	void attachJobFlash(job, worldFlashConfig(job.kind, job.target));
}
