// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Files an operator attaches in Mèo Béo's panel, held until the agent acts on
 * them.
 *
 * An MCP request body is capped far below a plugin jar, so the bytes never
 * travel through a tool call: the panel posts the file here, the message
 * carries only an `<attachment id=...>` tag, and a tool (`addon_install_upload`)
 * reads the file back by id. Staged files live in the console host's temp
 * directory, not the cluster root (they are not cluster state, and the daemon
 * receives the bytes only when something installs them), and expire after an
 * hour.
 */

import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** The panel accepts at least this much, whatever the attachment copy limit says: jars and modpacks never need the copy. */
export const MIN_UPLOAD_BYTES = 128 * 1024 * 1024;

/** The body ran past the cap it was given; nothing was kept. */
export class UploadTooLarge extends Error {}

/** How long an attachment waits to be used. */
const TTL_MS = 60 * 60 * 1000;

const DIR = join(tmpdir(), 'luna-agent-uploads');

export interface StagedUpload {
	id: string;
	name: string;
	size: number;
	owner: string;
	at: number;
}

const staged = new Map<string, StagedUpload>();

function pathOf(id: string): string {
	return join(DIR, `${id}.bin`);
}

async function sweep(): Promise<void> {
	const now = Date.now();

	for (const [id, upload] of staged) {
		if (now - upload.at > TTL_MS) {
			staged.delete(id);
			await rm(pathOf(id), { force: true });
		}
	}
}

/**
 * Keep an attached file, written to disk as it arrives so a gigabyte upload
 * never sits in the console's memory. Throws `UploadTooLarge` once the body
 * passes `maxBytes`; returns null for an empty body.
 */
export async function stageUpload(owner: string, name: string, body: ReadableStream<Uint8Array>, maxBytes: number): Promise<StagedUpload | null> {
	await sweep();
	await mkdir(DIR, { recursive: true });

	const id = `att_${randomBytes(8).toString('hex')}`;
	const writer = Bun.file(pathOf(id)).writer();
	let size = 0;

	try {
		for await (const chunk of body) {
			size += chunk.byteLength;

			if (size > maxBytes) {
				throw new UploadTooLarge();
			}

			writer.write(chunk);
			await writer.flush();
		}

		await writer.end();
	} catch (err) {
		await Promise.resolve(writer.end()).catch(() => {});
		await rm(pathOf(id), { force: true });

		throw err;
	}

	if (size === 0) {
		await rm(pathOf(id), { force: true });

		return null;
	}

	const upload: StagedUpload = {
		id,
		name: basename(name).slice(0, 200) || 'file',
		size,
		owner,
		at: Date.now()
	};

	staged.set(upload.id, upload);

	return upload;
}

/** An attachment's metadata and bytes, or null when the id is unknown or expired. */
export async function readUpload(id: string): Promise<{ upload: StagedUpload; bytes: Uint8Array } | null> {
	await sweep();

	const upload = staged.get(id);

	if (!upload) {
		return null;
	}

	const file = Bun.file(pathOf(id));

	if (!(await file.exists())) {
		staged.delete(id);

		return null;
	}

	return { upload, bytes: new Uint8Array(await file.arrayBuffer()) };
}

/**
 * Copy one of the owner's attachments to a path, without reading it into
 * memory; false when it is unknown, expired or someone else's.
 */
export async function copyUpload(id: string, owner: string, dest: string): Promise<boolean> {
	const upload = staged.get(id);

	if (!upload || upload.owner !== owner || !(await Bun.file(pathOf(id)).exists())) {
		return false;
	}

	await mkdir(dirname(dest), { recursive: true });
	await copyFile(pathOf(id), dest);

	return true;
}

/** Drop an attachment before it expires. */
export async function dropUpload(id: string, owner: string): Promise<boolean> {
	const upload = staged.get(id);

	if (!upload || upload.owner !== owner) {
		return false;
	}

	staged.delete(id);
	await rm(pathOf(id), { force: true });

	return true;
}
