// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Instance log reads; the tail of latest.log plus the monthly archives. This
 * lives in core (and runs as a routed op) because the files are only on the
 * machine that owns the instance: a follower's logs are unreadable from the
 * primary's disk, and pretending otherwise just returns silence.
 */

import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { centralLogsDir, instanceDir, managedInstances } from "./config";
import type { ClusterConfig } from "./types";
import { t } from "../shared/i18n";

/** How many lines a read returns when the caller does not say. */
export const DEFAULT_LOG_LINES = 200;

/** Upper bound on one read; the console is a viewer, not an exporter. */
export const MAX_LOG_LINES = 2_000;

export interface InstanceLogs {
	/** the last N lines of latest.log, empty when the file does not exist */
	content: string;
	/** archived monthly logs, newest month first */
	archives: Array<{ file: string; sizeBytes: number }>;
}

/**
 * Read the tail of an instance's live log and list its archives. Runs on the
 * daemon that owns the instance.
 */
export async function readInstanceLogs(
	cfg: ClusterConfig,
	name: string,
	lines = DEFAULT_LOG_LINES,
): Promise<InstanceLogs> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name }));
	}

	const wanted = Math.min(Math.max(1, lines), MAX_LOG_LINES);
	const path = join(instanceDir(inst), "logs", "latest.log");
	let content = "";

	if (existsSync(path)) {
		const text = await Bun.file(path).text();

		content = text.split("\n").slice(-wanted).join("\n");
	}

	const archiveDir = join(centralLogsDir(), name);
	const archives: InstanceLogs["archives"] = [];

	if (existsSync(archiveDir)) {
		for (const file of (await readdir(archiveDir)).sort().reverse()) {
			const info = await stat(join(archiveDir, file));

			archives.push({ file, sizeBytes: info.size });
		}
	}

	return { content, archives };
}
