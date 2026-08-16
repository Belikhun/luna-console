// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The console's one file uploader, for the payloads too big to go as JSON.
 *
 * Everything small in this console uploads base64 inside a JSON body
 * (`fileToBase64` in `$lib/api`), which is the right call for a plugin jar and
 * the wrong one for a world: base64 costs a third again in bytes and has to be
 * held in memory whole, twice over.
 *
 * This sends the `File` itself as the request body, so the browser streams it
 * off disk. It uses `XMLHttpRequest` rather than `fetch` for one reason:
 * `fetch` still cannot report upload progress. A multi-gigabyte upload with no
 * progress bar is precisely the silent spinner this project forbids, and the
 * only browser API that reports it is `xhr.upload.onprogress`.
 *
 * The content type is `application/octet-stream` deliberately. SvelteKit's CSRF
 * check refuses cross-origin form-encoded, multipart and text/plain posts; a
 * raw body is none of those, so it passes without the base64 detour.
 */

/** Progress of an upload in flight. */
export interface UploadProgress {
	loaded: number;
	total: number;
	/** 0..1; `total` is always known here because the body is a File */
	fraction: number;
	/** Bytes per second over the whole transfer so far; 0 until it can be judged */
	rate: number;
}

export interface UploadOptions {
	method?: 'POST' | 'PUT';
	headers?: Record<string, string>;
	onprogress?: (progress: UploadProgress) => void;
	signal?: AbortSignal;
}

/** Thrown for any non-2xx answer, carrying the server's own message. */
export class UploadError extends Error {
	status: number;

	constructor(message: string, status: number) {
		super(message);

		this.name = 'UploadError';
		this.status = status;
	}
}

/**
 * Stream a file to a console route, reporting progress as it goes.
 *
 * @param path route path under `/api`, e.g. `/worlds/stage/<token>`
 * @param file the picked file; sent as the raw request body
 * @returns the route's parsed JSON answer
 * @throws {UploadError} on a non-2xx answer, a network failure, or an abort
 */
export function uploadFile<T = unknown>(path: string, file: File, opts: UploadOptions = {}): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		const started = Date.now();

		xhr.open(opts.method ?? 'PUT', `/api${path}`);
		xhr.setRequestHeader('content-type', 'application/octet-stream');

		for (const [name, value] of Object.entries(opts.headers ?? {})) {
			xhr.setRequestHeader(name, value);
		}

		xhr.upload.onprogress = (event) => {
			if (!opts.onprogress) {
				return;
			}

			const total = event.lengthComputable ? event.total : file.size;
			const seconds = (Date.now() - started) / 1000;

			opts.onprogress({
				loaded: event.loaded,
				total,
				fraction: total > 0 ? Math.min(1, event.loaded / total) : 0,
				// a rate before the first half-second is noise, not a measurement
				rate: seconds > 0.5 ? event.loaded / seconds : 0
			});
		};

		xhr.onload = () => {
			let body: unknown;

			try {
				body = JSON.parse(xhr.responseText);
			} catch {
				body = undefined;
			}

			if (xhr.status >= 200 && xhr.status < 300) {
				resolve(body as T);

				return;
			}

			const message = (body as { message?: string; error?: string })?.message
				?? (body as { error?: string })?.error
				?? `upload failed (${xhr.status})`;

			reject(new UploadError(message, xhr.status));
		};

		xhr.onerror = () => reject(new UploadError('the connection dropped during the upload', 0));
		xhr.ontimeout = () => reject(new UploadError('the upload timed out', 0));
		xhr.onabort = () => reject(new UploadError('the upload was cancelled', 0));

		opts.signal?.addEventListener('abort', () => xhr.abort(), { once: true });

		if (opts.signal?.aborted) {
			reject(new UploadError('the upload was cancelled', 0));

			return;
		}

		xhr.send(file);
	});
}

/** Bytes in the shape the upload readout wants: short, and never misleading. */
export function formatBytes(bytes: number): string {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = Math.max(0, bytes);
	let unit = 0;

	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}

	return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** A transfer rate, or an empty string while it is still too early to say. */
export function formatRate(bytesPerSecond: number): string {
	if (bytesPerSecond <= 0) {
		return '';
	}

	return `${formatBytes(bytesPerSecond)}/s`;
}
