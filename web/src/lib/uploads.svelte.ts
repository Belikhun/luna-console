// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The file manager's upload queue: many files, each sent in chunks the daemon
 * appends to a staged copy, then placed into the instance by the daemon that
 * owns it.
 *
 * Chunks rather than one body because an upload here is routinely a world or
 * a modpack measured in gigabytes over a domestic connection: a dropped
 * request costs one chunk, not the file, and the queue asks the daemon where
 * the file stands (`GET ?token=`) and resumes from there. A few files travel
 * at once; one at a time wastes a fast link, many at once share it too thinly
 * for any of them to finish.
 *
 * State is Svelte runes so the queue panel repaints as bytes land; the class
 * itself is plain so a page can hold one and the panel can read it.
 */

import { api, post } from '$lib/api';
import { uploadFile, UploadError } from '$lib/upload';

export type UploadState =
	/** waiting for a slot */
	| 'queued'
	/** chunks on the way */
	| 'uploading'
	/** all bytes staged; the owning daemon is moving the file into place */
	| 'placing'
	| 'done'
	| 'failed'
	| 'cancelled'
	/** a file is already at the destination and nobody said to replace it */
	| 'conflict'
	/** the operator kept the existing file */
	| 'skipped';

export interface UploadItem {
	id: number;
	file: File;
	instance: string;
	/** Destination path relative to the instance directory */
	path: string;
	state: UploadState;
	loaded: number;
	total: number;
	/** Bytes per second over the chunks sent so far */
	rate: number;
	error: string | null;
	overwrite: boolean;
	token: string | null;
	startedAt: number | null;
	finishedAt: number | null;
}

/** Files in flight at once. */
const CONCURRENCY = 3;

/** Attempts at one chunk before the file is called failed. */
const CHUNK_ATTEMPTS = 6;

/** The states a queue entry is still going to change out of. */
const LIVE: ReadonlySet<UploadState> = new Set(['queued', 'uploading', 'placing']);

export class UploadQueue {
	items = $state<UploadItem[]>([]);

	/** Fired once a file is in place, with the directory it landed in */
	onplaced?: (item: UploadItem) => void;

	private nextId = 1;
	private aborters = new Map<number, AbortController>();
	private running = 0;

	/** Queue files for one instance, each at `dir/<relPath>`. */
	add(instance: string, dir: string, picked: Array<{ file: File; relPath: string }>): UploadItem[] {
		const added: UploadItem[] = picked.map(({ file, relPath }) => ({
			id: this.nextId++,
			file,
			instance,
			path: [dir, relPath].filter((part) => part !== '').join('/').replace(/\/+/g, '/'),
			state: 'queued',
			loaded: 0,
			total: file.size,
			rate: 0,
			error: null,
			overwrite: false,
			token: null,
			startedAt: null,
			finishedAt: null
		}));

		this.items = [...this.items, ...added];
		this.pump();

		return added;
	}

	/** Whether anything is still moving. */
	get active(): boolean {
		return this.items.some((item) => LIVE.has(item.state));
	}

	/** Entries waiting on a replace-or-skip answer. */
	get conflicts(): UploadItem[] {
		return this.items.filter((item) => item.state === 'conflict');
	}

	/** Totals for the panel's header line. */
	get summary(): { live: number; done: number; failed: number; loaded: number; total: number; rate: number } {
		let live = 0;
		let done = 0;
		let failed = 0;
		let loaded = 0;
		let total = 0;
		let rate = 0;

		for (const item of this.items) {
			if (LIVE.has(item.state)) {
				live += 1;
				loaded += item.loaded;
				total += item.total;
				rate += item.rate;
			} else if (item.state === 'done') {
				done += 1;
			} else if (item.state === 'failed') {
				failed += 1;
			}
		}

		return { live, done, failed, loaded, total, rate };
	}

	/** Answer a conflict: send the file over the existing one, or keep what is there. */
	resolveConflict(item: UploadItem, choice: 'replace' | 'skip'): void {
		if (item.state !== 'conflict') {
			return;
		}

		if (choice === 'skip') {
			this.update(item.id, { state: 'skipped', finishedAt: Date.now() });

			return;
		}

		this.update(item.id, { state: 'queued', overwrite: true, error: null });
		this.pump();
	}

	/** Replace every file waiting on a conflict. */
	replaceAll(): void {
		for (const item of this.conflicts) {
			this.resolveConflict(item, 'replace');
		}
	}

	/** Stop one entry; a staged partial is thrown away. */
	cancel(item: UploadItem): void {
		if (!LIVE.has(item.state) && item.state !== 'conflict') {
			return;
		}

		this.aborters.get(item.id)?.abort();
		this.update(item.id, { state: 'cancelled', finishedAt: Date.now() });

		if (item.token) {
			void post(`/instances/${encodeURIComponent(item.instance)}/files/upload`, { action: 'cancel', token: item.token }).catch(() => undefined);
		}
	}

	/** Stop everything that is still going or waiting. */
	cancelAll(): void {
		for (const item of this.items) {
			this.cancel(item);
		}
	}

	/** Send a failed or cancelled file again, from the start. */
	retry(item: UploadItem): void {
		if (item.state !== 'failed' && item.state !== 'cancelled') {
			return;
		}

		this.update(item.id, { state: 'queued', loaded: 0, rate: 0, error: null, token: null, startedAt: null, finishedAt: null });
		this.pump();
	}

	/** Drop the entries nothing more will happen to. */
	clearFinished(): void {
		this.items = this.items.filter((item) => LIVE.has(item.state) || item.state === 'conflict');
	}

	private update(id: number, patch: Partial<UploadItem>): void {
		this.items = this.items.map((item) => (item.id === id ? { ...item, ...patch } : item));
	}

	private current(id: number): UploadItem | undefined {
		return this.items.find((item) => item.id === id);
	}

	/** Start queued entries while there are free slots. */
	private pump(): void {
		while (this.running < CONCURRENCY) {
			const next = this.items.find((item) => item.state === 'queued');

			if (!next) {
				return;
			}

			this.running += 1;
			this.update(next.id, { state: 'uploading', startedAt: Date.now() });

			void this.run(next.id).finally(() => {
				this.running -= 1;
				this.pump();
			});
		}
	}

	private async run(id: number): Promise<void> {
		const item = this.current(id);

		if (!item) {
			return;
		}

		const aborter = new AbortController();
		const base = `/instances/${encodeURIComponent(item.instance)}/files/upload`;

		this.aborters.set(id, aborter);

		try {
			const begun = await post<{ token: string; exists: boolean; chunkSize: number }>(base, {
				action: 'begin',
				path: item.path,
				size: item.total
			});

			if (aborter.signal.aborted) {
				return;
			}

			if (begun.exists && !item.overwrite) {
				this.update(id, { state: 'conflict', token: null });

				return;
			}

			this.update(id, { token: begun.token });

			await this.sendChunks(id, begun.token, Math.max(256 * 1024, begun.chunkSize), aborter.signal);

			if (aborter.signal.aborted) {
				return;
			}

			this.update(id, { state: 'placing', loaded: item.total });

			const placed = await post<{ entry: { path: string; size: number } }>(base, {
				action: 'finish',
				token: begun.token,
				path: item.path,
				size: item.total,
				overwrite: this.current(id)?.overwrite ?? false
			});

			this.update(id, { state: 'done', finishedAt: Date.now(), path: placed.entry.path });

			const done = this.current(id);

			if (done) {
				this.onplaced?.(done);
			}
		} catch (err) {
			if (aborter.signal.aborted || this.current(id)?.state === 'cancelled') {
				return;
			}

			this.update(id, { state: 'failed', error: (err as Error).message, finishedAt: Date.now() });
		} finally {
			this.aborters.delete(id);
		}
	}

	/** Send the file piece by piece, resuming from the daemon's own count after a failure. */
	private async sendChunks(id: number, token: string, chunkSize: number, signal: AbortSignal): Promise<void> {
		const item = this.current(id)!;
		const file = item.file;
		const total = file.size;
		const started = Date.now();
		let offset = 0;
		let attempts = 0;

		// an empty file is one empty chunk; the loop below would never run for it
		if (total === 0) {
			await this.putChunk(id, token, file.slice(0, 0), 0, 0, 0, started, signal);

			return;
		}

		while (offset < total) {
			if (signal.aborted) {
				throw new UploadError('cancelled', 0);
			}

			const end = Math.min(total, offset + chunkSize);

			try {
				const answer = await this.putChunk(id, token, file.slice(offset, end), offset, total, offset, started, signal);

				offset = answer.bytes;
				attempts = 0;
			} catch (err) {
				if (signal.aborted) {
					throw err;
				}

				// a 409 is the daemon saying where it really is; anything else gets
				// a status check and a retry, with a growing pause between attempts
				const refused = err instanceof UploadError && err.status === 409;

				attempts += 1;

				if (!refused && attempts >= CHUNK_ATTEMPTS) {
					throw err;
				}

				if (!refused && err instanceof UploadError && err.status >= 400 && err.status < 500 && err.status !== 0) {
					throw err;
				}

				if (!refused) {
					await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 500 * 2 ** attempts)));
				}

				offset = await this.staged(item.instance, token);
			}
		}
	}

	private async putChunk(
		id: number,
		token: string,
		chunk: Blob,
		offset: number,
		total: number,
		before: number,
		started: number,
		signal: AbortSignal
	): Promise<{ bytes: number; complete: boolean }> {
		const instance = this.current(id)?.instance ?? '';
		const query = new URLSearchParams({ offset: String(offset), total: String(total) });

		return await uploadFile<{ bytes: number; complete: boolean }>(
			`/instances/${encodeURIComponent(instance)}/files/upload/${token}?${query.toString()}`,
			chunk,
			{
				method: 'PUT',
				signal,
				onprogress: (progress) => {
					const loaded = before + progress.loaded;
					const seconds = (Date.now() - started) / 1000;

					this.update(id, {
						loaded,
						rate: seconds > 0.5 ? loaded / seconds : 0
					});
				}
			}
		);
	}

	/** How many bytes of `token` the daemon holds. */
	private async staged(instance: string, token: string): Promise<number> {
		const status = await api<{ bytes: number }>(`/instances/${encodeURIComponent(instance)}/files/upload?token=${token}`);

		return status.bytes;
	}
}
