// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Daemon self-upgrade (DESIGN.md §4.7).
 *
 * Two sources, always tried in this order:
 *
 *  1. **the primary daemon**, which serves the binary it is itself running.
 *     This is what makes a development cluster quick: build on the primary,
 *     `luna daemon upgrade <follower>`, done; no tag, no release, no registry.
 *  2. **the GitHub release**, for everything the primary cannot answer; a
 *     primary upgrading itself, a follower whose primary runs from source, or
 *     a machine that has never seen a build of this project.
 *
 * Applying an upgrade is the same either way: verify the checksum, swap the
 * binary over this daemon's own path and exit so the service manager restarts
 * it. Nothing here touches instances; the daemon does not own the screens they
 * run in, and they outlive it.
 */

import { access, chmod, constants, rename, stat, unlink } from "node:fs/promises";
import { t } from "../shared/i18n";
import { dirname } from "node:path";

import {
	assetName,
	compareVersions,
	fetchDigest,
	latestRelease,
	RELEASE_REPO,
	type ReleaseInfo,
} from "../core/services/github";
import { ProgressReporter } from "../core/progress";
import { UPGRADE_JOB_KIND } from "../shared/jobs";
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
	/** null when the source published no checksum; then the size is all we can check */
	sha256: string | null;
	/** Where the bytes are fetched from */
	url: string;
	/** Human-facing origin, e.g. "primary daemon" or "github Belikhun/luna-console" */
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
	/** What an unforced upgrade would apply; the first newer offer, if any */
	offer: UpgradeOffer | null;
	/** Every offer, primary first, including same-build ones */
	offers: UpgradeOffer[];
	/** Why a channel had nothing to give, one line each */
	notes: string[];
	checkedAt: number;
}

/** How long a GitHub answer is reused. Releases are not a per-minute event. */
const GITHUB_TTL_MS = 6 * 60 * 60 * 1000;

/** Where a follower fetches the primary's binary from; set when the link starts. */
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
 * an luna build; serving *that* as an upgrade would replace the toolchain.
 */
export async function localBinaryMeta(): Promise<BinaryMeta> {
	if (!isCompiledBinary()) {
		throw new Error(t("daemon.upgrade.sourceNoBinary"));
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
		headers: { "x-luna-token": source!.token },
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
		notes.push(t("daemon.upgrade.noPrimarySource"));

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
		notes.push(t("daemon.upgrade.platformMismatch", { theirs: meta.platform, ours: buildPlatform() }));

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
			prerelease: process.env.LUNA_RELEASE_PRERELEASE === "1",
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
		notes.push(t("daemon.upgrade.noAsset", { asset: assetName(buildPlatform()), repo: RELEASE_REPO }));

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
 * How soon an automatic upgrade that declined to run is tried again. The common
 * reason is a job in flight, which is minutes away from finishing, not hours.
 */
const AUTO_RETRY_MS = 15 * 60 * 1000;

/**
 * Apply an upgrade nobody asked for.
 *
 * **Never forced.** Forcing takes whatever the preferred channel is serving even
 * when it is the build already running, which as an automatic action is a loop:
 * install the same binary, exit, restart, find it again. Unforced means an
 * automatic upgrade can only ever move this daemon onto a different build, and a
 * machine with nothing newer available simply stays where it is and says so.
 *
 * @return true when the swap landed and the process is on its way out
 */
async function applyAutomatic(offer: UpgradeOffer): Promise<boolean> {
	log(t("daemon.upgrade.autoApplying", { version: offer.version, origin: offer.origin }));

	try {
		await selfUpgrade(false);

		return true;
	} catch (err) {
		log(t("daemon.upgrade.autoFailed", { error: err instanceof Error ? err.message : String(err) }));

		return false;
	}
}

/**
 * Keep the upgrade answer warm in the background, on the same cadence the GitHub
 * cache expires at.
 *
 * With `autoApply` the same tick also installs what it finds; without it, this
 * only answers "what could this daemon upgrade to", and applying stays a
 * decision somebody makes. Which of the two a daemon gets is the
 * `autoUpgrade` policy in its config, resolved by the caller.
 */
export function ensureUpgradeWatcher(autoApply = false): void {
	if (watchTimer) {
		return;
	}

	const tick = async (): Promise<void> => {
		let nextMs = GITHUB_TTL_MS;

		try {
			const check = await checkUpgrade(true);

			// `check.offer` is the unforced answer: present only when a channel has
			// a build this daemon is not already running
			if (autoApply && check.offer && !(await applyAutomatic(check.offer))) {
				nextMs = AUTO_RETRY_MS;
			}
		} catch {
			// checkUpgrade folds its failures into notes; this catch is for the
			// unexpected kind, which must not take the timer down with it
		}

		watchTimer = setTimeout(() => void tick(), nextMs);
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

/** Megabytes, as every size in an upgrade line is written. */
function mb(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Read the body as it arrives, reporting bytes against the size the source
 * promised. A 90 MB fetch is the whole wait, so it is the one step that has to
 * move while it runs rather than jumping from 0 to done.
 */
async function readWithProgress(
	response: Response,
	total: number,
	reporter: ProgressReporter,
): Promise<Uint8Array> {
	const body = response.body;

	if (!body) {
		return new Uint8Array(await response.arrayBuffer());
	}

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;

	while (true) {
		const { done, value } = await reader.read();

		if (done) {
			break;
		}

		chunks.push(value);
		received += value.byteLength;

		// a source that promised nothing measurable leaves the step indeterminate
		// rather than inventing a denominator
		if (total > 0) {
			reporter.info(
				Math.min(1, received / total),
				t("daemon.upgrade.received", { got: mb(received), total: mb(total) }),
			);
		}
	}

	const out = new Uint8Array(received);
	let offset = 0;

	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return out;
}

/** Fetch the offered binary and check it against what the source promised. */
async function download(offer: UpgradeOffer, reporter: ProgressReporter): Promise<Uint8Array> {
	const headers: Record<string, string> = {};

	if (offer.channel === "primary") {
		headers["x-luna-token"] = source!.token;
	} else if (process.env.LUNA_GITHUB_TOKEN) {
		headers.authorization = `Bearer ${process.env.LUNA_GITHUB_TOKEN}`;
	}

	const response = await fetch(offer.url, { headers });

	if (!response.ok) {
		throw new Error(t("daemon.upgrade.refused", { origin: offer.origin, status: response.status }));
	}

	const bytes = await readWithProgress(response, offer.size, reporter);

	if (offer.sha256) {
		const hasher = new Bun.CryptoHasher("sha256");

		hasher.update(bytes);

		const digest = hasher.digest("hex");

		if (digest !== offer.sha256) {
			throw new Error(
				t("daemon.upgrade.checksumMismatch", {
					got: digest.slice(0, 12),
					expected: offer.sha256.slice(0, 12),
				}),
			);
		}
	} else if (offer.size > 0 && bytes.byteLength !== offer.size) {
		// no published checksum: the size is the only promise the source made
		throw new Error(t("daemon.upgrade.sizeMismatch", { got: bytes.byteLength, expected: offer.size }));
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

/** An upgrade already running, so two callers cannot race two swaps of one file. */
let applying: Promise<UpgradeResult> | undefined;

/**
 * Replace this daemon's binary with the best offer and exit.
 *
 * The rename is what makes it safe: on Linux it is atomic and the running
 * process keeps the inode it started from, so the swap cannot leave a
 * half-written executable behind for the service manager to start.
 *
 * A second caller arriving mid-upgrade joins the first rather than starting its
 * own: there are now three things that can ask for one (an operator, this
 * daemon's own watcher, and a primary rescuing a quarantined follower), they all
 * write the same staging path, and two of those overlapping would rename a
 * half-written file over the binary the service manager is about to start. The
 * joiner sees no progress frames, which is the right trade against that.
 */
export async function selfUpgrade(force = false, reporter?: ProgressReporter): Promise<UpgradeResult> {
	if (applying) {
		return await applying;
	}

	applying = runUpgrade(force, reporter);

	try {
		return await applying;
	} finally {
		applying = undefined;
	}
}

/**
 * The upgrade itself.
 *
 * The four steps are weighted by how long they really take: the download is the
 * whole wait, and it reports per chunk, so the caller's bar moves while the
 * bytes land rather than sitting still for a minute.
 */
async function runUpgrade(force: boolean, reporter?: ProgressReporter): Promise<UpgradeResult> {
	const progress = reporter ?? new ProgressReporter("self-upgrade");

	const preflight = progress.child(t("daemon.upgrade.steps.preflight"), 1);
	const resolving = progress.child(t("daemon.upgrade.steps.resolving"), 2);
	const fetching = progress.child(t("daemon.upgrade.steps.download"), 12);
	const installing = progress.child(t("daemon.upgrade.steps.install"), 2);

	await preflight.task(
		{
			start: t("daemon.upgrade.steps.checking"),
			done: t("daemon.upgrade.steps.checked"),
		},
		async () => {
			if (!isCompiledBinary()) {
				throw new Error(t("daemon.upgrade.sourceNoUpgrade"));
			}

			// the upgrade is a job itself now, so it must not count itself as work
			// to wait for
			const jobs = runningJobs([UPGRADE_JOB_KIND]);

			if (jobs > 0 && !force) {
				throw new Error(t("daemon.upgrade.jobsRunning", { count: jobs }));
			}

			// Checked before spending a 90 MB download on a swap that cannot land. The
			// staged file is written *beside* the binary and renamed over it, so what has
			// to be writable is the directory; a daemon whose binary sits in
			// /usr/local/bin cannot upgrade itself however the file itself is owned.
			const binDir = dirname(process.execPath);

			try {
				await access(binDir, constants.W_OK);
			} catch {
				throw new Error(
					t("daemon.upgrade.dirNotWritable", { path: process.execPath, dir: binDir }),
				);
			}
		},
	);

	resolving.info(0, t("daemon.upgrade.steps.asking"));

	const check = await checkUpgrade(true);

	// forcing takes whatever the preferred channel has, which is how a
	// reinstall of the identical build is requested
	const offer = check.offer ?? (force ? (check.offers[0] ?? null) : null);

	if (!offer) {
		const why = check.notes.length ? ` (${check.notes.join("; ")})` : "";
		const message = check.offers.length
			? t("daemon.upgrade.nothingNewer", { version: check.current, why })
			: t("daemon.upgrade.noSourceWhy", { why });

		resolving.error(resolving.progress, message);

		throw new Error(message);
	}

	resolving.complete(
		t("daemon.upgrade.steps.resolved", { version: offer.version, origin: offer.origin }),
	);

	const path = process.execPath;
	const staging = `${path}.new`;
	const current = buildVersion();

	log(
		`upgrade: fetching ${offer.version} from the ${offer.origin} ` +
			`(${(offer.size / 1024 / 1024).toFixed(1)} MB)`,
	);

	fetching.info(0, t("daemon.upgrade.steps.fetching", { origin: offer.origin, size: mb(offer.size) }));

	let bytes: Uint8Array;

	try {
		bytes = await download(offer, fetching);
	} catch (err) {
		fetching.error(fetching.progress, err instanceof Error ? err.message : String(err));

		throw err;
	}

	fetching.complete(t("daemon.upgrade.steps.verified", { size: mb(bytes.byteLength) }));

	await installing.task({ start: t("daemon.upgrade.steps.swapping") }, async () => {
		try {
			await Bun.write(staging, bytes);
			await chmod(staging, 0o755);
			await rename(staging, path);
		} catch (err) {
			// a failed swap must not leave a stray half-binary next to the real one
			await unlink(staging).catch(() => {});

			throw err;
		}
	});

	log(`upgrade: ${current} → ${offer.version}; exiting so the service manager restarts`);

	installing.complete(t("daemon.upgrade.steps.restarting", { from: current, to: offer.version }));
	progress.complete(t("daemon.upgrade.steps.restarting", { from: current, to: offer.version }));

	// answer the caller first; the frame is already queued on the socket, and
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
