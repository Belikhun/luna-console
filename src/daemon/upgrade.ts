/**
 * Daemon self-upgrade (DESIGN.md §4.7).
 *
 * The primary serves the binary it is itself running; a follower fetches it,
 * verifies it, swaps it over its own path and exits so the service manager
 * starts the new build. Nothing here touches instances: the daemon does not own
 * the screens they run in, and they outlive it.
 */

import { chmod, rename, stat, unlink } from "node:fs/promises";

import { BUILD_AT, buildPlatform, buildVersion, isCompiledBinary } from "../version";

import { runningJobs } from "./jobs";
import { log } from "./index";

/** What `/files/binary/meta` answers with. */
export interface BinaryMeta {
	version: string;
	buildAt: string;
	sha256: string;
	size: number;
	platform: string;
}

export interface UpgradeResult {
	from: string;
	to: string;
	/** the daemon exits right after answering, so the service manager restarts it */
	restarting: boolean;
}

/** Where a follower fetches the new binary from — set when the link starts. */
let source: { address: string; token: string } | undefined;

/** Record the primary this daemon upgrades from (called by the follower link). */
export function setUpgradeSource(address: string, token: string): void {
	source = { address, token };
}

/** Hashing 90 MB on every request would be silly; the binary only changes on deploy. */
let cached: { meta: BinaryMeta; mtimeMs: number } | undefined;

/**
 * Describe the binary this daemon is running. Throws when the daemon is a
 * from-source run, where `process.execPath` is the bun interpreter rather than
 * an mrds build — serving *that* as an upgrade would replace the toolchain.
 */
export async function localBinaryMeta(): Promise<BinaryMeta> {
	if (!isCompiledBinary()) {
		throw new Error(
			"this daemon runs from source, so it has no binary to serve — build one with `bun run build`",
		);
	}

	const path = process.execPath;
	const info = await stat(path);

	if (cached && cached.mtimeMs === info.mtimeMs) {
		return cached.meta;
	}

	const hasher = new Bun.CryptoHasher("sha256");

	hasher.update(await Bun.file(path).arrayBuffer());

	const meta: BinaryMeta = {
		version: buildVersion(),
		buildAt: BUILD_AT,
		sha256: hasher.digest("hex"),
		size: info.size,
		platform: buildPlatform(),
	};

	cached = { meta, mtimeMs: info.mtimeMs };

	return meta;
}

/** The running binary as a streamable file (callers add the headers). */
export function localBinaryPath(): string {
	return process.execPath;
}

/** Ask the primary what it is running. */
async function remoteMeta(): Promise<BinaryMeta> {
	if (!source) {
		throw new Error("no primary to upgrade from — this daemon is not a follower");
	}

	const response = await fetch(`http://${source.address}/files/binary/meta`, {
		headers: { "x-mrds-token": source.token },
	});

	if (!response.ok) {
		throw new Error(`primary refused the binary meta: HTTP ${response.status}`);
	}

	return (await response.json()) as BinaryMeta & { ok?: boolean };
}

/**
 * Replace this daemon's binary with the primary's and exit.
 *
 * The rename is what makes it safe: on Linux it is atomic and the running
 * process keeps the inode it started from, so the swap cannot leave a
 * half-written executable behind for the service manager to start.
 */
export async function selfUpgrade(force = false): Promise<UpgradeResult> {
	if (!isCompiledBinary()) {
		throw new Error(
			"this daemon runs from source — restart it from the new tree instead of upgrading",
		);
	}

	const jobs = runningJobs();

	if (jobs > 0 && !force) {
		throw new Error(`${jobs} job(s) still running — wait for them to settle, or force the upgrade`);
	}

	const meta = await remoteMeta();
	const current = buildVersion();

	if (meta.platform !== buildPlatform()) {
		throw new Error(
			`the primary's binary is ${meta.platform}, this machine is ${buildPlatform()}`,
		);
	}

	if (meta.version === current && !force) {
		throw new Error(`already running ${current}`);
	}

	const path = process.execPath;
	const staging = `${path}.new`;

	log(`upgrade: fetching ${meta.version} from the primary (${(meta.size / 1024 / 1024).toFixed(1)} MB)`);

	const response = await fetch(`http://${source!.address}/files/binary`, {
		headers: { "x-mrds-token": source!.token },
	});

	if (!response.ok) {
		throw new Error(`primary refused the binary: HTTP ${response.status}`);
	}

	const bytes = await response.arrayBuffer();
	const hasher = new Bun.CryptoHasher("sha256");

	hasher.update(bytes);

	const digest = hasher.digest("hex");

	if (digest !== meta.sha256) {
		throw new Error(`checksum mismatch — got ${digest.slice(0, 12)}, expected ${meta.sha256.slice(0, 12)}`);
	}

	try {
		await Bun.write(staging, bytes);
		await chmod(staging, 0o755);
		await rename(staging, path);
	} catch (err) {
		// a failed swap must not leave a stray half-binary next to the real one
		await unlink(staging).catch(() => {});

		throw err;
	}

	log(`upgrade: ${current} → ${meta.version}; exiting so the service manager restarts`);

	// answer the caller first — the frame is already queued on the socket, and
	// exiting inside the handler would drop it
	setTimeout(() => process.exit(0), 500);

	return { from: current, to: meta.version, restarting: true };
}
