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
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

/** Largest file the panel accepts. */
export const MAX_UPLOAD_BYTES = 128 * 1024 * 1024;

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

/** Keep an attached file; returns the handle the message refers to it by. */
export async function stageUpload(owner: string, name: string, bytes: Uint8Array): Promise<StagedUpload> {
	await sweep();
	await mkdir(DIR, { recursive: true });

	const upload: StagedUpload = {
		id: `att_${randomBytes(8).toString('hex')}`,
		name: basename(name).slice(0, 200) || 'file',
		size: bytes.byteLength,
		owner,
		at: Date.now()
	};

	await Bun.write(pathOf(upload.id), bytes);
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
