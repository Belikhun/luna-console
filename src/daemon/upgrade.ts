/**
 * Daemon self-upgrade (DESIGN.md §4.7).
 *
 * Two sources, always tried in this order:
 *
 *  1. **the primary daemon**, which serves the binary it is itself running.
 *     This is what makes a development cluster quick: build on the primary,
 *     `luna daemon upgrade <follower>`, done — no tag, no release, no registry.
 *  2. **the GitHub release**, for everything the primary cannot answer — a
 *     primary upgrading itself, a follower whose primary runs from source, or
 *     a machine that has never seen a build of this project.
 *
 * Applying an upgrade is the same either way: verify the checksum, swap the
 * binary over this daemon's own path and exit so the service manager restarts
 * it. Nothing here touches instances — the daemon does not own the screens they
 * run in, and they outlive it.
 */

import { chmod, rename, stat, unlink } from "node:fs/promises";

import {
	assetName,
	compareVersions,
	fetchDigest,
	latestRelease,
	RELEASE_REPO,
	type ReleaseInfo,
} from "../core/services/github";
import { BUILD_AT, VERSION, buildPlatform, buildVersion, isCompiledBinary } from "../version";

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

/** Where a binary can come from, in the order they are consulted. */
export type UpgradeChannel = "primary" | "github";

/** One channel's answer: a build this daemon could switch to. */
export interface UpgradeOffer {
	channel: UpgradeChannel;
	/** Build identity of the offered binary, e.g. "1.0.1+9f2c0aa" */
	version: string;
	buildAt: string;
	platform: string;
	size: number;
	/** null when the source published no checksum — then the size is all we can check */
	sha256: string | null;
	/** Where the bytes are fetched from */
	url: string;
	/** Human-facing origin, e.g. "primary daemon" or "github Belikhun/luna-control" */
	origin: string;
	/** GitHub only: the release page and its notes */
	pageUrl?: string;
	notes?: string;
	/** False when the offer is the build already running (a reinstall, not an upgrade) */
	newer: boolean;
}

/** The result of asking every channel what it has. */
export interface UpgradeCheck {
	current: string;
	platform: string;
	/** What an unforced upgrade would apply — the first newer offer, if any */
	offer: UpgradeOffer | null;
	/** Every offer, primary first, including same-build ones */
	offers: UpgradeOffer[];
	/** Why a channel had nothing to give, one line each */
	notes: string[];
	checkedAt: number;
}

/** How long a GitHub answer is reused. Releases are not a per-minute event. */
const GITHUB_TTL_MS = 6 * 60 * 60 * 1000;

/** Where a follower fetches the primary's binary from — set when the link starts. */
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
	const response = await fetch(`http://${source!.address}/files/binary/meta`, {
		headers: { "x-mrds-token": source!.token },
		signal: AbortSignal.timeout(10_000),
	});

	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as { error?: string };

		throw new Error(body.error ?? `HTTP ${response.status}`);
	}

	return (await response.json()) as BinaryMeta;
}

/**
 * The primary's offer. A follower takes *any* build the primary is running,
 * same version number or not: in a development cluster the primary is the
 * authority on what the fleet runs, and two builds of 1.0.0 differ by their
 * commit. Only the platform triple is non-negotiable.
 */
async function primaryOffer(notes: string[]): Promise<UpgradeOffer | null> {
	if (!source) {
		notes.push("primary: this daemon has no primary to upgrade from");

		return null;
	}

	let meta: BinaryMeta;

	try {
		meta = await remoteMeta();
	} catch (err) {
		notes.push(`primary: ${err instanceof Error ? err.message : String(err)}`);

		return null;
	}

	if (meta.platform !== buildPlatform()) {
		notes.push(`primary: its binary is ${meta.platform}, this machine is ${buildPlatform()}`);

		return null;
	}

	return {
		channel: "primary",
		version: meta.version,
		buildAt: meta.buildAt,
		platform: meta.platform,
		size: meta.size,
		sha256: meta.sha256,
		url: `http://${source.address}/files/binary`,
		origin: `primary daemon (${source.address})`,
		newer: meta.version !== buildVersion(),
	};
}

/** Last GitHub answer, reused for the TTL so the console can show it for free. */
let githubCache: { at: number; release: ReleaseInfo | null; error?: string } | undefined;

async function githubRelease(refresh: boolean): Promise<{ release: ReleaseInfo | null; error?: string }> {
	const fresh = githubCache && Date.now() - githubCache.at < GITHUB_TTL_MS;

	if (githubCache && fresh && !refresh) {
		return githubCache;
	}

	try {
		const release = await latestRelease(buildPlatform(), {
			prerelease: process.env.MRDS_RELEASE_PRERELEASE === "1",
			signal: AbortSignal.timeout(15_000),
		});

		githubCache = { at: Date.now(), release };
	} catch (err) {
		githubCache = {
			at: Date.now(),
			release: null,
			error: err instanceof Error ? err.message : String(err),
		};
	}

	return githubCache;
}

/**
 * The GitHub offer. Unlike the primary channel this one refuses to go
 * backwards: a published release is compared by semver against the version
 * this binary was built from, so an old tag is never an "upgrade".
 */
async function githubOffer(notes: string[], refresh: boolean): Promise<UpgradeOffer | null> {
	const { release, error } = await githubRelease(refresh);

	if (error) {
		notes.push(`github: ${error}`);

		return null;
	}

	if (!release || !release.asset) {
		notes.push(`github: no release with a ${assetName(buildPlatform())} asset in ${RELEASE_REPO}`);

		return null;
	}

	let sha256: string | null = null;

	if (release.digest) {
		try {
			sha256 = await fetchDigest(release.digest, AbortSignal.timeout(15_000));
		} catch (err) {
			notes.push(`github: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	return {
		channel: "github",
		version: release.version,
		buildAt: release.publishedAt,
		platform: buildPlatform(),
		size: release.asset.size,
		sha256,
		url: release.asset.url,
		origin: `github ${RELEASE_REPO} ${release.tag}`,
		pageUrl: release.pageUrl,
		notes: release.notes.slice(0, 2000),
		newer: compareVersions(release.version, VERSION) > 0,
	};
}

/**
 * Ask both channels what they have, primary first. Never throws: a channel
 * that cannot answer contributes a line to `notes`, which is what the CLI and
 * the console show when there is nothing to upgrade to.
 */
export async function checkUpgrade(refresh = false): Promise<UpgradeCheck> {
	const notes: string[] = [];
	const offers: UpgradeOffer[] = [];

	const fromPrimary = await primaryOffer(notes);

	if (fromPrimary) {
		offers.push(fromPrimary);
	}

	// the primary is preferred, but GitHub is still checked: an operator looking
	// at the console wants to know a release exists even while the local build
	// is what would be applied
	const fromGithub = await githubOffer(notes, refresh);

	if (fromGithub) {
		offers.push(fromGithub);
	}

	lastCheck = {
		current: buildVersion(),
		platform: buildPlatform(),
		offer: offers.find((entry) => entry.newer) ?? null,
		offers,
		notes,
		checkedAt: Date.now(),
	};

	return lastCheck;
}

/** The last full check, so a console asking again gets an instant answer. */
let lastCheck: UpgradeCheck | undefined;

/** What this daemon last found, without touching the network. */
export function knownUpgrade(): UpgradeCheck | undefined {
	return lastCheck;
}

let watchTimer: ReturnType<typeof setTimeout> | undefined;

/** Give the daemon time to finish starting before it talks to the internet. */
const WATCH_DELAY_MS = 60_000;

/**
 * Keep the upgrade answer warm in the background, on the same cadence the
 * GitHub cache expires at. Nothing is ever applied here — a daemon upgrades
 * because somebody asked it to, never because a release appeared.
 */
export function ensureUpgradeWatcher(): void {
	if (watchTimer) {
		return;
	}

	const tick = async (): Promise<void> => {
		try {
			await checkUpgrade(true);
		} catch {
			// checkUpgrade folds its failures into notes; this catch is for the
			// unexpected kind, which must not take the timer down with it
		}

		watchTimer = setTimeout(() => void tick(), GITHUB_TTL_MS);
	};

	watchTimer = setTimeout(() => void tick(), WATCH_DELAY_MS);
}

/** Stop the background check (shutdown). */
export function stopUpgradeWatcher(): void {
	if (watchTimer) {
		clearTimeout(watchTimer);
		watchTimer = undefined;
	}
}

/** Fetch the offered binary and check it against what the source promised. */
async function download(offer: UpgradeOffer): Promise<ArrayBuffer> {
	const headers: Record<string, string> = {};

	if (offer.channel === "primary") {
		headers["x-mrds-token"] = source!.token;
	} else if (process.env.MRDS_GITHUB_TOKEN) {
		headers.authorization = `Bearer ${process.env.MRDS_GITHUB_TOKEN}`;
	}

	const response = await fetch(offer.url, { headers });

	if (!response.ok) {
		throw new Error(`${offer.origin} refused the binary: HTTP ${response.status}`);
	}

	const bytes = await response.arrayBuffer();

	if (offer.sha256) {
		const hasher = new Bun.CryptoHasher("sha256");

		hasher.update(bytes);

		const digest = hasher.digest("hex");

		if (digest !== offer.sha256) {
			throw new Error(
				`checksum mismatch — got ${digest.slice(0, 12)}, expected ${offer.sha256.slice(0, 12)}`,
			);
		}
	} else if (offer.size > 0 && bytes.byteLength !== offer.size) {
		// no published checksum: the size is the only promise the source made
		throw new Error(`size mismatch — got ${bytes.byteLength} bytes, expected ${offer.size}`);
	}

	return bytes;
}

export interface UpgradeResult {
	from: string;
	to: string;
	channel: UpgradeChannel;
	origin: string;
	/** the daemon exits right after answering, so the service manager restarts it */
	restarting: boolean;
}

/**
 * Replace this daemon's binary with the best offer and exit.
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

	const check = await checkUpgrade(true);

	// forcing takes whatever the preferred channel has, which is how a
	// reinstall of the identical build is requested
	const offer = check.offer ?? (force ? (check.offers[0] ?? null) : null);

	if (!offer) {
		const why = check.notes.length ? ` (${check.notes.join("; ")})` : "";

		throw new Error(
			check.offers.length
				? `already running ${check.current} — nothing newer on any channel${why}`
				: `no upgrade source could be reached${why}`,
		);
	}

	const path = process.execPath;
	const staging = `${path}.new`;
	const current = buildVersion();

	log(
		`upgrade: fetching ${offer.version} from the ${offer.origin} ` +
			`(${(offer.size / 1024 / 1024).toFixed(1)} MB)`,
	);

	const bytes = await download(offer);

	try {
		await Bun.write(staging, bytes);
		await chmod(staging, 0o755);
		await rename(staging, path);
	} catch (err) {
		// a failed swap must not leave a stray half-binary next to the real one
		await unlink(staging).catch(() => {});

		throw err;
	}

	log(`upgrade: ${current} → ${offer.version}; exiting so the service manager restarts`);

	// answer the caller first — the frame is already queued on the socket, and
	// exiting inside the handler would drop it
	setTimeout(() => process.exit(0), 500);

	return {
		from: current,
		to: offer.version,
		channel: offer.channel,
		origin: offer.origin,
		restarting: true,
	};
}
